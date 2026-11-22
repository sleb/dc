import { expect } from "bun:test";
import type { Accepted, Actor, Draft, Game, GameDrafts, Player, Rejection, Result } from "../../src/types";

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
  expect(JSON.parse(JSON.stringify(result.value.state))).toEqual(result.value.state);
};

/** E3: the version moves by exactly one when the aggregate changed, else not at all. */
export const checkVersion: Checker = ({ before, result }) => {
  if (!result.ok) return;
  const was = before?.version ?? 0;
  const want = was + (result.value.aggregateChanged ? 1 : 0);
  if (result.value.state.version !== want) throw new Error(`version is ${result.value.state.version}, expected ${want} (before ${was}, aggregateChanged ${result.value.aggregateChanged})`);
};

/** E3 corollary: a command reported as not changing the aggregate leaves the state deep-equal to the input (a saveDraft-style handler must not mutate state). */
export const checkUnchangedWhenNotAggregate: Checker = ({ before, result }) => {
  if (!result.ok || result.value.aggregateChanged || before === null) return;
  expect(result.value.state).toEqual(before);
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
    const draft: Draft | undefined = drafts?.[who.id];
    if (draft !== undefined) {
      const dRed = countKind(after, "red") - countKind(before, "red");
      const dGreen = countKind(after, "green") - countKind(before, "green");
      if (dRed !== draft.red.length || dGreen !== draft.green.length) throw new Error(`finishWriting added ${dRed} red and ${dGreen} green for a draft of ${draft.red.length} and ${draft.green.length}`);
    }
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
  const me = actorPlayer(before, actor);
  const c = cmd as { red?: unknown[]; green?: unknown[] };
  if (me === undefined || !Array.isArray(c.red) || !Array.isArray(c.green)) return;
  const changed = c.red.length !== me.writeProgress.red || c.green.length !== me.writeProgress.green;
  if (result.value.aggregateChanged !== changed) throw new Error(`saveDraft aggregateChanged is ${result.value.aggregateChanged} but the counts ${changed ? "changed" : "did not change"}`);
  if (result.value.events.length !== 0) throw new Error("saveDraft emitted events");
  if (result.value.draftChanges.length !== 1) throw new Error("saveDraft must return exactly one draft change");
};

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
  const events = JSON.stringify(v.events);
  const who = finisher(before, v.state);
  const draft = who === undefined ? undefined : drafts?.[who.id];
  for (const id of added) if (events.includes(id)) throw new Error(`an event holds the new card id ${id}`);
  for (const text of [...(draft?.red ?? []), ...(draft?.green ?? [])]) if (events.includes(JSON.stringify(text).slice(1, -1))) throw new Error("an event holds draft text");
  if (JSON.stringify(v.draftChanges).match(/c_[a-z0-9]{10}/) !== null) throw new Error("draftChanges holds a card id");
  if (!v.events.some((e) => e.t === "PlayStarted")) {
    const held = JSON.stringify(v.state.players);
    for (const id of added) if (held.includes(id)) throw new Error(`a player record holds the new card id ${id}`);
  }
};

/** Append-only: later steps push the E5 to E18 checkers here. */
export const checkers: Checker[] = [checkSerializable, checkVersion, checkUnchangedWhenNotAggregate, checkConservation, checkHands, checkAggregateChanged, checkNoAuthorship];

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
