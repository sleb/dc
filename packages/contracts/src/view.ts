import { z } from "zod";
import { CardIdSchema, GameIdSchema, PlayerIdSchema, RoomCodeSchema } from "./ids";
import { VIEW_SCHEMA } from "./version";

// GameView, ViewDoc and RoundDoc (LLD 2 4.1, 4.2, 7.1 are normative for fields; LLD 5 2.5 for the strict/loose rule).

// Enumerations as `as const` tuples. The Engine keeps its own literal types; a type test in packages/engine/test proves equality.
export const PHASES = ["LOBBY", "WRITING", "PLAYING", "FINISHED", "ENDED"] as const;
export const PLAYER_STATUSES = ["writing", "ready", "active", "left", "removed"] as const;
export const ROUND_PHASES = ["SUBMITTING", "JUDGING"] as const;
export const YOU_TURNS = ["lobby", "write", "ready", "submit", "submitted", "judge", "wait", "sit_out", "paused", "over"] as const;
export const DEPARTED_REASONS = ["left", "removed", "gone"] as const;

export const PhaseSchema = z.enum(PHASES);
export const PlayerStatusSchema = z.enum(PLAYER_STATUSES);
export const RoundPhaseSchema = z.enum(ROUND_PHASES);
export const YouTurnSchema = z.enum(YOU_TURNS);
export const DepartedReasonSchema = z.enum(DEPARTED_REASONS);
export type Phase = z.infer<typeof PhaseSchema>;
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;
export type RoundPhase = z.infer<typeof RoundPhaseSchema>;
export type YouTurn = z.infer<typeof YouTurnSchema>;
export type DepartedReason = z.infer<typeof DepartedReasonSchema>;

/** The viewer's own unfinished draft text (LLD 1 `Draft`). */
export const DraftSchema = z.strictObject({ red: z.array(z.string()), green: z.array(z.string()) });
export type Draft = z.infer<typeof DraftSchema>;

const Int = z.number().int();
const NonNeg = Int.nonnegative();
const Pos = Int.positive();

/**
 * One definition, two parsers. `strict` (server, PJ2): closed objects, exact enums. `loose` (web): unknown keys allowed and every enum
 * position parses as any string; ids, regexes, numeric checks and the `audience`, `kind` and `schema` literals stay exact.
 * The return type describes the strict shape; the loose exports below are re-typed (enum positions widen to string).
 */
export const makeViewSchemas = (mode: "strict" | "loose") => {
  const obj = (mode === "strict" ? z.strictObject : z.looseObject) as typeof z.strictObject;
  const en = (<S extends z.ZodType>(e: S) => (mode === "strict" ? e : z.string())) as <S extends z.ZodType>(e: S) => S;

  const Counts = obj({ red: NonNeg, green: NonNeg });
  const PublicSettings = obj({
    targetOverride: z.number().int().min(2).max(10).nullable(),
    profanity: en(z.enum(["on", "off"])),
    variants: obj({ pitch: z.boolean(), writeIn: z.boolean(), redraw: z.boolean(), peoplesChoice: z.boolean() }),
    spectators: obj({ enabled: z.boolean(), vote: z.boolean() }),
  });
  const PlayerPublic = obj({
    id: PlayerIdSchema, name: z.string(), joinOrder: NonNeg, status: en(PlayerStatusSchema),
    isHost: z.boolean(), score: NonNeg, cardsLeft: Counts.nullable(),
  });
  const RevealCard = obj({ submissionId: CardIdSchema, text: z.string(), pitch: z.string().nullable() });
  const RoundPublic = obj({
    number: Pos, judgeId: PlayerIdSchema.nullable(), phase: en(RoundPhaseSchema),
    green: obj({ id: CardIdSchema, text: z.string() }),
    expected: z.array(PlayerIdSchema), submittedBy: z.array(PlayerIdSchema), reveal: z.array(RevealCard).nullable(),
  });
  const AwardsView = obj({
    peoplesChoice: z.array(PlayerIdSchema),
    podium: z.array(obj({
      rank: z.union([z.literal(1), z.literal(2), z.literal(3)]), round: Pos, cardId: CardIdSchema, playerId: PlayerIdSchema, votes: NonNeg,
    })),
  });
  const YouView = obj({
    playerId: PlayerIdSchema, status: en(PlayerStatusSchema), isHost: z.boolean(), isJudge: z.boolean(), turn: en(YouTurnSchema),
    score: NonNeg, roomCode: RoomCodeSchema,
    hand: z.array(obj({ id: CardIdSchema, text: z.string() })),
    writeTarget: Counts.nullable(), cardsLeft: Counts.nullable(),
    powerUsage: obj({ writeIn: z.boolean(), redraw: z.boolean() }),
    yourSubmission: obj({ cardId: CardIdSchema, text: z.string(), pitch: z.string().nullable() }).nullable(),
    myVotes: z.record(z.string().regex(/^[1-9][0-9]*$/), CardIdSchema),
  });
  const HostPanel = obj({
    roomCode: RoomCodeSchema,
    playability: obj({ n: NonNeg, target: Pos, totals: Counts, rMin: NonNeg, gMin: NonNeg, meets: z.boolean() }),
    writeCountsOverride: Counts.nullable(),
  });
  const Live = {
    kind: z.literal("live"), gameId: GameIdSchema, version: NonNeg, phase: en(PhaseSchema), paused: z.boolean(), settings: PublicSettings,
    target: Pos, targetFrozen: z.boolean(), writeCounts: Counts.nullable(), players: z.array(PlayerPublic), waitingOn: z.array(PlayerIdSchema),
    round: RoundPublic.nullable(), resolved: NonNeg, winnerId: PlayerIdSchema.nullable(), awards: AwardsView.nullable(),
  };
  const GameView = z.discriminatedUnion("audience", [
    obj({ ...Live, audience: z.literal("spectator") }),
    obj({ ...Live, audience: z.literal("host"), host: HostPanel }),
    obj({ ...Live, audience: z.literal("player"), you: YouView, host: HostPanel.optional() }),
    obj({ kind: z.literal("departed"), audience: z.literal("departed"), gameId: GameIdSchema, version: NonNeg, reason: en(DepartedReasonSchema) }),
  ]);
  // viewsRev: clients order snapshots by (version, viewsRev) lexicographically (LLD 2 8.4). draft and draftSeq are the second region,
  // written independently; absent in a `view` write, so they are optional here.
  const ViewDoc = obj({
    schema: z.literal(VIEW_SCHEMA), viewsRev: NonNeg, gameId: GameIdSchema, enabled: z.boolean(), version: NonNeg, generatedAt: NonNeg,
    view: GameView.nullable(), draftSeq: NonNeg.optional(), draft: (mode === "strict" ? DraftSchema : obj({ red: z.array(z.string()), green: z.array(z.string()) })).nullable().optional(),
  });
  const RoundDoc = obj({
    schema: z.literal(VIEW_SCHEMA), round: Pos, judgeId: PlayerIdSchema, winnerId: PlayerIdSchema, winnerCardId: CardIdSchema,
    green: obj({ id: CardIdSchema, text: z.string().nullable() }),
    plays: z.array(obj({ playerId: PlayerIdSchema, cardId: CardIdSchema, text: z.string().nullable(), pitch: z.string().nullable() })),
    absent: z.array(PlayerIdSchema), resolvedAt: NonNeg, redacted: z.boolean(),
  });
  return { GameView, ViewDoc, RoundDoc };
};

type Strict = ReturnType<typeof makeViewSchemas>;
export type GameView = z.infer<Strict["GameView"]>;
export type ViewDoc = z.infer<Strict["ViewDoc"]>;
export type RoundDoc = z.infer<Strict["RoundDoc"]>;

/** The loose type: every enum position (phase, status, turn, profanity, reason) is a plain string. */
type EnumKey = "phase" | "status" | "turn" | "profanity" | "reason";
type WidenEnums<T> = T extends readonly (infer U)[] ? WidenEnums<U>[]
  : T extends object ? { [K in keyof T]: K extends EnumKey ? string : WidenEnums<T[K]> } : T;
export type GameViewLoose = WidenEnums<GameView>;
export type ViewDocLoose = WidenEnums<ViewDoc>;
export type RoundDocLoose = WidenEnums<RoundDoc>;

const strict = makeViewSchemas("strict");
const loose = makeViewSchemas("loose") as unknown as {
  GameView: z.ZodType<GameViewLoose>; ViewDoc: z.ZodType<ViewDocLoose>; RoundDoc: z.ZodType<RoundDocLoose>;
};

/** Server only (PJ2): closed. */
export const GameViewSchema = strict.GameView;
export const ViewDocSchema = strict.ViewDoc;
export const RoundDocSchema = strict.RoundDoc;
/** Web: tolerant of additive change (LLD 5 2.5 loose rule). */
export const GameViewLooseSchema = loose.GameView;
export const ViewDocLooseSchema = loose.ViewDoc;
export const RoundDocLooseSchema = loose.RoundDoc;
