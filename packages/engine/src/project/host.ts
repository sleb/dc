// The host panel (LLD 2 section 5.2): the room code, playability counts and the write-counts override. Pool sizes and thresholds only; no card identities.
import type { GameView } from "@dc/contracts";
import { playabilityReport } from "../selectors";
import type { Game } from "../types";

export type HostPanel = Extract<GameView, { audience: "host" }>["host"];

export function hostPanel(game: Game): HostPanel {
  const r = playabilityReport(game);
  const o = game.settings.writeCountsOverride;
  return {
    roomCode: game.roomCode,
    playability: { n: r.n, target: r.target, totals: { red: r.totals.red, green: r.totals.green }, rMin: r.rMin, gMin: r.gMin, meets: r.meets },
    writeCountsOverride: o === null ? null : { red: o.red, green: o.green },
  };
}
