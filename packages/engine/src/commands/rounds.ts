// The round commands (LLD 1 sections 7.1, 7.2, 8.2, 8.3): confirmSubmission, closeSubmissions, pickWinner.
// Guard 8 (#25): the pitch is moderated as `pitch` (length by code points, structure, profanity) and stored cleaned; a blank pitch is no pitch and skips the check. Guard 7 keeps the shape only (a string).
// `writeIn`, `redraw`, `castVote` and `importDeck` have no owner in M1 and stay unregistered (guard 0, INVALID_ARGUMENT); `passJudging` and `endGame` are in stalls.ts (#23), and `deleteGame` is in delete.ts (#36).
import type { Command } from "@dc/contracts";
import { reject } from "../errors";
import type { CommandSpec, Input } from "../registry";
import { check } from "../moderation";
import { closeRound, resolveRound } from "../rules/rounds";
import type { CardId, Game, Handled, Player, Rejection, Round, Submission } from "../types";
import { cleanedText, textRejection } from "./text";

type Of<T extends Command["type"]> = Extract<Command, { type: T }>;

const effects = (): Pick<Handled, "draftChanges" | "roundRecords" | "redactEnvelope" | "aggregateChanged"> =>
  ({ draftChanges: [], roundRecords: [], redactEnvelope: false, aggregateChanged: true });
const invalid = (): Rejection => reject("INVALID_ARGUMENT");
const field = (cmd: object, key: string): unknown => (cmd as Record<string, unknown>)[key];

/** The actor's seat. Guard 2 has already established that a seat exists for the commands that call this. */
const seatOf = (i: Input<Command>): Player => i.state.players.find((p) => p.id === i.roles.playerId) as Player;
/** The open round. Guard 4 (`inRound`) has already established it exists, in the phase the command needs. */
const roundOf = (i: Input<Command>): Round => i.state.round as Round;

/** Guard 4 beyond `phases`: the command needs a round, in this round phase. */
const inRound = (phase: Round["phase"]) => (i: Input<Command>): Rejection | null => (i.state.round?.phase === phase ? null : reject("WRONG_PHASE"));

/**
 * Guard 7, shared: these commands are stale-checked and the contracts envelope requires `expectedVersion` for them (a non-negative integer),
 * so it must be a finite integer here. Guard 3 skips anything else, so an absent, NaN or fractional value must not get past guard 7.
 */
export const versionOk = (cmd: object): boolean => Number.isInteger(field(cmd, "expectedVersion"));

/** The pitch as sent: undefined for none (absent, or blank once cleaned), a string otherwise; null when it is not a string (guard 7). A blank pitch is no pitch, whatever the mode. */
function pitchOf(cmd: object): string | undefined | null {
  const raw = field(cmd, "pitch");
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return null;
  const r = check(raw, "pitch", "off");
  return !r.ok && r.reason === "EMPTY" ? undefined : raw;
}

export const confirmSubmission: CommandSpec<Of<"confirmSubmission">> = {
  type: "confirmSubmission",
  phases: ["PLAYING"],
  stale: true,
  needsPlay: true,
  actor: (i) => i.roles.playerId !== null,
  phase: inRound("SUBMITTING"),
  // Guard 6: the judge never plays; a seat that was not active when the round opened sits out (a late joiner, ready or writing).
  role: (i) => {
    if (i.roles.judge) return reject("NOT_AUTHORIZED");
    return roundOf(i).roster.includes(i.roles.playerId as string) ? null : reject("NOT_AUTHORIZED", "sitting_out");
  },
  payload: (i) => (versionOk(i.cmd) && typeof field(i.cmd, "cardId") === "string" && pitchOf(i.cmd) !== null ? null : invalid()),
  // Guard 8: the pitch, when there is one, under the mode now in force (a pitch is checked even with the variant off: guard 8 precedes guard 9's VARIANT_UNAVAILABLE).
  moderation: (i) => {
    const pitch = pitchOf(i.cmd);
    return pitch === undefined || pitch === null ? null : textRejection(pitch, "pitch", i.state.settings.profanity);
  },
  // Guard 9 in the order of 7.1: ALREADY_SUBMITTED, NOT_IN_HAND (one rejection whether or not the card exists elsewhere), VARIANT_UNAVAILABLE.
  preconditions: (i) => {
    const me = seatOf(i);
    if (roundOf(i).submissions.some((s) => s.playerId === me.id)) return reject("ALREADY_SUBMITTED");
    if (!me.hand.includes(field(i.cmd, "cardId") as string)) return reject("NOT_IN_HAND");
    return pitchOf(i.cmd) !== undefined && !i.state.settings.variants.pitch ? reject("VARIANT_UNAVAILABLE") : null;
  },
  // The card leaves the hand and joins `submissions` in confirm order. A pitch is kept on the Submission only (a hand play carries nothing else).
  // Settle slot 4 closes the round in the same command when this was the last expected player.
  handle: (i) => {
    const me = seatOf(i);
    const round = roundOf(i);
    const cardId: CardId = i.cmd.cardId;
    const raw = pitchOf(i.cmd);
    const pitch = typeof raw === "string" ? cleanedText(raw, "pitch") : undefined;
    const submission: Submission = { playerId: me.id, cardId, ...(pitch === undefined ? {} : { pitch }) };
    const players = i.state.players.map((p) => (p.id === me.id ? { ...p, hand: p.hand.filter((c) => c !== cardId) } : p));
    return { ...effects(), state: { ...i.state, players, round: { ...round, submissions: [...round.submissions, submission] } }, events: [{ t: "SubmissionConfirmed", round: round.number, playerId: me.id }] };
  },
};

export const closeSubmissions: CommandSpec<Of<"closeSubmissions">> = {
  type: "closeSubmissions",
  phases: ["PLAYING"],
  stale: true,
  needsPlay: true,
  actor: (i) => i.roles.playerId !== null || i.roles.host,
  phase: inRound("SUBMITTING"),
  role: (i) => (i.roles.judge || i.roles.host ? null : reject("NOT_AUTHORIZED")),
  payload: (i) => (versionOk(i.cmd) ? null : invalid()),
  preconditions: (i) => (roundOf(i).submissions.length === 0 ? reject("NOT_PLAYABLE", "no_submissions") : null),
  handle: (i) => {
    const closed = closeRound(i.state, i.ctx.rng, "closed");
    return { ...effects(), ...closed, episodeStarted: true };
  },
};

export const pickWinner: CommandSpec<Of<"pickWinner">> = {
  type: "pickWinner",
  phases: ["PLAYING"],
  stale: true,
  needsPlay: true,
  actor: (i) => i.roles.playerId !== null,
  phase: inRound("JUDGING"),
  role: (i) => (i.roles.judge ? null : reject("NOT_AUTHORIZED")),
  payload: (i) => (versionOk(i.cmd) && typeof field(i.cmd, "submissionId") === "string" ? null : invalid()),
  // An unknown id and an id of another round are the same rejection (no detail), so a card cannot be probed.
  preconditions: (i) => (roundOf(i).revealOrder?.includes(i.cmd.submissionId) === true ? null : reject("NOT_FOUND")),
  handle: (i) => {
    const resolved = resolveRound(i.state, i.cmd.submissionId, i.ctx.rng, i.ctx.now);
    return { ...effects(), state: resolved.state as Game, events: resolved.events, roundRecords: resolved.roundRecords, episodeStarted: true };
  },
};
