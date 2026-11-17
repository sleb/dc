# Deep Cuts: Gameplay & Rules

## Overview

A rotating judge picks a green adjective card; everyone else secretly plays the red noun card from their hand that best fits it; the judge picks a favorite and that player wins the round. First to the target score wins the game. Every card is written by the players at the start, so the decks run on the group's shared history and in-jokes; it's built for friends and family, not strangers.

The web version should support:

- Joining a game in under 10 seconds with a room code or link, no account required
- Asynchronous play on phones and desktops, 3 to 10 players: everyone takes their turn when they have time
- Games that run over hours or days, with a notification whenever it's your turn
- Anonymous submissions until the judge decides, so the reveal stays fun

## Players & components

The game supports 3 to 10 players; 4 to 8 is the sweet spot. One player is the judge each round, and the role rotates in join order every round.

| Component | What it is | Count |
|---|---|---|
| Green card | An adjective or adjective phrase ("Sticky", "Dangerous", "Overrated"). The judge draws one per round. | Score target per player (4–8) |
| Red card | A noun: person, place, thing, event or idea ("Pizza", "The Moon", "Tax Day"). Played to match the green card. | 10 written per player |
| Hand | Red cards a player holds | 7 per player |
| Score pile | Green cards a player has won; one point each | Starts at 0 |

The player-written cards are shuffled into the two decks at game start. When the red deck runs out, its discard pile is reshuffled. With one green card per player per point of the target, the green deck can't run out before someone wins.

## Setup

1. A host creates a game and gets a 4-letter room code plus a shareable link. The host signs in with an email and a sign-in link (no password), which is how they return to their host controls.
2. Players join with a display name (no account needed) and appear in the lobby.
3. The host sets options: score target (default by player count, see below), and how many red cards each player writes.
4. The host starts the game once at least 3 players have joined.
5. **Write cards:** Each player privately writes their own cards: 10 red noun cards ("My first car", "The DMV") and as many green adjective-phrase cards as the score target (8 in a 3–4 player game, down to 4 at 8+) ("Smells suspicious", "Worth the wait"). Cards are pooled anonymously and shuffled into a red deck and a green deck; no one sees who wrote what. Players can write over as many sittings as they like; play begins once everyone has finished. Players who get stuck can tap for a few example prompts.
6. Each player is dealt 7 red cards from the shared pool. The first judge is chosen at random.

## Round flow

1. **Green card:** The judge's green card is revealed and every other player is notified that it's their turn.
2. **Submit:** Every non-judge player picks one red card from their hand and submits it face down. They can change their pick until they confirm. There is no timer: the round waits, and everyone can see who hasn't played yet.
3. **Reveal:** Once everyone has submitted (or submissions are closed early, see below), the judge is notified and all submitted red cards are shown in random order, with no names attached.
4. **Judge:** The judge picks the red card they think best matches the green card. They can take as long as they like.
5. **Result:** The winning card's owner is revealed and gets the green card as a point. Everyone is notified and sees who played what.
6. **Next round:** Each player who played a card draws back up to 7. The judge role passes to the next player.

## Judging & scoring

The judge decides purely on taste: funniest, most fitting, most surprising. There is no right answer, and the judge does not explain unless they want to.

- The winner of a round gets 1 point (the green card).
- The judge never scores in a round they judge and never submits a card.
- Submissions stay anonymous until the judge picks, so the judge can't favor friends.
- A judge can't pick a card they didn't see: all submitted cards must be shown before choosing.

## Winning the game

The first player to reach the target number of green cards wins. Default targets match the physical game:

| Players | Green cards to win |
|---|---|
| 3 | 8 |
| 4 | 8 |
| 5 | 7 |
| 6 | 6 |
| 7 | 5 |
| 8+ | 4 |

The host can override the target in setup. If a round could somehow produce a tie (it can't in standard play, since only one winner is picked per round), the game continues until one player leads.

## Web-specific rules

- **No timers:** Rounds wait for players; nothing expires on its own.
- **Notifications:** Players get a push notification when it's their turn: a new green card to play on or, for the judge, all cards in (no email notification to start). A daily reminder goes to anyone the round is waiting on.
- **Closing a round early:** The judge or host can close submissions and reveal what's in at any time, with no minimum wait. Players who missed it keep their hand and sit out that round.
- **Stalled judge:** If the judge hasn't picked, the host can pass judging to the next player at any time, who picks from the same cards. If that player submitted a card, it goes back to their hand.
- **Coming and going:** There's no live connection to lose. Players open their game link whenever they like and pick up with the same hand.
- **Catching up:** A round-by-round feed shows each green card, every card played and who played it, so anyone returning after a day can see what they missed.
- **Late joins:** New players can join at any point. They write their cards (same counts), which are shuffled into the decks, then join the next round with 7 cards and 0 points.
- **Away players:** The host can remove a player at any time, and rounds stop waiting for them. There is no automatic away status.
- **Leaving:** A player who leaves has their hand returned to the red deck. The host can also remove a player.
- **Host leaves:** The host needs to be signed in to run the game, so if they leave it stalls until they return. Host transfer can be added later if this becomes a problem.
- **Fewer than 3 players:** The game pauses until a third player joins or the host ends it.
- **Content:** All cards are player-written, so there are no packs to pick. The host sets the profanity filter for card text and display names (on for family groups, off for adults) and can remove any card or player.

## Optional variants

Off by default; the host can enable them in setup.

- **Pitch it:** Players can add a short written justification (up to 140 characters) with their card.
- **Write-in:** Once per game, a player can write a new red card on the spot instead of playing one from their hand.
- **Redraw:** Once per game, a player can discard their hand and draw 7 new cards.
- **People's choice:** Players (and spectators, if enabled) can vote on the best card each round, independent of the judge's pick; players can't vote for their own card, and votes never count toward winning. At game end, a People's Choice award goes to the player with the most votes across all rounds, and the three most-voted plays of the game are shown as gold, silver and bronze.
- **Spectators:** People can watch a game via the link without playing, and can vote on the People's Choice.
- **Saved decks:** The host can save a game's cards and reuse them next time, so a group's deck grows over game nights.

## Decisions

- [x] Start with anonymous rooms and no persistent stats for now.
- [x] No in-game chat to start; players use their own group chat.
- [x] No variant lets a player play multiple cards per round.
- [x] Timeouts deferred: no wait before a round can be closed early or a judge passed over. Players nudge each other in their own text group chat; we add it if it becomes a problem.
- [x] No solo or bot mode to fill empty seats for now.
