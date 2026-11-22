import type { Game, Player } from "./types";

/** Players holding a seat: writing, ready or active (LLD 1 section 3.2, derived sets). */
export function seated(g: Game): Player[] {
  return g.players.filter((p) => p.status === "writing" || p.status === "ready" || p.status === "active");
}

export function activePlayers(g: Game): Player[] {
  return g.players.filter((p) => p.status === "active");
}
