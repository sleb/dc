import { MAX_SEATED, MAX_TOTAL_JOINS } from "@dc/contracts";
import type { Command } from "@dc/contracts";
import type { Registry } from "../../src/registry";
import type { Actor, Game, GameDrafts } from "../../src/types";
import { GAME_ID, HOST_UID, cid, pid, seatUidOf } from "./factories";

export interface LegalEntry { actor: Actor; cmd: Command }
export type Enumerator = (game: Game, drafts: GameDrafts) => LegalEntry[];

/**
 * `legalCommands` is written independently of `decide`, from gameplay.md (LLD 1 section 15.1).
 * One enumerator per command type, added by the step that implements the command. Append-only.
 */
export const enumerators: Record<string, Enumerator> = {
  // updateSettings: the host may change any setting in LOBBY, and the profanity filter in WRITING and PLAYING (gameplay.md, host controls).
  updateSettings: (g) => {
    const host: Actor = { kind: "user", uid: g.hostId };
    const patches: Record<string, unknown>[] = [{ profanity: g.settings.profanity === "on" ? "off" : "on" }];
    if (g.phase === "LOBBY") {
      patches.push(
        {},
        { targetOverride: 5 },
        { targetOverride: null },
        { variants: { pitch: true, writeIn: true, redraw: true, peoplesChoice: true } },
        { spectators: { enabled: true, vote: true } },
      );
      if (Object.keys(g.cards).length > 0) patches.push({ writeCountsOverride: { red: 1, green: 1 } });
    } else if (g.phase !== "WRITING" && g.phase !== "PLAYING") return [];
    return patches.map((patch) => ({ actor: host, cmd: { type: "updateSettings", patch } as Command }));
  },
  // join: a LOBBY with room, under the join cap, for a player id and a name nobody has.
  join: (g) => {
    const seated = g.players.filter((p) => p.status === "writing" || p.status === "ready" || p.status === "active");
    if (g.phase !== "LOBBY" || seated.length >= MAX_SEATED || g.totalJoins >= MAX_TOTAL_JOINS) return [];
    let k = 20;
    while (g.players.some((p) => p.id === pid(k))) k++;
    const taken = new Set(seated.map((p) => p.name.toLowerCase().replace(/\s+/g, "")));
    let n = 0;
    while (taken.has(`guest${n}`)) n++;
    return [{ actor: seat(k), cmd: { type: "join", playerId: pid(k), name: `Guest ${n}` } as Command }];
  },
  // leave: every seated player may leave a LOBBY, the host's seat included.
  leave: (g) => (g.phase !== "LOBBY" ? [] : g.players.filter((p) => p.status === "writing").map((p) => ({ actor: { kind: "user", uid: p.uid } as Actor, cmd: { type: "leave" } as Command }))),
  // removePlayer: the host may remove any seated player from a LOBBY, their own seat included.
  removePlayer: (g) => (g.phase !== "LOBBY" ? [] : g.players.filter((p) => p.status === "writing").map((p) => ({ actor: { kind: "user", uid: g.hostId } as Actor, cmd: { type: "removePlayer", playerId: p.id } as Command }))),
};

/** A command type that has no enumerator on purpose, with the reason. */
export const exemptions: Record<string, string> = {
  createGame: "it makes the aggregate, so there is no state to enumerate from; the G1 file runs its own property over arbitrary settings",
};

/** Every command a state accepts, from every enumerator in `table`. */
export function legalCommands(game: Game, drafts: GameDrafts, table: Readonly<Record<string, Enumerator>> = enumerators): LegalEntry[] {
  return Object.values(table).flatMap((e) => e(game, drafts));
}

/** Registered command types with neither an enumerator nor an explicit exemption (the G1 meta-test wants this empty). */
export function missingEnumerators(registry: Registry, table: Readonly<Record<string, Enumerator>> = enumerators, exempt: Readonly<Record<string, string>> = exemptions): string[] {
  return Object.keys(registry).filter((t) => !Object.hasOwn(table, t) && !Object.hasOwn(exempt, t));
}

const stranger: Actor = { kind: "user", uid: "stranger-uid" };
const seat = (n: number): Actor => ({ kind: "user", uid: seatUidOf(GAME_ID, pid(n)) });

/** Minimal well-typed payload for every command in the contracts union; the record type makes a new command a compile error here. */
const MINIMAL: Record<Command["type"], Record<string, unknown>> = {
  createGame: { gameId: GAME_ID, roomCode: "BCDF", hostId: HOST_UID, hostPlayerId: pid(0), hostName: "Host" },
  updateSettings: { patch: {} },
  join: { playerId: pid(9), name: "Nine" },
  leave: {},
  removePlayer: { playerId: pid(9) },
  removeCard: { cardId: cid(9999) },
  importDeck: { red: [], green: [] },
  startGame: {},
  saveDraft: { red: [], green: [] },
  finishWriting: {},
  confirmSubmission: { cardId: cid(9999) },
  writeIn: { text: "x" },
  redraw: {},
  closeSubmissions: {},
  pickWinner: { submissionId: cid(9999) },
  passJudging: {},
  castVote: { round: 1, submissionId: cid(9999) },
  endGame: {},
  deleteGame: {},
  markReminded: { episode: "writing", episodeGen: 0 },
};

/** Well-typed but illegal commands: a stranger as actor, bogus ids, oversized payloads, a stale expectedVersion. The game is accepted for later steps that tailor junk to it. */
export function junkCommands(_game: Game): LegalEntry[] {
  const out: LegalEntry[] = [];
  for (const [type, payload] of Object.entries(MINIMAL)) {
    const base = { type, ...payload } as unknown as Command;
    out.push({ actor: stranger, cmd: base });
    out.push({ actor: seat(1), cmd: { ...base, expectedVersion: 0 } as unknown as Command });
    out.push({ actor: { kind: "user", uid: HOST_UID }, cmd: { ...base, cardId: "nope", text: "x".repeat(10_000), red: ["x".repeat(10_000)] } as unknown as Command });
    out.push({ actor: { kind: "system" }, cmd: base });
  }
  return out;
}
export const JUNK_TYPES: readonly string[] = Object.keys(MINIMAL);
