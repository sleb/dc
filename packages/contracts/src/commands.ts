import { z } from "zod";
import { CardIdSchema, GameIdSchema, IdempotencyKeySchema, PlayerIdSchema } from "./ids";
import type { GameId, PlayerId, Uid } from "./ids";
import { WIRE_DRAFT_MAX, WIRE_TEXT_MAX } from "./limits";
import { SettingsPatchSchema } from "./settings";
import type { Settings } from "./settings";

const env = <T extends string, P extends z.ZodRawShape>(type: T, payload: P, needsVersion = false) =>
  z.object({
    v: z.number().int().min(1),
    gameId: GameIdSchema,
    idempotencyKey: IdempotencyKeySchema,
    expectedVersion: needsVersion ? z.number().int().nonnegative() : z.number().int().nonnegative().optional(),
    type: z.literal(type),
    payload: z.object(payload),
  });
const Text = z.string().max(WIRE_TEXT_MAX);
const Pitch = Text.optional();

export const CommandEnvelopeSchema = z.discriminatedUnion("type", [
  env("updateSettings", { patch: SettingsPatchSchema }),
  env("leave", {}),
  env("removePlayer", { playerId: PlayerIdSchema }),
  env("removeCard", { cardId: CardIdSchema }),
  env("startGame", {}),
  env("saveDraft", { red: z.array(Text).max(WIRE_DRAFT_MAX), green: z.array(Text).max(WIRE_DRAFT_MAX) }),
  env("finishWriting", {}),
  env("confirmSubmission", { cardId: CardIdSchema, pitch: Pitch }, true),
  env("writeIn", { text: Text, pitch: Pitch }, true),
  env("redraw", {}),
  env("closeSubmissions", {}, true),
  env("pickWinner", { submissionId: CardIdSchema }, true),
  env("passJudging", {}, true),
  env("castVote", { round: z.number().int().positive(), submissionId: CardIdSchema }),
  env("endGame", {}),
]);
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;
export type ClientCommandType = CommandEnvelope["type"];

/** Commands that never arrive through `command`: they need no aggregate, a host-only principal or are system-issued. */
export const SERVER_ONLY_COMMANDS = ["createGame", "join", "importDeck", "deleteGame", "markReminded"] as const;
export type ServerOnlyCommandType = (typeof SERVER_ONLY_COMMANDS)[number];

/** The Engine command for each client type: the payload fields flattened, plus `expectedVersion`. */
export type ClientCommand = CommandEnvelope extends infer E
  ? E extends { type: infer T; payload: infer P }
    ? { type: T } & P & { expectedVersion?: number }
    : never
  : never;

// Server-only command shapes, as in LLD 1 section 7. Plain types: no schema may parse them off the wire.
export type ServerOnlyCommand =
  | { type: "createGame"; gameId: GameId; roomCode: string; hostId: Uid; hostPlayerId: PlayerId; hostName: string; settings?: Partial<Settings>; expectedVersion?: number }
  | { type: "join"; playerId: PlayerId; name: string; expectedVersion?: number }
  | { type: "importDeck"; red: string[]; green: string[]; expectedVersion?: number }
  | { type: "deleteGame"; expectedVersion?: number }
  | { type: "markReminded"; episode: string; episodeGen: number; expectedVersion?: number };

export type Command = ClientCommand | ServerOnlyCommand;

/** Pure; the only place an envelope becomes an Engine command. */
export function toEngineCommand(e: CommandEnvelope): ClientCommand {
  return {
    type: e.type,
    ...e.payload,
    ...(e.expectedVersion === undefined ? {} : { expectedVersion: e.expectedVersion }),
  } as ClientCommand;
}
