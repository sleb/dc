// #29: the ViewDoc envelope cells: what `fanOut` writes for a player, an unseated host, an enabled and a disabled spectator, a departed and a `gone` doc, and the draft region.
// Frozen as snapshots (fanout-golden.test.ts) and, with the 43 view cells, part of the PROJECTOR_REV fingerprint (rev-tools.ts), because a change to the envelope is a change a client sees.
import { draftRegion, fanOut } from "../../src/project/fanout";
import type { Game } from "../../src/types";
import { park } from "../support/round-fixtures";
import { judging, lobby, settings, submitting, uidOf, unseatHost } from "./fixtures";

export const ENVELOPE_NOW = 1_700_000_000_000;
const doc = (g: Game, docId: string) => fanOut(null, g, { now: ENVELOPE_NOW, skipUnchanged: false }).find((w) => w.docId === docId);

export const ENVELOPE_CELLS: { name: string; value: () => unknown }[] = [
  { name: "player (a non-host in SUBMITTING)", value: () => doc(submitting(), uidOf(2)) },
  { name: "unseated host", value: () => doc(unseatHost(judging()), uidOf(0)) },
  { name: "enabled spectator", value: () => doc(judging(), "spectator") },
  { name: "disabled spectator", value: () => doc({ ...lobby(), settings: settings({ spectators: false }) }, "spectator") },
  { name: "departed (left)", value: () => doc(park(submitting(), 3, "left"), uidOf(3)) },
  {
    name: "gone tombstone with clearDraft",
    value: () => {
      const g = lobby();
      const next = { ...g, version: g.version + 1, players: g.players.filter((p) => p.id !== g.players[2]?.id) };
      return fanOut(g, next, { now: ENVELOPE_NOW, skipUnchanged: true }).find((w) => w.docId === uidOf(2));
    },
  },
  { name: "draft region", value: () => [draftRegion({ red: ["R1", "R2"], green: ["G1"] }, 4), draftRegion(null, 0)] },
];
