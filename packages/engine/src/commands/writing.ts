// The writing commands (LLD 1 sections 7.1, 7.2, 8.4, 8.7, 9.3): startGame, saveDraft, finishWriting.
// Moderation (guard 8) is not wired until #25: `saveDraft` stores text trimmed and otherwise as given, and the Engine enforces no length,
// non-empty or profanity rule here (the contracts' wire cap is the only limit). `finishWriting` does not re-run moderation (M2), so what `saveDraft`
// stored goes straight into the pool.
import type { Command } from "@dc/contracts";
import { EngineInvariantError, reject } from "../errors";
import type { CommandSpec, Input } from "../registry";
import { mintCardId } from "../rules/cards";
import { defaultTarget, MIN_PLAYERS, totals, writeCounts } from "../rules/playability";
import { seated } from "../selectors";
import type { Card, CardId, Draft, DraftChange, Game, Handled, Player, Rejection } from "../types";

type Of<T extends Command["type"]> = Extract<Command, { type: T }>;

const effects = (): Pick<Handled, "draftChanges" | "roundRecords" | "redactEnvelope" | "aggregateChanged"> =>
  ({ draftChanges: [], roundRecords: [], redactEnvelope: false, aggregateChanged: true });
const invalid = (): Rejection => reject("INVALID_ARGUMENT");
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The actor's seat. Guard 2 (`roles.playerId !== null`) has already run, so a seat exists. */
const seatOf = (i: Input<Command>): Player => i.state.players.find((p) => p.id === i.roles.playerId) as Player;

/** Guard 4 beyond `phases`: only a player who has not finished writing may save or finish (a `ready` or `active` seat gets detail `finished`). */
const notFinished = (i: Input<Command>): Rejection | null => (i.roles.status === "writing" ? null : reject("WRONG_PHASE", "finished"));

/** Section 9.3 at the current seat count: the frozen target and the per-player write counts (or the reason there are none). */
function plan(state: Game): { n: number; target: number; counts: ReturnType<typeof writeCounts> } {
  const n = seated(state).length;
  const target = state.settings.targetOverride ?? defaultTarget(n);
  return { n, target, counts: writeCounts(n, target, totals(state), state.settings.writeCountsOverride) };
}

export const startGame: CommandSpec<Of<"startGame">> = {
  type: "startGame",
  phases: ["LOBBY"],
  actor: (i) => i.roles.host,
  // An override with no imported cards cannot apply: INVALID_ARGUMENT (guard 7), ahead of the player count.
  payload: ({ state }) => (plan(state).counts === "invalid" ? invalid() : null),
  preconditions: ({ state }) => {
    if (seated(state).length < MIN_PLAYERS) return reject("NOT_PLAYABLE", "players");
    return plan(state).counts === "unmet" ? reject("NOT_PLAYABLE", "minimums") : null;
  },
  handle: ({ state }) => {
    const { target, counts } = plan(state);
    if (typeof counts === "string") throw new EngineInvariantError("startGame: preconditions passed but the plan is unresolved"); // unreachable: guards 7 and 9
    const none = counts.red === 0 && counts.green === 0;
    const players = state.players.map((p): Player =>
      p.status === "writing" || p.status === "ready" || p.status === "active"
        ? { ...p, writeTarget: { ...counts }, status: none ? "ready" : p.status }
        : p);
    return { ...effects(), state: { ...state, phase: "WRITING", target, writeCounts: { ...counts }, players }, events: [{ t: "WritingStarted", target, writeCounts: { ...counts } }] };
  },
};

export const saveDraft: CommandSpec<Of<"saveDraft">> = {
  type: "saveDraft",
  phases: ["WRITING", "PLAYING"], // PLAYING for a late joiner
  actor: (i) => i.roles.playerId !== null,
  phase: notFinished,
  payload: (i) => {
    const { red, green } = i.cmd as { red: unknown; green: unknown };
    if (!isStrings(red) || !isStrings(green)) return invalid();
    const cap = seatOf(i).writeTarget ?? { red: 0, green: 0 };
    return red.length > cap.red || green.length > cap.green ? invalid() : null;
  },
  handle: (i) => {
    const me = seatOf(i);
    const draft: Draft = { red: i.cmd.red.map((t) => t.trim()), green: i.cmd.green.map((t) => t.trim()) };
    const draftChanges: DraftChange[] = [{ playerId: me.id, draft }];
    // Counts, not text, are what the aggregate mirrors; compared to `writeProgress`, not to the stored draft document.
    if (draft.red.length === me.writeProgress.red && draft.green.length === me.writeProgress.green) {
      return { ...effects(), state: i.state, events: [], draftChanges, aggregateChanged: false };
    }
    const progress = { red: draft.red.length, green: draft.green.length };
    const players = i.state.players.map((p) => (p.id === me.id ? { ...p, writeProgress: progress } : p));
    return { ...effects(), state: { ...i.state, players }, events: [], draftChanges };
  },
};

/** The actor's stored draft, or null when it is missing or malformed (which counts as empty). */
function storedDraft(i: Input<Command>, id: string): Draft | null {
  const raw: unknown = Object.hasOwn(i.ctx.drafts, id) ? i.ctx.drafts[id] : undefined;
  if (typeof raw !== "object" || raw === null) return null;
  const { red, green } = raw as { red?: unknown; green?: unknown };
  return isStrings(red) && isStrings(green) ? { red, green } : null;
}

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const finishWriting: CommandSpec<Of<"finishWriting">> = {
  type: "finishWriting",
  phases: ["WRITING", "PLAYING"], // PLAYING for a late joiner
  actor: (i) => i.roles.playerId !== null,
  phase: notFinished,
  // Trusts the draft document the Store supplied, not `writeProgress`: exactly the target counts, else `incomplete`.
  preconditions: (i) => {
    const me = seatOf(i);
    const d = storedDraft(i, me.id);
    return d !== null && me.writeTarget !== null && d.red.length === me.writeTarget.red && d.green.length === me.writeTarget.green ? null : reject("NOT_PLAYABLE", "incomplete");
  },
  handle: (i) => {
    const me = seatOf(i);
    const d = storedDraft(i, me.id) as Draft;
    // Mint red then green in draft order, registering each id before the next so a batch cannot collide with itself.
    const minted: Record<CardId, Card> = { ...i.state.cards };
    const redIds: CardId[] = [];
    const greenIds: CardId[] = [];
    for (const text of d.red) { const id = mintCardId(i.ctx, minted); minted[id] = { kind: "red", text }; redIds.push(id); }
    for (const text of d.green) { const id = mintCardId(i.ctx, minted); minted[id] = { kind: "green", text }; greenIds.push(id); }
    // Canonical key order: insertion order would group one author's batch (E8).
    const cards: Record<CardId, Card> = Object.fromEntries(Object.keys(minted).sort(byKey).map((k) => [k, minted[k] as Card]));
    const redDeck = i.ctx.rng.shuffle([...i.state.pools.redDeck, ...redIds]);
    const greenDeck = i.ctx.rng.shuffle([...i.state.pools.greenDeck, ...greenIds]);
    const players = i.state.players.map((p): Player => (p.id === me.id ? { ...p, status: "ready", writeProgress: { ...(me.writeTarget as Player["writeProgress"]) } } : p));
    return {
      ...effects(),
      state: { ...i.state, cards, pools: { ...i.state.pools, redDeck, greenDeck }, players },
      events: [{ t: "PlayerFinishedWriting", playerId: me.id }],
      draftChanges: [{ playerId: me.id, draft: null }],
      redactEnvelope: true,
    };
  },
};
