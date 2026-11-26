// Hand-built valid view documents, one per audience and per ViewDoc/RoundDoc shape (LLD 2 4.1, 4.2, 7.1).
// Imports nothing: plain data, so the tests can clone and mutate it. Ids are short constructed values, no UUID literals.
export const GID = "gameaaaaaaaaaaaaaaaa";
export const P1 = "p_aaaaaaaa";
export const P2 = "p_aaaaaaab";
export const P3 = "p_aaaaaaac";
export const C = (n: number): string => `c_${String(n).padStart(10, "0")}`;

type Json = Record<string, unknown>;

const settings = {
  targetOverride: 3,
  profanity: "on",
  variants: { pitch: true, writeIn: true, redraw: true, peoplesChoice: true },
  spectators: { enabled: true, vote: true },
};
const settingsNull = { ...settings, targetOverride: null, profanity: "off" };

const players = [
  { id: P1, name: "Ada", joinOrder: 0, status: "writing", isHost: true, score: 0, cardsLeft: { red: 1, green: 2 } },
  { id: P2, name: "Bo", joinOrder: 1, status: "active", isHost: false, score: 2, cardsLeft: null },
  { id: P3, name: "Cy", joinOrder: 2, status: "left", isHost: false, score: 1, cardsLeft: null },
];

const live = (over: Json): Json => ({
  kind: "live",
  gameId: GID,
  version: 7,
  phase: "LOBBY",
  paused: false,
  settings: settingsNull,
  target: 5,
  targetFrozen: false,
  writeCounts: null,
  players,
  waitingOn: [],
  round: null,
  resolved: 0,
  winnerId: null,
  awards: null,
  ...over,
});

const round = (over: Json): Json => ({
  number: 2,
  judgeId: P2,
  phase: "JUDGING",
  green: { id: C(900), text: "the green card" },
  expected: [P1],
  submittedBy: [P1],
  reveal: [
    { submissionId: C(1), text: "first", pitch: null },
    { submissionId: C(2), text: "second", pitch: "because" },
  ],
  ...over,
});

const hostPanel = (over: Json = {}): Json => ({
  roomCode: "BCDF",
  playability: { n: 3, target: 5, totals: { red: 40, green: 10 }, rMin: 12, gMin: 4, meets: true },
  writeCountsOverride: null,
  ...over,
});

const you = (over: Json = {}): Json => ({
  playerId: P1,
  status: "active",
  isHost: false,
  isJudge: false,
  turn: "submit",
  score: 0,
  roomCode: "BCDF",
  hand: [{ id: C(10), text: "a card" }],
  writeTarget: null,
  cardsLeft: null,
  powerUsage: { writeIn: false, redraw: true },
  yourSubmission: null,
  myVotes: {},
  ...over,
});

export const gameViews: Record<string, Json> = {
  spectatorLobby: live({ audience: "spectator" }),
  spectatorJudging: live({
    audience: "spectator", phase: "PLAYING", settings, round: round({}), resolved: 1, writeCounts: { red: 3, green: 2 },
    waitingOn: [P2], targetFrozen: true,
  }),
  spectatorPausedEmptyReveal: live({
    audience: "spectator", phase: "PLAYING", paused: true, round: round({ judgeId: null, reveal: [] }),
  }),
  spectatorFinished: live({
    audience: "spectator", phase: "FINISHED", winnerId: P2, resolved: 5, targetFrozen: true,
    awards: {
      peoplesChoice: [P1, P3],
      podium: [
        { rank: 1, round: 3, cardId: C(5), playerId: P1, votes: 4 },
        { rank: 3, round: 1, cardId: C(6), playerId: P2, votes: 0 },
      ],
    },
  }),
  host: live({ audience: "host", host: hostPanel() }),
  player: live({ audience: "player", phase: "PLAYING", round: round({ phase: "SUBMITTING", reveal: null }), you: you() }),
  playerWithHost: live({
    audience: "player", phase: "WRITING", writeCounts: { red: 4, green: 2 }, settings,
    host: hostPanel({ writeCountsOverride: { red: 4, green: 2 } }),
    you: you({
      status: "writing", isHost: true, turn: "write", writeTarget: { red: 4, green: 2 }, cardsLeft: { red: 1, green: 0 },
      yourSubmission: { cardId: C(11), text: "mine", pitch: "why" },
      myVotes: { "1": C(5), "3": C(6) },
    }),
  }),
  playerSubmission: live({
    audience: "player", you: you({ yourSubmission: { cardId: C(11), text: "mine", pitch: null }, turn: "submitted" }),
  }),
  departed: { kind: "departed", audience: "departed", gameId: GID, version: 9, reason: "removed" },
};

const docBase = { schema: 1, viewsRev: 3, gameId: GID, enabled: true, version: 7, generatedAt: 1700000000000 };

export const viewDocs: Record<string, Json> = {
  playerWithDraft: { ...docBase, view: gameViews["playerWithHost"], draftSeq: 2, draft: { red: ["a draft"], green: [] } },
  playerNoDraftRegion: { ...docBase, view: gameViews["player"] },
  hostDraftNull: { ...docBase, view: gameViews["host"], draftSeq: 0, draft: null },
  spectator: { ...docBase, view: gameViews["spectatorJudging"] },
  spectatorDisabled: { ...docBase, enabled: false, view: null },
  departed: { ...docBase, view: gameViews["departed"] },
};

export const roundDocs: Record<string, Json> = {
  plain: {
    schema: 1, round: 2, judgeId: P2, winnerId: P1, winnerCardId: C(1), green: { id: C(900), text: "the green card" },
    plays: [
      { playerId: P1, cardId: C(1), text: "first", pitch: null },
      { playerId: P3, cardId: C(2), text: "second", pitch: "because" },
    ],
    absent: [P2], resolvedAt: 1700000000000, redacted: false,
  },
  redacted: {
    schema: 1, round: 10, judgeId: P2, winnerId: P1, winnerCardId: C(1), green: { id: C(900), text: null },
    plays: [{ playerId: P1, cardId: C(1), text: null, pitch: null }],
    absent: [], resolvedAt: 0, redacted: true,
  },
};
