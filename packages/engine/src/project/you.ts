// The viewer's own secrets and affordances (LLD 2 sections 4.2, 5.2, PJ5). The only module in `project/` that reads a hand, an own submission, votes or `powerUsage`;
// everything here is taken from the viewer's own player record. Lint keeps `handOf` and the owner-keyed selectors out of every other file in `project/`.
import type { GameView } from "@dc/contracts";
import { cardText, cardsStillToWrite, handOf, ownSubmission } from "../selectors";
import type { CardId, Game, Player } from "../types";
import { youTurn } from "./turn";

export type YouView = Extract<GameView, { audience: "player" }>["you"];

export function youView(game: Game, me: Player, isHost: boolean): YouView {
  const writing = me.status === "writing" && me.writeTarget !== null;
  const left = cardsStillToWrite(game, me.id);
  const mine = ownSubmission(game, me.id);
  const myVotes: Record<string, CardId> = {};
  if (game.settings.variants.peoplesChoice) {
    const voter = `p:${me.id}`;
    for (const v of game.votes.filter((x) => x.voter === voter).sort((a, b) => a.round - b.round)) myVotes[String(v.round)] = v.cardId;
  }
  return {
    playerId: me.id,
    status: me.status,
    isHost,
    isJudge: game.phase === "PLAYING" && game.round !== null && game.round.judgeId === me.id,
    turn: youTurn(game, me),
    score: me.scorePile.length,
    roomCode: game.roomCode,
    hand: game.phase === "PLAYING" && me.status === "active" ? handOf(game, me.id).map((id) => ({ id, text: cardText(game, id) })) : [],
    writeTarget: writing && me.writeTarget !== null ? { red: me.writeTarget.red, green: me.writeTarget.green } : null,
    cardsLeft: writing ? { red: left.red, green: left.green } : null,
    powerUsage: { writeIn: me.powerUsage.writeIn, redraw: me.powerUsage.redraw },
    yourSubmission: mine === null ? null : { cardId: mine.cardId, text: mine.text, pitch: mine.pitch },
    myVotes,
  };
}
