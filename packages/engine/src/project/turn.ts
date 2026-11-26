// `you.turn` (LLD 2 section 4.4): computed once, here, so the client never derives rules. Precedence, first match wins:
// LOBBY, over (FINISHED or ENDED), writing or ready, paused, sit_out, then the judge or submission state of the open round.
import type { YouTurn } from "@dc/contracts";
import type { Game, Player } from "../types";

export function youTurn(game: Game, player: Player): YouTurn {
  if (game.phase === "LOBBY") return "lobby";
  if (game.phase === "FINISHED" || game.phase === "ENDED") return "over";
  if (player.status === "writing") return "write";
  if (player.status === "ready") return "ready";
  if (game.paused) return "paused";
  const round = game.round;
  if (round === null) return "wait"; // PLAYING always holds a round once settled; this is only a total fallback
  if (!round.roster.includes(player.id)) return "sit_out";
  const judge = round.judgeId === player.id;
  if (round.phase === "JUDGING") return judge ? "judge" : "wait";
  if (judge) return "wait";
  return round.submissions.some((s) => s.playerId === player.id) ? "submitted" : "submit";
}
