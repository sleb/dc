// The golden cells (LLD 2 section 11.5): one per (state, viewer). Each is tagged with the phase and audience it covers; golden.test.ts checks the matrix.
import { project, viewerFor } from "../../src/project";
import type { Viewer } from "../../src/project";
import type { Game } from "../../src/types";
import { HOST_UID } from "../support/factories";
import { park, roundGame } from "../support/round-fixtures";
import { DEP, HU, P, SPEC, ended, finished, judging, lateJoiner, lobby, paused, pausedJudgingEmpty, pausedNoJudge, sitOut, submitting, unseatHost, writing } from "./fixtures";

export const PHASES = ["LOBBY", "WRITING", "SUBMITTING", "JUDGING", "PAUSED", "FINISHED", "ENDED"] as const;
export const AUDIENCES = ["player", "judge", "host", "unseatedHost", "spectator"] as const;
export type CellPhase = (typeof PHASES)[number];
export type CellAudience = (typeof AUDIENCES)[number];

export interface Cell { name: string; phase: CellPhase; audience: CellAudience | "departed"; game: () => Game; viewer: (g: Game) => Viewer }
const fixed = (v: Viewer) => (): Viewer => v;
const cell = (name: string, phase: CellPhase, audience: Cell["audience"], game: () => Game, viewer: Viewer | ((g: Game) => Viewer)): Cell => ({ name, phase, audience, game, viewer: typeof viewer === "function" ? viewer : fixed(viewer) });

/** Applicable cells are the product of PHASES and AUDIENCES minus these: nobody is the judge when there is no open round. Departed viewers are phase-independent and have their own cells. */
export const NOT_APPLICABLE: [CellPhase, CellAudience][] = [["LOBBY", "judge"], ["WRITING", "judge"], ["FINISHED", "judge"], ["ENDED", "judge"]];

const hostLeft = () => park(roundGame({ n: 4, judge: 1, submitted: [2] }), 0, "left");

export const CELLS: Cell[] = [
  cell("lobby/host", "LOBBY", "host", lobby, P(0)),
  cell("lobby/player", "LOBBY", "player", lobby, P(1)),
  cell("lobby/unseatedHost", "LOBBY", "unseatedHost", () => unseatHost(lobby()), HU),
  cell("lobby/spectator", "LOBBY", "spectator", lobby, SPEC),

  cell("writing/host-writer", "WRITING", "host", writing, P(0)),
  cell("writing/player-writer", "WRITING", "player", writing, P(2)),
  cell("writing/player-finished", "WRITING", "player", writing, P(1)),
  cell("writing/unseatedHost", "WRITING", "unseatedHost", () => unseatHost(writing()), HU),
  cell("writing/spectator", "WRITING", "spectator", writing, SPEC),
  

  cell("submitting/judge", "SUBMITTING", "judge", submitting, P(1)),
  cell("submitting/player-submitted", "SUBMITTING", "player", submitting, P(2)),
  cell("submitting/player-unsubmitted", "SUBMITTING", "player", submitting, P(4)),
  cell("submitting/player-late-joiner-writing", "SUBMITTING", "player", lateJoiner, P(5)),
  cell("submitting/player-sitting-out", "SUBMITTING", "player", sitOut, P(4)),
  cell("submitting/host", "SUBMITTING", "host", submitting, P(0)),
  cell("submitting/unseatedHost", "SUBMITTING", "unseatedHost", () => unseatHost(submitting()), HU),
  cell("submitting/spectator", "SUBMITTING", "spectator", submitting, SPEC),

  cell("judging/judge", "JUDGING", "judge", judging, P(1)),
  cell("judging/player-submitter", "JUDGING", "player", judging, P(3)),
  cell("judging/player-non-submitter", "JUDGING", "player", judging, P(5)),
  cell("judging/host", "JUDGING", "host", judging, P(0)),
  cell("judging/unseatedHost", "JUDGING", "unseatedHost", () => unseatHost(judging()), HU),
  cell("judging/spectator", "JUDGING", "spectator", judging, SPEC),

  cell("paused/judge", "PAUSED", "judge", paused, P(1)),
  cell("paused/host", "PAUSED", "host", paused, P(0)),
  cell("paused/unseatedHost", "PAUSED", "unseatedHost", () => unseatHost(paused()), HU),
  cell("paused/spectator", "PAUSED", "spectator", paused, SPEC),
  cell("paused/no-judge-spectator", "PAUSED", "spectator", pausedNoJudge, SPEC),
  cell("paused/no-judge-player", "PAUSED", "player", pausedNoJudge, P(1)),
  cell("paused/judging-empty-spectator", "PAUSED", "spectator", pausedJudgingEmpty, SPEC),

  cell("finished/winner", "FINISHED", "player", finished, P(2)),
  cell("finished/player", "FINISHED", "player", finished, P(3)),
  cell("finished/host", "FINISHED", "host", finished, P(0)),
  cell("finished/unseatedHost", "FINISHED", "unseatedHost", () => unseatHost(finished()), HU),
  cell("finished/spectator", "FINISHED", "spectator", finished, SPEC),

  cell("ended/player", "ENDED", "player", ended, P(2)),
  cell("ended/host", "ENDED", "host", ended, P(0)),
  cell("ended/unseatedHost", "ENDED", "unseatedHost", () => unseatHost(ended()), HU),
  cell("ended/spectator", "ENDED", "spectator", ended, SPEC),

  cell("departed/left", "SUBMITTING", "departed", () => park(submitting(), 3, "left"), DEP(3, "left")),
  cell("departed/removed", "SUBMITTING", "departed", () => park(submitting(), 3, "removed"), DEP(3, "removed")),
  cell("departed/gone", "LOBBY", "departed", lobby, DEP(2, "gone")),
  cell("departed/host-precedence", "SUBMITTING", "departed", hostLeft, (g) => viewerFor(g, HOST_UID)),
];

/** The golden of one cell. */
export const goldenOf = (c: Cell): unknown => { const g = c.game(); return project(g, c.viewer(g)); };
