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
export const enumerators: Record<string, Enumerator> = {};

/** A command type that has no enumerator on purpose, with the reason. */
export const exemptions: Record<string, string> = {};

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
