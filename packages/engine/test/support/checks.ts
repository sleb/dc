import { assertDeepEqual } from "./assert";
import { meetsMinimums, totals } from "../../src/rules/playability";
import type { Accepted, Actor, Draft, DomainEvent, Game, GameDrafts, Player, Rejection, Result } from "../../src/types";

/** One `decide` call and what came out of it, as seen by the global checkers. */
export interface Step {
  index: number;
  seed?: number | string;
  before: Game | null;
  cmd: unknown;
  result: Result<Accepted, Rejection>;
  /** The actor and the draft documents the command ran with; set by `runScenario`, the oracle for the E3, E5 and E8 checkers. */
  actor?: Actor;
  drafts?: GameDrafts;
}
export type Checker = (step: Step) => void;

/** Path of the first value that is not plain JSON data (undefined, function, symbol, bigint, non-finite number, Map, Set, Date, class instance), else null. */
export function findNonJson(value: unknown, path = "$"): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : path;
  if (typeof value !== "object") return path;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const bad = findNonJson(v, `${path}[${i}]`);
      if (bad !== null) return bad;
    }
    return null;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return path;
  for (const [k, v] of Object.entries(value)) {
    const bad = findNonJson(v, `${path}.${k}`);
    if (bad !== null) return bad;
  }
  return null;
}

/** X2: the new state survives JSON and holds no `undefined` (Firestore). */
export const checkSerializable: Checker = ({ result }) => {
  if (!result.ok) return;
  const bad = findNonJson(result.value.state);
  if (bad !== null) throw new Error(`state is not plain JSON at ${bad}`);
  assertDeepEqual(JSON.parse(JSON.stringify(result.value.state)), result.value.state, "state does not survive a JSON round trip");
};

/** E3: the version moves by exactly one when the aggregate changed, else not at all. */
export const checkVersion: Checker = ({ before, result }) => {
  if (!result.ok) return;
  const was = before?.version ?? 0;
  const want = was + (result.value.aggregateChanged ? 1 : 0);
  if (result.value.state.version !== want) throw new Error(`version is ${result.value.state.version}, expected ${want} (before ${was}, aggregateChanged ${result.value.aggregateChanged})`);
};

/** E3 corollary: a command reported as not changing the aggregate leaves the state deep-equal to the input (a saveDraft-style handler must not mutate state). */
export const checkUnchangedWhenNotAggregate: Checker = ({ before, cmd, result }) => {
  if (!result.ok || result.value.aggregateChanged || before === null) return;
  assertDeepEqual(result.value.state, before, `${cmdType(cmd)} reported no aggregate change but altered the state`);
};

const cmdType = (cmd: unknown): string => {
  const t: unknown = typeof cmd === "object" && cmd !== null ? (cmd as { type?: unknown }).type : undefined;
  return typeof t === "string" ? t : "";
};
const SEATED = new Set(["writing", "ready", "active"]);
const actorPlayer = (game: Game | null, actor: Actor | undefined): Player | undefined =>
  game === null || actor?.kind !== "user" ? undefined : game.players.find((p) => p.uid === actor.uid && SEATED.has(p.status));
/** The player this command moved from `writing` to `ready` (or on to `active`, when the same command began play), found by diffing, so it does not lean on the actor. */
const finisher = (before: Game | null, after: Game): Player | undefined =>
  after.players.find((p) => (p.status === "ready" || p.status === "active") && before?.players.find((b) => b.id === p.id)?.status === "writing");

/** Every card id in every zone (hands, piles, the four pools, submissions, the open round's green card), with repeats. */
export function zoneIds(g: Game): string[] {
  return [
    ...g.players.flatMap((p) => [...p.hand, ...p.scorePile]),
    ...g.pools.redDeck, ...g.pools.redDiscard, ...g.pools.greenDeck, ...g.pools.greenDiscard,
    ...(g.round === null ? [] : [...g.round.submissions.map((s) => s.cardId), g.round.greenCardId]),
  ];
}
const countKind = (g: Game | null, kind: "red" | "green"): number => (g === null ? 0 : Object.values(g.cards).filter((c) => c.kind === kind).length);

/** E5: after every accepted command each registry card is in exactly one zone, the zone union equals keys(cards), cards are created only by finishWriting (importDeck, writeIn) and removed only by removeCard, and finishWriting adds exactly the finisher's draft. */
export const checkConservation: Checker = ({ before, cmd, result, drafts }) => {
  if (!result.ok) return;
  const after = result.value.state;
  const ids = zoneIds(after);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) throw new Error(`card ${dup} is in more than one zone`);
  const keys = Object.keys(after.cards);
  const inZone = new Set(ids);
  const missing = keys.find((k) => !inZone.has(k));
  if (missing !== undefined) throw new Error(`registry card ${missing} is in no zone`);
  const orphan = ids.find((id) => !Object.hasOwn(after.cards, id));
  if (orphan !== undefined) throw new Error(`zone card ${orphan} is not in the registry`);
  const type = cmdType(cmd);
  const was = new Set(Object.keys(before?.cards ?? {}));
  const added = keys.filter((k) => !was.has(k));
  const removed = [...was].filter((k) => !Object.hasOwn(after.cards, k));
  if (added.length > 0 && !CREATORS.has(type)) throw new Error(`${type} created cards`);
  if (removed.length > 0 && type !== "removeCard") throw new Error(`${type} removed cards`);
  if (type === "finishWriting" && before !== null) {
    const who = finisher(before, after);
    if (who === undefined) throw new Error("finishWriting accepted but nobody finished");
    // The step must carry the drafts the command ran with: without them the delta check would pass vacuously. A finisher with no stored draft finished an empty one.
    if (drafts === undefined) throw new Error("checkConservation needs the step's drafts for a finishWriting");
    const draft: Draft = drafts[who.id] ?? { red: [], green: [] };
    const dRed = countKind(after, "red") - countKind(before, "red");
    const dGreen = countKind(after, "green") - countKind(before, "green");
    if (dRed !== draft.red.length || dGreen !== draft.green.length) throw new Error(`finishWriting added ${dRed} red and ${dGreen} green for a draft of ${draft.red.length} and ${draft.green.length}`);
    // The new registry entries are the draft's cards: same colors and texts, with multiplicity.
    const kindText = (kind: string, text: string): string => JSON.stringify([kind, text.trim()]);
    const want = [...draft.red.map((t) => kindText("red", t)), ...draft.green.map((t) => kindText("green", t))].sort();
    const got = added.map((k) => kindText(after.cards[k]?.kind ?? "", after.cards[k]?.text ?? "")).sort();
    if (want.join("\n") !== got.join("\n")) throw new Error("finishWriting registered cards that are not the finisher's draft (colors and texts differ)");
  }
};

/** E6: a hand never exceeds 7, and a player who became active in this command holds exactly 7 (the initial deal). */
export const checkHands: Checker = ({ before, result }) => {
  if (!result.ok) return;
  const after = result.value.state;
  for (const p of after.players) {
    if (p.hand.length > 7) throw new Error(`player ${p.id} holds ${p.hand.length} cards`);
    const wasActive = before?.players.find((b) => b.id === p.id)?.status === "active";
    if (p.status === "active" && !wasActive && p.hand.length !== 7) throw new Error(`player ${p.id} became active holding ${p.hand.length} cards, not 7`);
  }
};

/** Accepted without bumping the version by design: deleteGame (the app deletes the game) and markReminded (7.4), and the draft-only fixture. */
const NO_OP_OK = new Set(["deleteGame", "markReminded", "fxDraft"]);
/** Commands that may register cards; fxShuffle is the 1.2 fixture that mints one. */
const CREATORS = new Set(["finishWriting", "importDeck", "writeIn", "fxShuffle"]);

/** E3: only a count-changing saveDraft leaves the aggregate unchanged-or-not by counts; every other accepted command changes the aggregate. */
export const checkAggregateChanged: Checker = ({ before, cmd, result, actor }) => {
  if (!result.ok || cmdType(cmd) === "") return;
  if (cmdType(cmd) !== "saveDraft") {
    if (!result.value.aggregateChanged && !NO_OP_OK.has(cmdType(cmd))) throw new Error(`${cmdType(cmd)} was accepted without changing the aggregate`);
    return;
  }
  // Without the actor the check cannot tell which writeProgress the counts are compared to, and would pass vacuously.
  if (actor === undefined) throw new Error("checkAggregateChanged needs the step's actor for a saveDraft");
  const me = actorPlayer(before, actor);
  const c = cmd as { red?: unknown[]; green?: unknown[] };
  if (me === undefined || !Array.isArray(c.red) || !Array.isArray(c.green)) throw new Error("an accepted saveDraft has no seated actor or no draft arrays");
  const changed = c.red.length !== me.writeProgress.red || c.green.length !== me.writeProgress.green;
  if (result.value.aggregateChanged !== changed) throw new Error(`saveDraft aggregateChanged is ${result.value.aggregateChanged} but the counts ${changed ? "changed" : "did not change"}`);
  // The command itself emits nothing; settle may flip `paused` (a fixture can store a stale flag), which is the only event allowed.
  if (result.value.events.some((e) => e.t !== "PausedChanged")) throw new Error("saveDraft emitted events");
  if (result.value.draftChanges.length !== 1) throw new Error("saveDraft must return exactly one draft change");
};

/** Every string value (not key) anywhere in a JSON-like value. */
function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(stringLeaves);
}

/** E8: nothing stored ties a writer to a card. After a finishWriting: the envelope is redacted, `cards` keys are sorted, no event holds a new id or text, and (when play did not begin in the same command) no player holds a new id. `Game` never has `drafts`. */
export const checkNoAuthorship: Checker = ({ before, cmd, result, drafts }) => {
  if (!result.ok) return;
  const v = result.value;
  if (Object.hasOwn(v.state, "drafts")) throw new Error("Game has a drafts field");
  if (cmdType(cmd) !== "finishWriting" || before === null) return;
  if (!v.redactEnvelope) throw new Error("finishWriting must redact the envelope");
  const keys = Object.keys(v.state.cards);
  if (keys.join() !== [...keys].sort().join()) throw new Error("cards keys are not in sorted order");
  const was = new Set(Object.keys(before.cards));
  const added = keys.filter((k) => !was.has(k));
  // `RoundOpened.greenCardId` is the top of the freshly shuffled green deck, public by design and not tied to a writer (the envelope omits the actor), so it may be a just-pooled id.
  if (drafts === undefined) throw new Error("checkNoAuthorship needs the step's drafts for a finishWriting");
  const events = v.events.filter((e) => e.t !== "RoundOpened");
  const who = finisher(before, v.state);
  const draft = who === undefined ? undefined : drafts[who.id];
  // Whole values: a one-letter draft text is a substring of every event name, so only a string that is exactly a draft text (or an id) counts as a leak.
  const leaves = new Set(stringLeaves(events.map(({ t: _t, ...fields }) => fields))); // `t` is the event type, never a copy of a draft text
  for (const id of added) if (leaves.has(id)) throw new Error(`an event holds the new card id ${id}`);
  for (const text of [...(draft?.red ?? []), ...(draft?.green ?? [])]) if (leaves.has(text) || leaves.has(text.trim())) throw new Error("an event holds draft text");
  if (JSON.stringify(v.draftChanges).match(/c_[a-z0-9]{10}/) !== null) throw new Error("draftChanges holds a card id");
  if (!v.events.some((e) => e.t === "PlayStarted")) {
    const held = JSON.stringify(v.state.players);
    for (const id of added) if (held.includes(id)) throw new Error(`a player record holds the new card id ${id}`);
  }
};

// ---------------------------------------------------------------------------------------------------------------------
// #22: the round checkers (E5 per-zone moves, E6 post-resolve, E7 PLAYING half, E9, E10, E12, E13, E14, E15).

const ROUND_COMMANDS = new Set(["confirmSubmission", "closeSubmissions", "pickWinner"]);
const accepted = (result: Result<Accepted, Rejection>): Accepted | null => (result.ok ? result.value : null);
const activeOf = (g: Game): Player[] => g.players.filter((p) => p.status === "active");
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sortedKey = (xs: readonly string[]): string => [...xs].sort().join();
const countOf = (events: readonly DomainEvent[], t: DomainEvent["t"]): number => events.filter((e) => e.t === t).length;

/** E9: before `WinnerPicked`, no event of a round command mentions a submitted card (so none pairs a card with a player). The Engine keeps owners in `submissions` only. */
export const checkOwnerHidden: Checker = ({ before, cmd, result }) => {
  const v = accepted(result);
  if (v === null || !ROUND_COMMANDS.has(cmdType(cmd))) return;
  const ids = new Set<string>([...(before?.round?.submissions ?? []), ...(v.state.round?.submissions ?? [])].map((s) => s.cardId));
  const played = (cmd as { cardId?: unknown }).cardId;
  if (typeof played === "string") ids.add(played);
  const cut = v.events.findIndex((e) => e.t === "WinnerPicked");
  const early = JSON.stringify(cut === -1 ? v.events : v.events.slice(0, cut));
  for (const id of ids) if (early.includes(id)) throw new Error(`an event before WinnerPicked mentions the submitted card ${id}`);
};

/** E10: `revealOrder` is set exactly when the round is JUDGING, holds the submissions' cards, and does not change while the round stays JUDGING. */
export const checkRevealOrder: Checker = ({ before, result }) => {
  const v = accepted(result);
  const round = v?.state.round ?? null;
  if (v === null || round === null) return;
  if (round.phase === "SUBMITTING" && round.revealOrder !== null) throw new Error("a SUBMITTING round has a revealOrder");
  if (round.phase !== "JUDGING") return;
  if (round.revealOrder === null) throw new Error("a JUDGING round has no revealOrder");
  if (sortedKey(round.revealOrder) !== sortedKey(round.submissions.map((s) => s.cardId))) throw new Error("revealOrder is not the submissions' card set");
  const was = before?.round;
  if (was?.phase === "JUDGING" && was.number === round.number && !same(was.revealOrder, round.revealOrder)) throw new Error("revealOrder changed after the close");
};

const reference = (players: readonly Player[], cursor: number | null): Player | undefined => {
  const active = players.filter((p) => p.status === "active").sort((a, b) => a.joinOrder - b.joinOrder);
  return cursor === null ? undefined : (active.find((p) => p.joinOrder > cursor) ?? active[0]);
};

/** E12: a round open has one judge who is active and on the roster; the judge never submits; an unpaused round has a judge; after the first round the judge is the next by joinOrder from the previous cursor (an independent model). */
export const checkJudges: Checker = ({ before, result }) => {
  const v = accepted(result);
  if (v === null) return;
  const after = v.state;
  const round = after.round;
  if (round !== null) {
    if (round.submissions.some((s) => s.playerId === round.judgeId)) throw new Error("the judge has a submission");
    if (after.phase === "PLAYING" && !after.paused) {
      const judge = activeOf(after).find((p) => p.id === round.judgeId);
      if (judge === undefined) throw new Error("an unpaused round has no active judge");
      if (!round.roster.includes(judge.id)) throw new Error("the judge is not on the roster");
    }
  }
  if (!v.events.some((e) => e.t === "RoundOpened") || round === null || before?.round == null || v.events.some((e) => e.t === "PlayStarted")) return;
  const want = reference(after.players, before.judgeCursor);
  if (want !== undefined && round.judgeId !== want.id) throw new Error(`the judge of round ${round.number} is ${String(round.judgeId)}, rotation says ${want.id}`);
  if (round.number !== after.history.length + 1) throw new Error("round number is not history.length + 1");
};

/** E5 per zone, E13: a confirm moves exactly the played card from the player's hand to the submissions; a close moves nothing; a pick gives the round's green card to the card's owner and to nobody else. */
export const checkRoundMoves: Checker = ({ before, cmd, result, actor }) => {
  const v = accepted(result);
  const type = cmdType(cmd);
  if (v === null || before === null || !ROUND_COMMANDS.has(type) || before.round === null) return;
  const after = v.state;
  const handOf = (g: Game, id: string): string[] => g.players.find((p) => p.id === id)?.hand ?? [];
  if (type === "confirmSubmission") {
    const subs = after.round?.submissions ?? [];
    const added = subs[subs.length - 1];
    if (added === undefined || subs.length !== before.round.submissions.length + 1) throw new Error("a confirm must add exactly one submission");
    // The expected submitter and card come from the command and the actor resolved against `before`, not from the result under test.
    if (actor === undefined) throw new Error("checkRoundMoves needs the step's actor for a confirmSubmission");
    const me = actorPlayer(before, actor);
    if (me === undefined || added.playerId !== me.id) throw new Error(`the submission is by ${added.playerId}, not the command actor`);
    if (added.cardId !== (cmd as { cardId?: unknown }).cardId) throw new Error("the submitted card is not the command's card");
    if (new Set(subs.map((s) => s.playerId)).size !== subs.length) throw new Error("two submissions by one player");
    if (!handOf(before, added.playerId).includes(added.cardId)) throw new Error("the submitted card was not in the player's hand");
    for (const p of after.players) {
      const want = p.id === added.playerId ? handOf(before, p.id).filter((c) => c !== added.cardId) : handOf(before, p.id);
      if (!same(p.hand, want)) throw new Error(`player ${p.id} hand changed unexpectedly by a confirm`);
    }
    if (!same(after.pools, before.pools)) throw new Error("a confirm moved a pool");
  } else if (type === "closeSubmissions") {
    if (!same(after.players, before.players) || !same(after.pools, before.pools)) throw new Error("a close moved a card");
  } else {
    const id = (cmd as { submissionId?: string }).submissionId;
    const owner = before.round.submissions.find((s) => s.cardId === id)?.playerId;
    if (owner === undefined) throw new Error("a pick was accepted for a card that is not a submission");
    for (const p of after.players) {
      const was = before.players.find((b) => b.id === p.id);
      const want = p.id === owner ? [...(was?.scorePile ?? []), before.round.greenCardId] : (was?.scorePile ?? []);
      if (!same(p.scorePile, want)) throw new Error(`player ${p.id} score pile is wrong after a pick`);
    }
    if (after.round?.submissions.some((s) => before.round?.submissions.some((b) => b.cardId === s.cardId))) throw new Error("a resolved submission is still on the table");
  }
};

/** E6 after a resolve: every active player holds exactly 7 cards (the minimum-size decks of the scenarios force the reshuffle). */
export const checkTopUp: Checker = ({ cmd, result }) => {
  const v = accepted(result);
  if (v === null || cmdType(cmd) !== "pickWinner") return;
  for (const p of activeOf(v.state)) if (p.hand.length !== 7) throw new Error(`player ${p.id} holds ${p.hand.length} cards after a resolve`);
};

/** E7, PLAYING half: whenever a game with a target is PLAYING, the minimums hold at the seated count and the green deck is not empty (a round can open). */
export const checkPlayable: Checker = ({ result }) => {
  const v = accepted(result);
  const g = v?.state;
  if (g === undefined || g.phase !== "PLAYING" || g.target === null) return;
  const n = g.players.filter((p) => p.status === "writing" || p.status === "ready" || p.status === "active").length;
  if (!meetsMinimums(totals(g), n, g.target)) throw new Error("PLAYING without the minimums");
  if (g.pools.greenDeck.length < 1) throw new Error("PLAYING with an empty green deck");
};

/** E14: at most one `WinnerPicked` per command and never the judge; `history` grows by exactly that count with contiguous round numbers; score piles sum to `history.length` (exact until evictions, #23). */
export const checkScoring: Checker = ({ before, cmd, result }) => {
  const v = accepted(result);
  if (v === null) return;
  const after = v.state;
  const picks = v.events.filter((e): e is Extract<DomainEvent, { t: "WinnerPicked" }> => e.t === "WinnerPicked");
  if (picks.length > 1) throw new Error("two WinnerPicked in one command");
  for (const p of picks) if (p.winnerId === p.judgeId) throw new Error("the judge won their own round");
  const grew = after.history.length - (before?.history.length ?? 0);
  if (grew !== picks.length) throw new Error(`history grew by ${grew} with ${picks.length} WinnerPicked`);
  if (cmdType(cmd) === "pickWinner" && picks.length === 1) {
    // The owner is resolved from the submissions before the command, then compared with every place the winner is reported.
    const owner = before?.round?.submissions.find((s) => s.cardId === (cmd as { submissionId?: unknown }).submissionId)?.playerId;
    const last = after.history[after.history.length - 1];
    const reported = [["WinnerPicked", picks[0]?.winnerId], ["history", last?.winnerId], ...v.roundRecords.map((r) => ["RoundRecord", r.winnerId] as const)];
    for (const [where, who] of reported) if (who !== owner) throw new Error(`${where} reports winner ${String(who)}, the card's owner is ${String(owner)}`);
    if (v.roundRecords.length !== 1) throw new Error(`a pick returned ${v.roundRecords.length} round records`);
  }
  after.history.forEach((h, i) => { if (h.round !== i + 1) throw new Error(`history[${i}] is round ${h.round}`); });
  const points = after.players.reduce((n, p) => n + p.scorePile.length, 0);
  if (points !== after.history.length) throw new Error(`score piles hold ${points} cards, history has ${after.history.length} rounds`);
};

/** Commands that may be accepted in FINISHED (E15); fixture commands (`fx...`) are the harness's own. */
const FINISHED_OK = new Set(["castVote", "endGame", "deleteGame"]);

/** E15: FINISHED is terminal: no round, not paused; a finished game accepts only castVote, endGame, deleteGame; GameFinished comes with FINISHED and no RoundOpened. */
export const checkFinished: Checker = ({ before, cmd, result }) => {
  const v = accepted(result);
  if (v === null) return;
  const after = v.state;
  if (after.phase === "FINISHED") {
    // `paused` is recomputed by settle, which runs only when the aggregate changed (a fixture state may carry a stale flag).
    if (after.round !== null || (v.aggregateChanged && after.paused)) throw new Error("FINISHED with a round or paused");
    if (v.events.some((e) => e.t === "RoundOpened")) throw new Error("a round opened in FINISHED");
  }
  if (countOf(v.events, "GameFinished") > 0 && after.phase !== "FINISHED") throw new Error("GameFinished without FINISHED");
  if (before?.phase === "FINISHED" && !FINISHED_OK.has(cmdType(cmd)) && !cmdType(cmd).startsWith("fx")) throw new Error(`${cmdType(cmd)} was accepted in FINISHED`);
};

/** Append-only: later steps push the E5 to E18 checkers here. */
export const checkers: Checker[] = [
  checkSerializable, checkVersion, checkUnchangedWhenNotAggregate, checkConservation, checkHands, checkAggregateChanged, checkNoAuthorship,
  checkOwnerHidden, checkRevealOrder, checkJudges, checkRoundMoves, checkTopUp, checkPlayable, checkScoring, checkFinished,
];

/** Run every checker on a step; a failure names the step index and seed so the run can be replayed. */
export function checkAll(step: Step, list: readonly Checker[] = checkers): void {
  for (const check of list) {
    try {
      check(step);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`checker failed at step ${step.index} (seed ${String(step.seed ?? "n/a")}): ${message}`, { cause: e });
    }
  }
}
