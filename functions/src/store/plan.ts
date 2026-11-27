// The command planner (LLD 3 section 5.2, #33): steps 2 and 3 of the transaction as a pure function. From what step 1 read (the aggregate, the ledger
// doc and the extra docs it asked for) plus the input and the per-attempt values, it decides the outcome and every write. `runCommand` (run.ts) is the
// thin shell: transaction reads, this, then the WriteSet's writes buffered on the transaction. Being pure, it is where the write budget and the size
// guard are tested on large in-memory games (plan.test.ts).
import { RoundDocSchema, ViewDocSchema } from "@dc/contracts";
import type { GameId, GameView, RoundDoc } from "@dc/contracts";
import { DRAFT_REGION_FIELDS, PROJECTOR_REV, VIEW_REGION_FIELDS, actorRole, decide, draftRegion, fanOut, makeProjector, makeRng, toRoundDoc, viewerFor } from "@dc/engine";
import type { Actor, Draft, Game, GameDrafts } from "@dc/engine";
import { Timestamp } from "firebase-admin/firestore";
import { StoreError } from "./errors";
import { eventDoc, publicCommandType } from "./events";
import { idemId } from "./idem";
import { buildOutbox } from "./outbox";
import { redact, roundsContaining } from "./redact";
import { deletionPath, draftPath, eventPath, gamePath, idemPath, outboxPath, roomCodePath, roundPath, viewPath } from "./refs";
import { newDeletionJob } from "./delete";
import { guardSize } from "./size";
import type { CommandInput, CommandOutcome, GameDoc, IdemDoc, Json } from "./types";
import { MAX_WRITES, WriteSet, increment } from "./writeset";
import type { DocWrite } from "./writeset";

export const IDEM_TTL_MS = 7 * 86_400_000;

/** What step 1's first `getAll` returned: the aggregate and the ledger doc, null where absent. */
export interface Reads { game: GameDoc | null; idem: IdemDoc | null }
/** The per-attempt values (fresh on every rerun, ST2). `decide` is a test seam; production uses the Engine's. */
export interface PlanDeps { now: number; seed: string; mintId: () => string; decide?: typeof decide }
export interface Plan { outcome: CommandOutcome; writes: DocWrite[]; sizeWarn: boolean }

const NOT_FOUND: Plan = { outcome: { kind: "rejected", rejection: { code: "NOT_FOUND" }, version: 0 }, writes: [], sizeWarn: false };
type Data = Record<string, unknown>;
const data = (x: object): Data => x as Data;

/** `game` without the Store's own map (the Engine never sees `store`, LLD 3 section 2.2). */
export function splitStore(doc: GameDoc): { prev: Game; store: GameDoc["store"] } {
  const { store, ...prev } = doc;
  return { prev, store };
}

/** A new aggregate document: the Engine state plus a fresh Store map (LLD 3 section 2.2). Shared by the planner and createGame. */
export function withStore(state: Game, now: number): GameDoc {
  return { ...state, store: { schema: 1, viewsRev: PROJECTOR_REV, updatedAt: now, deleting: null } };
}

/**
 * One step's view fan-out as `DocWrite`s: the strict parse at the Store boundary (5.2) and the two merge regions (LLD 2 8.4). `storedRev` is the
 * Store's stored `viewsRev` (0 when nothing is written yet). Shared by the planner and createGame; #35's rebuildViews reuses it.
 */
export function planViews(gameId: GameId, from: Game | null, to: Game, o: { now: number; storedRev: number }): DocWrite[] {
  const w = new WriteSet({ max: MAX_WRITES });
  for (const vw of fanOut(from, to, o)) {
    const vd = ViewDocSchema.parse(vw.doc); // redundant with fanOut's own strict parse; kept at the Store boundary (5.2)
    w.merge(viewPath(gameId, vw.docId), data(vd), VIEW_REGION_FIELDS);
    if (vw.clearDraft === true) w.merge(viewPath(gameId, vw.docId), { draft: null, draftSeq: increment(1) }, DRAFT_REGION_FIELDS);
  }
  return w.writes();
}

/** The caller's own view, computed in memory (LLD 2 8.5); null for the system actor. */
export function viewFor(game: Game, actor: Actor): GameView | null {
  return actor.kind === "system" ? null : makeProjector(game)(viewerFor(game, actor.uid));
}

const actorPlayerId = (game: Game, actor: Actor) => (actor.kind === "user" ? actorRole(game, actor).playerId : null);
const readsDraft = (i: CommandInput) => i.cmd.type === "saveDraft" || i.cmd.type === "finishWriting";
const joinable = (g: Game) => g.phase === "LOBBY" || g.phase === "WRITING" || g.phase === "PLAYING";

/**
 * Step 1's second `getAll` (LLD 3 section 5.3): the actor's draft (saveDraft, finishWriting) or the round docs holding a removed card (removeCard).
 * Nothing when the command stops at the first read (missing, deleting, ledger hit). `deleteGame` also reads `roomCodes/{prev.roomCode}`,
 * because a FINISHED or ENDED game may already have released the code to a newer game (ST8, #36).
 */
export function extraReadPaths(r: Reads, i: CommandInput): string[] {
  if (r.game === null || r.game.store.deleting !== null || r.idem !== null) return [];
  const { prev } = splitStore(r.game);
  if (i.cmd.type === "deleteGame") return [roomCodePath(prev.roomCode)];
  const me = actorPlayerId(prev, i.actor);
  if (me !== null && readsDraft(i)) return [draftPath(i.gameId, me)];
  if (i.cmd.type === "removeCard") return roundsContaining(prev, i.cmd.cardId).map((n) => roundPath(i.gameId, n));
  return [];
}

function replay(prev: Game, i: CommandInput, idem: IdemDoc): Plan {
  return {
    outcome: { kind: "accepted", replay: true, version: idem.version, view: viewFor(prev, i.actor), ...(idem.draftSeq === undefined ? {} : { draftSeq: idem.draftSeq }), ...(idem.meta === undefined ? {} : { meta: idem.meta }) },
    writes: [],
    sizeWarn: false,
  };
}

const toDraft = (d: Data): Draft => ({ red: d["red"] as string[], green: d["green"] as string[] });

const uidOf = (game: Game, playerId: string): string => {
  const p = game.players.find((x) => x.id === playerId);
  if (p === undefined) throw new StoreError("INVARIANT", "a draft change for a player the state does not hold");
  return p.uid;
};

/** Steps 2 and 3 (LLD 3 section 5.2). Throws StoreError for failures (INVARIANT, AGGREGATE_TOO_LARGE, TOO_MANY_WRITES); nothing is planned then. */
export function planCommand(r: Reads, extra: ReadonlyMap<string, Data | null>, i: CommandInput, d: PlanDeps): Plan {
  if (r.game === null || r.game.store.deleting !== null) return NOT_FOUND; // no decide, no writes (ST9 read side)
  const { prev, store } = splitStore(r.game);
  if (r.idem !== null) return replay(prev, i, r.idem); // before decide and any staleness test (5.4)

  const me = actorPlayerId(prev, i.actor);
  const myDraftPath = me !== null && readsDraft(i) ? draftPath(i.gameId, me) : null;
  const myDraft = myDraftPath === null ? null : (extra.get(myDraftPath) ?? null);
  const drafts: GameDrafts = me !== null && myDraft !== null ? { [me]: toDraft(myDraft) } : {};

  // ---------- 2. DECIDE ----------
  const { now, seed } = d;
  const res = (d.decide ?? decide)(prev, i.cmd, { now, rng: makeRng(seed), mintId: d.mintId, actor: i.actor, drafts });
  if (!res.ok) return { outcome: { kind: "rejected", rejection: res.error, version: prev.version }, writes: [], sizeWarn: false };
  const a = res.value;

  // ---------- 3. WRITES ----------
  if (a.deleteGame === true) {
    // Phase 0 of S5 (6.4): the aggregate is not rewritten, so the version, the views and the size guard are untouched.
    // The job carries what the cascade needs after the aggregate is gone, and where the code may now belong to a newer game.
    const w = new WriteSet({ max: MAX_WRITES });
    w.update(gamePath(i.gameId), { "store.deleting": { at: now, by: prev.hostId }, "store.updatedAt": now });
    const code = extra.get(roomCodePath(prev.roomCode)) ?? null;
    if (code !== null && code["gameId"] === i.gameId) w.delete(roomCodePath(prev.roomCode));
    w.create(deletionPath(i.gameId), data(newDeletionJob(prev, now)));
    return { outcome: { kind: "deleting" }, writes: w.writes(), sizeWarn: false };
  }
  const w = new WriteSet({ max: MAX_WRITES });
  const writeViews = (from: Game | null, to: Game): void => {
    for (const x of planViews(i.gameId, from, to, { now, storedRev: store.viewsRev })) w.apply(x);
  };

  let sizeWarn = false;
  let rebuilt = false;
  if (a.aggregateChanged) {
    const next = a.state;
    if (next.version !== prev.version + 1) throw new StoreError("INVARIANT", `version contiguity: ${prev.version} to ${next.version} (ST4)`);
    const doc: GameDoc = withStore(next, now);
    sizeWarn = guardSize(doc, r.game, { escape: i.cmd.type === "endGame" }).warn; // ST6; endGame is always allowed (5.9)
    w.set(gamePath(i.gameId), data(doc)); // full replace: removed keys vanish
    w.create(eventPath(i.gameId, next.version), data(eventDoc(next.version, now, a, i.cmd, seed, me ?? actorPlayerId(next, i.actor))));
    for (const rec of a.roundRecords) w.create(roundPath(i.gameId, rec.round), data(RoundDocSchema.parse(toRoundDoc(rec)))); // S3: create() fails if it exists
    if (i.cmd.type === "removeCard") {
      for (const n of roundsContaining(prev, i.cmd.cardId)) {
        const rd = extra.get(roundPath(i.gameId, n)) ?? null;
        if (rd !== null) w.set(roundPath(i.gameId, n), data(redact(rd as unknown as RoundDoc, i.cmd.cardId))); // ST13: the one mutation of a round doc
      }
    }
    for (const row of buildOutbox(prev, next, i.cmd, a, now)) w.create(outboxPath(i.gameId, row.id), data(row));
    if (joinable(prev) && !joinable(next)) w.delete(roomCodePath(next.roomCode)); // FINISHED or ENDED releases the code (ST8)
    writeViews(prev, next);
  } else if (store.viewsRev !== PROJECTOR_REV && i.actor.kind === "user") {
    // K-F: stale views are rebuilt on any user command, aggregate change or not, at the unchanged version (5.6).
    w.update(gamePath(i.gameId), { "store.viewsRev": PROJECTOR_REV, "store.updatedAt": now });
    writeViews(null, prev);
    rebuilt = true;
  }

  // Drafts: an absolute seq only where step 1 read the actor's drafts doc; every other clear is increment(1), so draftSeq never goes down (5.6).
  const readMine = myDraftPath !== null;
  const seq = (myDraft === null ? 0 : (myDraft["seq"] as number)) + 1;
  for (const c of a.draftChanges) {
    const absolute = readMine && c.playerId === me;
    const docId = uidOf(a.state, c.playerId);
    if (c.draft !== null) {
      if (!absolute) throw new StoreError("INVARIANT", "a text draft that is not the actor's own save");
      w.set(draftPath(i.gameId, c.playerId), { red: [...c.draft.red], green: [...c.draft.green], seq, updatedAt: now });
      w.merge(viewPath(i.gameId, docId), draftRegion(c.draft, seq), DRAFT_REGION_FIELDS);
    } else {
      w.delete(draftPath(i.gameId, c.playerId));
      w.merge(viewPath(i.gameId, docId), absolute ? draftRegion(null, seq) : { draft: null, draftSeq: increment(1) }, DRAFT_REGION_FIELDS);
    }
  }

  for (const x of i.extraWrites?.({ prev, next: a.state }) ?? []) w.apply(x);
  if (!a.aggregateChanged && a.draftChanges.length === 0 && !rebuilt) {
    return { outcome: { kind: "accepted", version: prev.version, view: viewFor(prev, i.actor), replay: false }, writes: [], sizeWarn: false }; // no-op markReminded: zero writes
  }

  const mySeq = readMine && !a.aggregateChanged && a.draftChanges.some((c) => c.playerId === me) ? seq : undefined; // only a draft-only save's absolute seq is returned
  const idem: IdemDoc = { at: now, expiresAt: Timestamp.fromMillis(now + IDEM_TTL_MS), commandType: publicCommandType(i.cmd), version: a.state.version, ...(mySeq === undefined ? {} : { draftSeq: mySeq }), ...(i.meta === undefined ? {} : { meta: i.meta as Json }) };
  w.create(idemPath(i.gameId, idemId(i.actor, i.idemKey)), data(idem));
  return {
    outcome: { kind: "accepted", version: a.state.version, view: viewFor(a.state, i.actor), ...(mySeq === undefined ? {} : { draftSeq: mySeq }), replay: false },
    writes: w.writes(),
    sizeWarn,
  };
}
