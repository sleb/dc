# Deep Cuts: LLD 1, Game Engine

Status: draft v0.1. Companion to [gameplay.md](../gameplay.md), [high-level-design.md](../high-level-design.md) (HLD), [tech-stack.md](../tech-stack.md) and [00-platform-build-deploy.md](./00-platform-build-deploy.md) (LLD 0). gameplay.md is the source of truth for rules; where this document had to choose, the choice is stated with a one-line rationale, and real gaps are listed in "Open questions / conflicts". This LLD specifies `packages/engine` (`@dc/engine`) minus the Projector (LLD 2): the pure, deterministic domain core, the Moderation module, and the test strategy. "Must" statements are testable. Invariants E1 to E18 and M1 to M4 are the HLD's; new Engine-level laws are labeled X1 onward.

## 1. Scope and principles

- The Engine is one pure function, `decide`, plus pure selectors. No I/O, no clock, no ambient randomness, no Firebase (LLD 0 P5).
- It knows nothing about idempotency keys, transactions, Firestore documents, tokens, or views. It receives a `Game`, a command, and a `ctx`; it returns a new `Game`, events and side-document instructions, or a `Rejection`.
- Everything that varies between runs enters through `ctx`: `now`, `rng`, `mintId`, `actor`, `drafts`. Given equal inputs (including the same `mintId` outputs) the output is byte-identical (X3).
- `Game` is plain JSON: no `Map`, `Set`, `Date`, `undefined`-valued fields or class instances (X2). It is what the Store persists, so it must survive `JSON.parse(JSON.stringify(g))` and Firestore's data model.
- Game rules never branch on `now` (HLD 4.4, T3). Timestamps are recorded; two denormalized scheduler fields are derived from them (section 4.2).

## 2. Package layout and constraints

```
packages/engine/
  package.json              # "name": "@dc/engine"; exports { ".": "./src/index.ts" }; deps: @dc/contracts only
  tsconfig.json             # lib ["ES2023"], types []  (LLD 0 section 5)
  tsconfig.test.json
  src/
    index.ts                # the only public entry (section 2.1)
    types.ts                # Game, Player, Card, Round, Settings, ... (section 3)
    errors.ts               # EngineInvariantError, reject() helper typed by DETAIL_BY_CODE
    rng.ts                  # makeRng(seed), rngFromRaw (the sampling rules over a raw uint32 source)
    registry.ts             # CommandSpec, CreateSpec, Registry, REGISTRY: one row per command (section 5.5)
    decide.ts               # makeDecide(registry), decide = makeDecide(REGISTRY): dispatch and guards 0 to 9
    settle.ts               # settle: the named, ordered slots of section 8.2
    roles.ts                # actorRole, seatUid
    commands/               # command modules; lobby.ts (1.3: createGame, updateSettings, join, leave, removePlayer) holds the lobby rows, writing.ts (1.4: startGame, saveDraft, finishWriting) the writing rows, rounds.ts (1.5, #22: confirmSubmission, closeSubmissions, pickWinner) the round rows, and stalls.ts (1.6, #23: passJudging, endGame), waiting.ts (1.7, #24: markReminded), cards.ts (1.8, #25: removeCard) and text.ts (guard 8 helpers: `textRejection`, `cleanedText`)
    rules/
      playability.ts        # rMin, gMin, defaultTarget, totals, meetsMinimums, writeCounts (1.3), lateJoinerRequirement (1.6, #23)
      rounds.ts             # nextJudge, openRound, beginPlay (1.4, #21); closeRound, resolveRound, voidRound (1.5, #22); reassignJudge, abortRound (1.6, #23)
      cards.ts              # mintCardId (1.2), draw, topUp with the red reshuffle (1.4), removeCardFromGame (1.8, #25)
      membership.ts         # activateReady (1.4); evictPlayer (1.6, #23)
      waiting.ts            # waitingOn, episode, reminder fields
      awards.ts             # peoplesChoice, podium
    moderation/
      index.ts              # check(), clean(), nameKey() (1.8, #25)
      normalize.ts          # folding pipeline: fold (to a fixed point), normalize, collapseRuns
      wordlist.ts           # data: terms, allowlist (placeholder fake tokens until M7)
    selectors.ts            # read-only helpers for the Projector and tests
    project/                # LLD 2 (not specified here)
  test/                     # *.test.ts (bun:test + fast-check); helpers in test/support/
```

- Lint and type rules are LLD 0's: no `firebase*`, `node:*`, `bun*`, `process`, `crypto`, `Date.now()`, `new Date()`, `Math.random()`, `setTimeout` in `src` (P5). `Intl` and `String.prototype.normalize` are allowed (ES2023 built-ins, deterministic).
- Dependencies: `@dc/contracts` only (command and error types and `TEXT_LIMITS`; no `zod` needed in the Engine because contracts validates the envelope before the Engine sees it). Engine still re-validates semantic ranges (lengths, counts) because the Engine must be safe against any caller (X1).
- Type ownership: `Command`, `ErrorCode` and the payload shapes below are exported from `@dc/contracts` (LLD 5 owns the zod schemas; this LLD fixes the fields). Domain types (`Game`, `Player`, ...) are Engine-owned and never imported by `apps/web` (LLD 0 P5, open question 5 there).

### 2.1 Public exports

```ts
export { decide } from "./decide";                 // = makeDecide(REGISTRY); makeDecide itself is internal, for tests
export { EngineInvariantError } from "./errors";   // the one thing decide may throw; the app maps it to an internal error
export { actorRole, seatUid } from "./roles";
export { makeRng } from "./rng";
export { check as checkText } from "./moderation";
export * from "./selectors";          // section 14; as built (1.9) every selector there but exportPools (M9)
export * as playability from "./rules/playability";
export type { Game, GameDrafts, Draft, Player, Card, Round, RoundSummary, RoundRecord, Settings, Vote,
              DomainEvent, Accepted, DraftChange, Phase, PlayerStatus, RoundPhase, Pools, Submission, Rejection, Ctx, Rng, Actor, Roles, CardKind, Result, Awards, Podium } from "./types";   // Settings and the id types are re-exported from @dc/contracts; Rejection is the Engine's own (section 5.3)
export { project, makeProjector, viewerFor, viewersOf, fanOut, toRoundDoc, projectFeed, PROJECTOR_REV } from "./project";   // LLD 2
export { REMINDER_INTERVAL_MS } from "./rules/waiting";
// MAX_TOTAL_JOINS and MAX_VOTES come from @dc/contracts (section 9.1)
```

As of 1.3 (#20) `index.ts` exports `decide`, `EngineInvariantError`, `makeRng`, `actorRole`, `seatUid`, `REMINDER_INTERVAL_MS`, `playability` (`MIN_PLAYERS`, `HAND`, `NEW_DECK_RED`, `rMin`, `gMin`, `defaultTarget`, `totals`, `meetsMinimums`, `writeCounts`), the `seated` and `activePlayers` selectors and the types above that exist. 1.8 (#25) adds `checkText` and the `shownToTable` selector (via `export * from "./selectors"`). 1.9 (#26) adds the rest of the section 14 selectors (every one but `exportPools`, M9: `isPaused`, `effectiveTarget`, `expectedSubmitters`, `waitingOn`, `submittedBy`, `cardText`, `handOf`, `revealList`, `ownSubmission`, `submissionOwner`, `cardsStillToWrite`, `playabilityReport`, `awards`, `votesFor`) and the `Awards` and `Podium` types. As of 2.2 (#28) the Projector's `project`, `makeProjector`, `viewerFor`, `viewersOf` and `docIdOf` (and the types `Viewer`, `ViewTarget`) are exported too; `fanOut`, `toRoundDoc` and the rest arrive with 2.3. `src/index.test.ts` pins the list. 1.4 (#21) adds no public export: `startGame`, `saveDraft` and `finishWriting` are registry rows reached through `decide`, and `draw`, `topUp`, `activateReady`, `nextJudge`, `openRound` and `beginPlay` are internal helpers (`rules/`), imported by `settle.ts` and by the commands. 1.5 (#22) adds none either: `confirmSubmission`, `closeSubmissions` and `pickWinner` are registry rows, and `closeRound`, `resolveRound` and `voidRound` are internal helpers of `rules/rounds.ts`.

## 3. Domain model

### 3.1 Identifiers and cards

```ts
// GameId, PlayerId, CardId, SubmissionId, Uid and Settings come from @dc/contracts (the Engine re-exports them from types.ts).
type GameId = string; type PlayerId = string; type CardId = string; type Uid = string;
type SubmissionId = CardId;   // see below
type CardKind = "red" | "green";
interface Card { kind: CardKind; text: string }
```

- **PlayerId**: `p_` plus 8 base-36 chars (`[a-z0-9]{8}`, as in `@dc/contracts`), generated by the application layer for `join` (the seat uid and token need it before the command runs; section 6). The host's own PlayerId is supplied in `createGame`.
- **CardId**: `c_` plus 10 base-36 chars (`[a-z0-9]{10}`, as in `@dc/contracts`) from `ctx.mintId()`, a port backed by a CSPRNG (section 5.2); the Engine re-calls it on a collision with `cards`, up to 16 attempts, then throws `EngineInvariantError` (`mintCardId(ctx, cards)` in `rules/cards.ts`; an id that is not `c_` plus 10 of `[a-z0-9]` is a broken port and throws at once; the caller registers each id before minting the next). Ids are never derived from the replayable `rng` seed. Not sequential, on purpose: sequential ids assigned at `finishWriting` would group a player's cards and leak authorship (E8). Pool order is also reshuffled on every `finishWriting`, and `finishWriting` rebuilds `Game.cards` in sorted-key order (a plain code-point sort of the ids), so the registry's insertion order cannot group one author's batch either (E8; a test pins it).
- **SubmissionId = CardId of the played card.** One less mapping; ids are opaque and uncorrelated with owners. Votes and `pickWinner` carry `(round, cardId)` where round is implicit for the current round.
- Card text lives once, in `Game.cards`. Every zone holds ids. This makes E5 a set check and keeps text out of events by construction.

### 3.2 Aggregate

```ts
type Phase = "LOBBY" | "WRITING" | "PLAYING" | "FINISHED" | "ENDED";
type RoundPhase = "SUBMITTING" | "JUDGING";
// writing: has not finished writing (also used in LOBBY, where writeTarget is null)
// ready:   finished writing; waiting for play to begin or for the next round boundary
// active:  in play, holds a hand
// left | removed: departed (kept for history; hand, pile and draft already released)
type PlayerStatus = "writing" | "ready" | "active" | "left" | "removed";

interface Player {
  id: PlayerId; uid: Uid;                 // uid = hostId for the host's seat, else seatUid(gameId, id)
  name: string; joinOrder: number;        // monotonic per game, never reused
  status: PlayerStatus;
  hand: CardId[]; scorePile: CardId[];    // scorePile holds green cards
  writeTarget: { red: number; green: number } | null;
  writeProgress: { red: number; green: number };      // counts in the saved draft (section 4.1)
  powerUsage: { writeIn: boolean; redraw: boolean };  // server-only; enforces once-per-game (E16). Projected only to its owner (section 14, K-A)
}

// Settings is the type from @dc/contracts (SettingsSchema); shown here for reference.
interface Settings {
  targetOverride: number | null;          // 2..10; null = defaultTarget(N at start)
  profanity: "on" | "off";                // host's filter, applies to names, cards, pitches (M2)
  variants: { pitch: boolean; writeIn: boolean; redraw: boolean; peoplesChoice: boolean };
  spectators: { enabled: boolean; vote: boolean };    // vote only meaningful with peoplesChoice
  writeCountsOverride: { red: number; green: number } | null;  // only with an imported deck (section 9.3)
}

interface Pools { redDeck: CardId[]; redDiscard: CardId[]; greenDeck: CardId[]; greenDiscard: CardId[] }
// greenDiscard exists for HLD compatibility but no rule moves a card into it (open question 6; unused, always empty).
// Decks are queues: draw from index 0; returned cards are appended.

interface Submission { playerId: PlayerId; cardId: CardId; pitch?: string;
  writeIn?: true }                        // server-only marker, lives only while the round is open; never in events, records or other viewers' views (K-A)

interface Round {
  number: number;                         // = history.length + 1; voided rounds reuse the number
  judgeId: PlayerId | null;               // null only while paused, when the judge was evicted and no other active player could take over (8.3)
  judgeReassigned: boolean;               // true when judgeId was set by reassignJudge rather than rotation; a void then keeps this judge (8.3)
  greenCardId: CardId;
  phase: RoundPhase;
  roster: PlayerId[];                     // active players at open time (judge included); fixed
  submissions: Submission[];              // owners recorded, never exposed before resolution (E9)
  revealOrder: CardId[] | null;           // set once at close (E10)
  played: PlayerId[];                     // who played, snapshotted by closeRound (submission order); [] while SUBMITTING. Pruned by evictPlayer and reassignJudge, never by removeCard. Authors only, no card ids (OQ 20, #28)
  openedAt: number;
  changedAtVersion: number;               // version of the last judge/phase/voiding change, or `removeCard` touching a revealed play or replacing the green (STALE, section 5.3, 8.6)
}

// Compact, id-only resolved round kept in the aggregate (votes and awards need owners). Texts live in RoundRecord.
interface RoundSummary { round: number; judgeId: PlayerId; greenCardId: CardId;
  plays: { playerId: PlayerId; cardId: CardId }[]; winnerCardId: CardId; winnerId: PlayerId }

// Full record written to games/{id}/rounds/{round}; immutable (S3). Returned by decide, not stored in Game.
interface RoundRecord extends RoundSummary {
  green: { id: CardId; text: string };
  playsDetail: { playerId: PlayerId; cardId: CardId; text: string; pitch?: string }[];  // in revealOrder order
  absent: PlayerId[];                     // roster members (non-judge) who did not play
  resolvedAt: number;
}

interface Vote { round: number; voter: string; cardId: CardId }   // voter = "p:{playerId}" | "s:{uid}"

interface Game {
  id: GameId; roomCode: string; hostId: Uid; createdAt: number;
  version: number;
  totalJoins: number;                     // monotonic: +1 per successful `join`, never decremented (LOBBY leavers included); 0 at createGame (the host seat is not a join)
  phase: Phase; paused: boolean;          // paused is derived but stored: the scheduler queries it
  settings: Settings;
  target: number | null;                  // frozen at startGame
  writeCounts: { red: number; green: number } | null;   // configured per-player counts, frozen at startGame
  cards: Record<CardId, Card>;            // registry; a card exists iff it is in exactly one zone (E5)
  players: Player[];
  pools: Pools;
  round: Round | null;                    // non-null only in PLAYING
  judgeCursor: number | null;             // joinOrder of the most recent judge (survives that player leaving)
  history: RoundSummary[];
  votes: Vote[];
  winnerId: PlayerId | null;              // set on FINISHED
  // scheduler denormalization (section 4.2)
  waitingOn: PlayerId[]; waitingSince: number | null; reminderDueAt: number | null; episode: string | null;
  episodeGen: number;                     // +1 each time an episode starts (including after un-pause); 0 at createGame (K-E)
}

// Not part of Game. Lives in games/{id}/drafts/{playerId}; the only place authorship exists (E8).
interface Draft { red: string[]; green: string[] }
type GameDrafts = Readonly<Record<PlayerId, Draft>>;
```

**Zones.** `hand(p)`, `scorePile(p)` (green), `redDeck`, `redDiscard`, `greenDeck`, `greenDiscard`, `round.submissions[].cardId`, and `round.greenCardId`. E5 says each registry card is in exactly one.

**Derived sets** (selectors, never stored except where noted): `seated = status in {writing, ready, active}`; `active`; `N = seated.length` for minimums and caps; `paused` (stored); `expected = round.roster ∩ active − judge`; `waitingOn`.

## 4. Mapping to Firestore (high level; LLD 3 owns the schema)

### 4.1 What lives where

| Engine concept | Stored in | Notes |
|---|---|---|
| `Game` (everything in 3.2) | `games/{gameId}` (one document) | Includes `cards` registry, `history` (id-only summaries) and `votes`. Estimated worst case: 10 players, 180 written cards, about 90 rounds: well under 1 MiB. Spectator votes are the bounded-by-cap part (`MAX_VOTES`, open question 9). |
| `Draft` per player | `games/{gameId}/drafts/{playerId}` | The Engine never holds drafts in `Game` (this revises the HLD sketch, which lists `drafts[]` on the aggregate; tech-stack section 5 already stores them separately). The app reads the actor's draft doc inside the transaction and passes it in `ctx.drafts`. |
| `RoundRecord` | `games/{gameId}/rounds/{n}` | Returned in `Accepted.roundRecords` by `pickWinner` only. Never edited (S3). |
| Domain events | `games/{gameId}/events/{version}` | One document per accepted command with `aggregateChanged: true` (so versions are contiguous with the aggregate version, no gaps; `events` may be empty for a `markReminded` or a count-only `saveDraft`). Holds `{version, at, commandType, events[]}` plus `seed` and `actorPlayerId?`, except for `finishWriting`, `importDeck` and `writeIn`, whose EventDoc omits both `seed` and `actorPlayerId` (C-EV, E8). A `writeIn` EventDoc records `commandType: "confirmSubmission"`, so no stored doc marks a submission as a write-in (K-A). |
| `Draft` changes | the drafts doc | Returned as `Accepted.draftChanges` (`draft: null` = delete). |

`writeProgress` (counts in the draft) is mirrored on the aggregate so the host and the player's own view can show "cards still to write" without reading drafts. `saveDraft` therefore bumps the aggregate only when the counts change (typing and editing existing cards does not), which avoids a view fan-out per keystroke-save. All other `saveDraft` effects go to the drafts doc.

### 4.2 Scheduler denormalization (T1, T3)

The Engine maintains four top-level fields in `settle` (section 8.2) after every accepted command:

| Field | Meaning |
|---|---|
| `waitingOn` | In `WRITING`: seated players with status `writing` (not yet finished writing). In `SUBMITTING`: `expected` players with no submission. In `JUDGING`: `[judgeId]` (`[]` if `judgeId` is null). In `PLAYING` (either round phase) it also includes every seated player with status `writing` (late joiners still writing). Else `[]`. Computed even while paused (the UI shows it). This is the single definition (K-E); LLD 3 and LLD 6 refer to it. |
| `episode` | Opaque key of the current wait: `"writing"` in `WRITING`, `"{round}:{roundPhase}:{judgeId}"` in `SUBMITTING`/`JUDGING`; `null` when paused, or when `waitingOn` is empty, or in any other phase. |
| `episodeGen` | Incremented each time a new episode starts (the triggers below, including un-pause), never otherwise. Distinguishes successive episodes with the same key (`"writing"` before and after a pause, or a voided round reopened with the same number and judge). Reminder rows and the sweep compare `(episode, episodeGen)`, not the key alone. |
| `waitingSince` | `ctx.now` when the episode last started (in `WRITING`: when writing started or play un-paused); `null` when `episode` is `null`. A late joiner with status `writing` joins `waitingOn` in any phase (`WRITING` or `PLAYING`) without changing the episode, `episodeGen` or `waitingSince` of anyone else, so they are included in the next reminder but get no push (they are already in the app). |
| `reminderDueAt` | `waitingSince + REMINDER_INTERVAL_MS` (24 h) when an episode starts; `markReminded` then advances it to `ctx.now + REMINDER_INTERVAL_MS` (7.4); `null` when `episode` is `null`. |

A new episode starts on: writing start, round open, close (to `JUDGING`), judge change, void, and un-pause. `rules/waiting.ts` `waitingFields(game, now, episodeStarted)` implements the table: an episode starts when the caller says so (`episodeStarted`: a void or reopen can repeat the key) or when the computed key differs from the stored `episode` (which covers writing start, un-pause, open, close and judge change by themselves); `episodeGen` rises by one exactly then. A player submitting or finishing writing, or a late joiner joining or finishing, changes `waitingOn` but not the episode, so the reminder clock is not reset. The scheduler query is `reminderDueAt <= now` on a single-field index with no `paused` or `phase` filter; since `reminderDueAt` is non-null only while the game is waiting on someone (aggregate `phase` `WRITING` or `PLAYING`, not paused), it is already exact (LLD 3 section 7).

The Scheduler never writes these fields itself (HLD T1). Advancing `reminderDueAt` after a reminder is the Engine's system command `markReminded` (7.4), run through the ordinary command transaction; it emits no domain event, and when it changes the aggregate the Store writes one `Reminder` outbox row in the same transaction (LLD 3 section 7), which LLD 6 delivers.

## 5. `decide`: signature, ports, ordering

### 5.1 Signature

```ts
declare function decide(state: Game | null, cmd: Command, ctx: Ctx): Result<Accepted, Rejection>;
// state is null only for createGame; any other command with null state returns NOT_FOUND.

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

interface Ctx {
  now: number;                 // epoch ms; the only time input (T3)
  rng: Rng;                    // per-command, seeded by the caller; shuffles and the first judge only
  mintId: () => CardId;        // CSPRNG-backed, non-replayable; the only source of card ids (section 5.2)
  actor: Actor;
  drafts: GameDrafts;          // read-only snapshot of draft docs the command may need (only the actor's, for saveDraft/finishWriting)
}
type Actor = { kind: "user"; uid: Uid } | { kind: "system" };   // system only for markReminded

interface Accepted {
  state: Game;                 // new state; version = old + 1 iff aggregateChanged
  aggregateChanged: boolean;   // false only for a saveDraft that changed no counts
  events: DomainEvent[];       // section 11
  draftChanges: { playerId: PlayerId; draft: Draft | null }[];
  roundRecords: RoundRecord[];
  seed: string;                // ctx.rng.seed
  redactEnvelope: boolean;     // true for finishWriting, importDeck, writeIn: the app writes neither seed nor actorPlayerId to the EventDoc (C-EV)
  deleteGame?: true;           // deleteGame only: the app must perform S5 instead of committing state
}
```

- `decide` never throws for any input (X1); malformed payloads yield `INVALID_ARGUMENT`. Internal invariant violations (a bug, for example the green deck empty) throw `EngineInvariantError`; the app maps that to an internal error and nothing commits.
- `decide` never mutates `state`, `cmd` or `ctx` (X4). It returns structurally shared copies; tests deep-freeze inputs.
- On rejection nothing else is returned: no partial state (E1, E2).

### 5.2 The `Rng` port

```ts
interface Rng {
  readonly seed: string;
  int(maxExclusive: number): number;          // uniform in [0, max), rejection-sampled, no modulo bias
  shuffle<T>(xs: readonly T[]): T[];          // Fisher-Yates, returns a new array
}
declare function makeRng(seed: string): Rng;  // xmur3(seed) -> sfc32; pure, no globals
```

`int(1)` is 0 and consumes no draw; an invalid maximum (not an integer in 1 to 2^32) throws `EngineInvariantError`. `rngFromRaw(seed, nextU32)` is the same sampling over any raw uint32 source, so tests pin rejection sampling and the draw order with a scripted source; golden vectors in `test/rng.test.ts` pin the `makeRng` stream as a regression pin (the in-test reference is a copy of the implementation, not an independent check; the literals were generated by the same algorithm).

- The application layer draws a fresh 128-bit seed per request from a CSPRNG (outside the Engine), calls `makeRng(seed)`, and stores `seed` in the EventDoc for commands that mint no card ids. Replaying `decide(stateBefore, cmd, {now, rng: makeRng(seed), ...})` reproduces the shuffle order and the first judge exactly (debugging). Card ids are not reproducible: they come from `ctx.mintId()`, a separate CSPRNG port the application supplies, whose output is never stored with a seed. For `finishWriting`, `importDeck` and `writeIn` (the commands that mint ids), the EventDoc omits `seed` and `actorPlayerId` entirely, because a replayable shuffle of a pool with a known appended batch would reveal which cards that actor wrote (E8). The command payload (which can hold card text) is deliberately not logged either, so reproducing needs the payload from the client or the idempotency ledger.
- Consumption order is part of the contract (tests pin it): within a command, draws happen in the order the algorithms in section 8 list them. A command that does not shuffle or mint ids never touches `rng`.
- Uses: deck shuffles (`beginPlay`, `finishWriting`, red reshuffle, returned hands and score piles), first judge (`rng.int(active.length)` over actives sorted by `joinOrder`), `revealOrder` at close. Nothing else is random.
- A second implementation of `Rng` for tests (`scriptedRng`) returns predetermined values, and tests supply a counter-based `mintId`, to build specific scenarios.

### 5.3 Guard order (fixed, for testability and non-leakage)

Every command runs these checks in this order; the first failure is the rejection.

0. **Known command.** A `cmd` that is not an object, or whose `type` is not a registered command (an own key of the registry), is `INVALID_ARGUMENT`, before anything else, so a junk command learns nothing about the state (not even `NOT_FOUND`).
1. **Existence and terminal state.** `state === null` (non-create) is `NOT_FOUND`. `ENDED` rejects everything except `deleteGame` with `WRONG_PHASE` (no detail). The command that creates the aggregate (`createGame`) takes a different path: a non-null state is `WRONG_PHASE` (no detail), then only steps 2, 7 and 8 apply.
2. **Actor class.** Is the actor eligible for this command at all (host-only, seated-only, anyone)? Else `NOT_AUTHORIZED`. A non-member learns nothing else.
3. **Staleness.** If `cmd.expectedVersion` is present, the command is a round command (`confirmSubmission`, `writeIn`, `closeSubmissions`, `pickWinner`, `passJudging`) and `state.round` exists and `expectedVersion < state.round.changedAtVersion`, return `STALE`. A missing or non-integer `expectedVersion` (absent, NaN, a fraction, a string) is skipped at this guard (not stale); for the stale-checked commands, which the contracts envelope requires it for, guard 7 rejects it (payload, `INVALID_ARGUMENT`, in #22), so it cannot bypass `STALE`. A bare "other players moved" version bump does not make a command stale; only a change to the round's judge, phase or voiding does (the HLD's example: the host passed judging). As built (1.8), `removeCard` also bumps it when it removes a revealed play or replaces the current green card (8.6): a judge looking at a changed reveal list or a new green is stale. Eviction removing a submission does not (8.5 step 1).
4. **Phase** (`WRONG_PHASE`).
5. **Pause** (`PAUSED`) for commands marked "needs play" in 7.1.
6. **Fine role** (judge vs non-judge, roster membership): `NOT_AUTHORIZED`.
7. **Payload shape and ranges**: `INVALID_ARGUMENT`.
8. **Moderation**: `CONTENT_REJECTED` (detail carries the reason code, never the matched word).
9. **State preconditions**: `NOT_IN_HAND`, `ALREADY_SUBMITTED`, `NAME_TAKEN`, `ROOM_FULL`, `NOT_FOUND`, `NOT_PLAYABLE`, `VARIANT_UNAVAILABLE`.

Rejections never reveal hidden state (HLD 4.3): `pickWinner` with an unknown id and with an id not in this round both return `NOT_FOUND` with no detail; `confirmSubmission` with a card the player does not hold returns `NOT_IN_HAND` whether the card exists elsewhere or not.

```ts
type ErrorCode = /* HLD 4.3 */ "NOT_AUTHORIZED" | "WRONG_PHASE" | "STALE" | "NOT_IN_HAND" | "ALREADY_SUBMITTED"
  | "ROOM_FULL" | "NAME_TAKEN" | "CONTENT_REJECTED" | "PAUSED" | "RATE_LIMITED" | "NOT_FOUND"
  /* PROPOSED additions, open question 1 */ | "NOT_PLAYABLE" | "INVALID_ARGUMENT" | "VARIANT_UNAVAILABLE";
interface Rejection { code: ErrorCode; detail?: string }   // detail: a short fixed enum string, never hidden state
```
This `Rejection` is the Engine's own and is not the wire `Rejection` of `@dc/contracts` (which adds `ok`, `version`, `sv` and `retryAfterMs`; LLD 5 maps one to the other). `ErrorCode` and the closed `detail` sets (`DETAIL_BY_CODE`) are the contracts'; `reject(code, detail?)` in `errors.ts` builds a rejection with the detail typed per code, so a detail that does not belong to its code fails `tsc`.
`RATE_LIMITED` is never produced by the Engine.

### 5.4 Time (T3)

`ctx.now` is read only to write: `createdAt`, `Round.openedAt`, `RoundRecord.resolvedAt`, `waitingSince`, `reminderDueAt`. `REMINDER_INTERVAL_MS = 86_400_000` is an Engine constant. No guard, transition or selection depends on `now` (X5: two runs with different `now` produce equal states after zeroing those five fields).

### 5.5 Registry and `CommandSpec` (1.2)

`decide = makeDecide(REGISTRY)`. `registry.ts` holds one row per command, added by the step that implements it; the registry holds the five lobby commands since 1.3 (#20) and `startGame`, `saveDraft` and `finishWriting` since 1.4 (#21), and `confirmSubmission`, `closeSubmissions` and `pickWinner` since 1.5 (#22), `passJudging` and `endGame` since 1.6 (#23), `markReminded` since 1.7 (#24) and `removeCard` since 1.8 (#25); `writeIn`, `redraw` and `castVote` are M7 (steps 7.2 to 7.4), `importDeck` is M9 and `deleteGame` is M3 (#36, with the cascade); none is an M1 step, so they stay unregistered until then (guard 0, `INVALID_ARGUMENT`) and the E16, heavy-redraw X6, castVote-X9, importDeck and accept-half-of-E15 proofs move with them (see #54, deferred proofs); the pipeline's ladder is also proved with fixture specs through `makeDecide(fixtureRegistry)`. A row maps the guard ladder of 5.3 to members: `actor` (2), `stale` (3, the round commands), `phases` and `phase` (4), `needsPlay` (5), `role` (6), `payload` (7), `moderation` (8), `preconditions` (9), and `handle`. `handle` returns `{state, events, draftChanges, roundRecords, redactEnvelope, aggregateChanged}` (optionally `deleteGame` and `episodeStarted`); `decide` then runs `settle` with `ctx.now` and `ctx.rng` and bumps `version` once, so handlers set `round.changedAtVersion = state.version + 1` and never touch `version`. Guard 2 runs before the payload is validated, so it reads `cmd` fields only defensively. `createGame` is a `CreateSpec` (no state, guards 2, 7 and 8; the handler returns `version: 0` and `decide` sets 1). There is no catch-all `try/catch` in `decide`: only `EngineInvariantError` may escape, from a handler or a port.

## 6. Roles

```ts
interface Roles {
  host: boolean;                 // actor.uid === game.hostId
  playerId: PlayerId | null;     // the seated (not left/removed) player whose uid matches
  status: PlayerStatus | null;
  judge: boolean;                // playerId === round.judgeId
  spectator: boolean;            // no seat; includes departed players and the host without a seat
}
declare function actorRole(game: Game, actor: Actor): Roles;
declare function seatUid(gameId: GameId, playerId: PlayerId): Uid;   // `seat:${gameId}:${playerId}` (tech-stack section 4; LLD 4 ratifies)
```

- The system actor (`markReminded`) has no seat and is not a host; it is not a `spectator` either (`spectator` means a user without a seat).
- Resolution is by `uid` only, exactly as tech-stack section 4: the host's seat has `uid = hostId`, so one uid gives `host: true` and `playerId` set. Host powers never depend on having a seat (the host may `leave` as a player and still run the game).
- A rejoin on a new device keeps the same uid (LLD 4), so no Engine concept of sessions exists.
- `join` is the one command whose actor is not yet a member: the application mints `playerId` and the seat uid first, and the Engine requires `actor.uid === seatUid(game.id, payload.playerId)` (else `NOT_AUTHORIZED`). The Engine therefore stays free of id generation for players while still preventing a caller from joining under someone else's uid.

## 7. Commands

Payload types (the contracts LLD turns these into zod). Every command also carries `expectedVersion?: number` and the app's envelope fields, which the Engine ignores except `expectedVersion`.

```ts
type Command =
  | { type: "createGame"; gameId: GameId; roomCode: string; hostId: Uid; hostPlayerId: PlayerId; hostName: string; settings?: Partial<Settings> }
  | { type: "updateSettings"; patch: Partial<Settings> }
  | { type: "join"; playerId: PlayerId; name: string }
  | { type: "leave" }
  | { type: "removePlayer"; playerId: PlayerId }
  | { type: "removeCard"; cardId: CardId }
  | { type: "importDeck"; red: string[]; green: string[] }            // seam, section 13
  | { type: "startGame" }
  | { type: "saveDraft"; red: string[]; green: string[] }
  | { type: "finishWriting" }
  | { type: "confirmSubmission"; cardId: CardId; pitch?: string }
  | { type: "writeIn"; text: string; pitch?: string }
  | { type: "redraw" }
  | { type: "closeSubmissions" }
  | { type: "pickWinner"; submissionId: SubmissionId }
  | { type: "passJudging" }
  | { type: "castVote"; round: number; submissionId: SubmissionId }
  | { type: "endGame" }
  | { type: "deleteGame" }
  | { type: "markReminded"; episode: string; episodeGen: number };      // system only, section 7.4
```

### 7.1 Command table

"Needs play" = rejected with `PAUSED` while `game.paused` in `PLAYING`. Rejections listed are in addition to the universal `NOT_FOUND` (null state), `WRONG_PHASE` (ENDED), and `STALE`.

| Command | Actor | Phases | Extra preconditions and rejections |
|---|---|---|---|
| `createGame` | `uid === hostId` | (state null) | Host name passes Moderation as `name` under the mode the new game gets (`CONTENT_REJECTED`; guard 8, 1.8 #25; the cleaned name is stored); settings in range, ids well-formed, and no `writeCountsOverride` (no deck exists yet) (`INVALID_ARGUMENT`). A non-null state: `WRONG_PHASE`, no detail (decided 1.2) |
| `updateSettings` | host | LOBBY: any key. WRITING, PLAYING: `profanity` only | Other keys outside LOBBY: `WRONG_PHASE`. Ranges: `INVALID_ARGUMENT`. `writeCountsOverride` requires an imported deck: `INVALID_ARGUMENT`. A patch that names `variants` or `spectators` replaces that nested object wholesale (not merged key by key), so the patch must carry the whole object |
| `join` | uid = seatUid | LOBBY, WRITING, PLAYING | Guard 9 order: `NAME_TAKEN` (case-insensitive after normalization, among seated), then `ROOM_FULL` if seated >= 10 (no detail), then `ROOM_FULL` detail `join_cap` if `totalJoins >= MAX_TOTAL_JOINS` (50, from `@dc/contracts`); `CONTENT_REJECTED` (guard 8, 1.8 #25, runs before `NAME_TAKEN`; `NAME_TAKEN` compares `nameKey`, the Moderation fold with whitespace removed); FINISHED: `WRONG_PHASE`. A `playerId` that has any record (seated, or left or removed mid-game: a departed id never comes back, so one id is one record), a malformed id or a non-string name: `INVALID_ARGUMENT` |
| `leave` | seated player | LOBBY, WRITING, PLAYING | Evicts the actor (8.5). FINISHED: `WRONG_PHASE` |
| `removePlayer` | host | LOBBY, WRITING, PLAYING | Target must be seated (`NOT_FOUND`); evicts (8.5). Host may remove their own seat |
| `removeCard` | host | LOBBY, WRITING, PLAYING | Unknown id, or a card that has not been shown to the table (8.6): `NOT_FOUND`, no detail (the two cases are indistinguishable, so hidden cards are not probeable). Would drop totals below `G_min`/`R_min` at current N, once the game is past LOBBY: `NOT_PLAYABLE` (detail `below_minimum`) |
| `importDeck` | host | LOBBY | Only when no card exists yet (`NOT_PLAYABLE` otherwise); all texts pass Moderation as `card` (`CONTENT_REJECTED`, whole batch) |
| `startGame` | host | LOBBY | seated >= 3 and playability resolvable (`NOT_PLAYABLE`, detail `players` or `minimums`) |
| `saveDraft` | seated, status `writing` | WRITING, PLAYING (late joiner) | Counts <= `writeTarget` (`INVALID_ARGUMENT`); every text passes Moderation as `card` (`CONTENT_REJECTED`). Status `ready`: `WRONG_PHASE` (detail `finished`) |
| `finishWriting` | seated, status `writing` | WRITING, PLAYING (late joiner) | Draft counts equal `writeTarget` exactly (`NOT_PLAYABLE`, detail `incomplete`) |
| `confirmSubmission` | seated, non-judge, in `round.roster` | PLAYING/SUBMITTING | Needs play. Not in roster: `NOT_AUTHORIZED` (detail `sitting_out`). Already submitted: `ALREADY_SUBMITTED`. Card not in own hand: `NOT_IN_HAND`. A blank pitch is no pitch; otherwise Moderation `pitch` (guard 8: `CONTENT_REJECTED` incl. `TOO_LONG` over 140 code points) runs before `VARIANT_UNAVAILABLE` (guard 9) for a pitch with the variant off |
| `writeIn` | as `confirmSubmission` | PLAYING/SUBMITTING | Needs play. Variant on and unused (`VARIANT_UNAVAILABLE`); `ALREADY_SUBMITTED`; Moderation `card` |
| `redraw` | seated active, no submission | PLAYING/SUBMITTING | Needs play. Variant on and unused (`VARIANT_UNAVAILABLE`); has submission: `ALREADY_SUBMITTED` |
| `closeSubmissions` | judge or host | PLAYING/SUBMITTING | Needs play. Zero submissions: `NOT_PLAYABLE` (detail `no_submissions`) |
| `pickWinner` | judge | PLAYING/JUDGING | Needs play. `submissionId` not in `revealOrder`: `NOT_FOUND` |
| `passJudging` | host | PLAYING (SUBMITTING or JUDGING) | Needs play |
| `castVote` | seated player, or spectator if allowed | PLAYING, FINISHED | Variant on (`VARIANT_UNAVAILABLE`); `votes.length >= MAX_VOTES` (1500, from `@dc/contracts`) and this voter has no existing vote for the round (a replacing vote is allowed): `VARIANT_UNAVAILABLE`, detail `vote_cap`; spectator voting off for non-seated actor (`NOT_AUTHORIZED`); `(round, submissionId)` not in `history` (`NOT_FOUND`); own card (`NOT_AUTHORIZED`, detail `own_card`) |
| `endGame` | host | LOBBY, WRITING, PLAYING, FINISHED | Always accepted from these phases |
| `deleteGame` | host | any phase including ENDED | Authorization only; see 7.3 |
| `markReminded` | system | WRITING, PLAYING | `episode` must equal `state.episode`, `episodeGen` must equal `state.episodeGen`, and `now >= reminderDueAt`, else accepted as a no-op (`aggregateChanged: false`, nothing written). As built (1.7, #24): also a no-op while `paused` or with an empty `waitingOn`; not a round command (no `STALE`, no `PAUSED`); LOBBY, FINISHED and ENDED are `WRONG_PHASE`; a malformed `episode` (not a string) or `episodeGen` (not a non-negative integer) is `INVALID_ARGUMENT`; a user actor is `NOT_AUTHORIZED` (guard 2, before the payload), except that in an ENDED game guard 1 answers `WRONG_PHASE` first, for any actor |

Notes on the table:
- **As built (1.3 #20, widened by 1.6 #23):** `join`, `leave` and `removePlayer` are `phases: ["LOBBY", "WRITING", "PLAYING"]` (FINISHED and ENDED are `WRONG_PHASE`). In LOBBY the host may `leave` (the seat record is deleted; host powers rest on `hostId`) and may `removePlayer` their own seat. The name key behind `NAME_TAKEN` is `nameKey` (the Moderation `normalize` of the whitespace-stripped cleaned name, 1.8 #25); `createGame` and `join` run guard 8 and store the cleaned name. `updateSettings` enforces "`writeCountsOverride` requires an imported deck" as "the card registry is non-empty" (`importDeck` lands in M9); a patch with no keys is accepted as `SettingsUpdated{keys: []}`; unknown patch keys are ignored.
- **As built (1.4, guard 8 since 1.8 #25):** `saveDraft` moderates every text of every call (red then green, the first failure is the rejection; a blank text is `CONTENT_REJECTED` `EMPTY`) and stores the cleaned form (NFC, trim, collapsed whitespace). `finishWriting` does not re-run Moderation (M2), so what `saveDraft` stored goes straight into the pool. Guard 2 for `saveDraft` and `finishWriting` is "seated" (any non-departed seat); a `ready` or `active` seat is `WRONG_PHASE` detail `finished` (guard 4, after the phase list), and the system actor, a spectator and a host without a seat are `NOT_AUTHORIZED`. A seat with no `writeTarget` may save nothing (`INVALID_ARGUMENT` on any non-empty draft) and can never finish (`NOT_PLAYABLE` `incomplete`). The PLAYING late-joiner paths of `saveDraft` and `finishWriting` are reachable since 1.6 (#23) through the widened `join`.
- **As built (1.5, pitch guard 8 since 1.8 #25):** the three round commands are `phases: ["PLAYING"]`, `stale` and `needsPlay`. Guard 2: `confirmSubmission` and `pickWinner` need a seat (any non-departed one), `closeSubmissions` a seat or the host; a stranger, a spectator, the system actor and an unseated host are `NOT_AUTHORIZED` and learn nothing else, and a seated non-judge with a stale version gets `STALE`. Guard 4: a missing round or the wrong round phase is `WRONG_PHASE` (so a repeat `pickWinner` of a resolved round is `WRONG_PHASE`, or `STALE` when it still carries the old `expectedVersion`, because guard 3 runs first). Guard 6: the judge is `NOT_AUTHORIZED` (no detail) for `confirmSubmission`; a seat that is not on `round.roster` is `NOT_AUTHORIZED` `sitting_out`; `closeSubmissions` is the judge or the host; `pickWinner` the judge only (a host who is not the judge is `NOT_AUTHORIZED`). Guard 7: `expectedVersion` is required and must be an integer (all three, matching the contracts envelope; absent, NaN, Infinity and fractions are `INVALID_ARGUMENT`, only after guards 2 to 6), `cardId` and `submissionId` must be strings, `pitch` a string of at most 140 code points after trimming (`TEXT_LIMITS.pitch`, counted as `[...trimmed].length`, not UTF-16 units). Guard 9: `ALREADY_SUBMITTED`, then `NOT_IN_HAND` (one rejection for an unknown card, another player's card, a deck card, the round's green card or a malformed id), then `VARIANT_UNAVAILABLE` for a pitch when `variants.pitch` is off; `closeSubmissions` with no submission is `NOT_PLAYABLE` `no_submissions`; `pickWinner` with an id not in `revealOrder` is `NOT_FOUND` with no detail, identical for an unknown id and an id of another round. A **pitch** is stored cleaned on the `Submission`; a blank pitch counts as no pitch (a ruling in #22) and skips Moderation, and it is copied into `RoundRecord.playsDetail` and into no event, no `history` entry and no state outside the open round. Since 1.8 (#25) an over-long pitch is `CONTENT_REJECTED` `TOO_LONG` at guard 8 (even with the variant off), and guard 7 keeps only the shape (a string). `writeIn`, `redraw` and `castVote` are M7, `importDeck` is M9 and `deleteGame` is M3 (#54, deferred proofs): until they register they are `INVALID_ARGUMENT` at guard 0. The commands set `round.changedAtVersion = version + 1` only when the round's phase or judge changes (a close or a new round), never on a plain confirm.
- Event docs and versions (decided, P-E2/P-E3): every accepted command with `aggregateChanged: true` writes one `events/{version}` doc, including `markReminded` and a count-only `saveDraft`, whose `events` is `[]`. Versions are therefore contiguous with the aggregate version and `events/` has no gaps. Commands with `aggregateChanged: false` write no event doc and take no version.
- `saveDraft` row: any player with status `writing` may save, in `WRITING` or (a late joiner) in `PLAYING`; a player with status `ready` calling `saveDraft` gets `WRONG_PHASE` (detail `finished`) in either phase. Finished writing is final for v1. `saveDraft` does not need play, so it works while paused.
- **As built (1.6, #23):** `join` in WRITING or PLAYING records `writeTarget = lateJoinerRequirement(game, seated + 1)` (9.4) on the new `writing` seat; the name, room and join-cap checks are unchanged. `leave` and `removePlayer` outside LOBBY run `evictPlayer` (8.5) and emit `PlayerLeft` or `PlayerRemoved` first, then the eviction's side effects (`JudgeChanged`); the host may remove their own seat and every later host command still works (it rests on `hostId`). `passJudging`: guard 2 host only (the judge, a player, a stranger and the system are `NOT_AUTHORIZED`), 3 `stale`, 4 PLAYING with a round (`WRONG_PHASE`), 5 needs play (`PAUSED`), 7 an integer `expectedVersion` (`INVALID_ARGUMENT`); it runs `reassignJudge("passed")` and starts a new waiting episode. `endGame`: host only, phases LOBBY, WRITING, PLAYING, FINISHED, no further preconditions, works while paused. Q1 to Q7 of the #23 plan are ruled in 7.2, 8.2, 8.3 and 8.5.
- E15: in FINISHED only `castVote`, `endGame`, `deleteGame` are accepted. `castVote` in FINISHED deviates from E15's literal text so the final round can be voted on (open question 4).

### 7.2 Effects and events per command

Events are named in section 11. "Settle" is the post-step in 8.2, run after every aggregate-changing command.

| Command | State effects | Events (in order) |
|---|---|---|
| `createGame` | Game in LOBBY, `version = 1`, host seated as `joinOrder 0`, status `writing`, `writeTarget: null`; defaults for `settings` (profanity `on`, all variants off, spectators off) | `GameCreated` |
| `updateSettings` | Shallow merge of the patch: top-level keys replace, so nested `variants` and `spectators` objects are replaced, not merged (a `null` target override clears it) | `SettingsUpdated{keys}` |
| `join` | `totalJoins += 1`. Append player, `joinOrder = max(totalJoins, every joinOrder so far) + 1` (so an order is never reused after a LOBBY leaver's record is deleted), status `writing`. In LOBBY `writeTarget: null`. In WRITING or PLAYING `writeTarget = lateJoinerRequirement` (9.4) | `PlayerJoined{playerId}` |
| `leave`, `removePlayer` | `evictPlayer` (8.5); in LOBBY the player record is deleted instead. `draftChanges` holds a null draft only for an evicted `writing` seat (Q7: a ready or active seat has no draft document) | `PlayerLeft{playerId}` or `PlayerRemoved{playerId}`, then the evict side-effect events (`JudgeChanged`; `RoundVoided`/`RoundOpened`, `PausedChanged`, `PlayStarted` and the rest come from settle) |
| `removeCard` | Only for a card shown to the table (8.6). Delete from registry and from whichever zone holds it (`removeCardFromGame`); special cases in 8.6; an emptied JUDGING round is voided by settle slot 4 | `CardRemoved{cardId, kind}` (+ `RoundVoided`/`JudgeChanged` side effects) |
| `importDeck` | Mint ids, add to `redDeck`/`greenDeck`, shuffle | `DeckImported{red, green}` (counts) |
| `startGame` | `phase = WRITING`; `target = targetOverride ?? defaultTarget(N)`; `writeCounts` per 9.3; every seated player gets `writeTarget = writeCounts`; players whose target is `{0,0}` become `ready`. A `writeCounts` result of `"invalid"` is `INVALID_ARGUMENT` at guard 7, ahead of the player count (guard 9); `"unmet"` is `NOT_PLAYABLE` `minimums`, after `players` | `WritingStarted{target, writeCounts}` (episode `"writing"` starts in settle); if all ready, settle emits the play-start events |
| `saveDraft` | Return `draftChanges` replacing the draft (texts cleaned by Moderation, 12); update `writeProgress`; `aggregateChanged` only if the counts differ from `Player.writeProgress` (not from the stored draft document), in which case the version bumps and `events` is `[]` | none (settle may still emit `PausedChanged`) |
| `finishWriting` | Mint ids for draft cards (red then green, in draft order, each registered before the next), register them in `cards` (rebuilt in sorted-key order, 3.1), append to decks, **reshuffle both decks** (`rng`, red then green, unconditionally), `status = ready`, `writeProgress = writeTarget`, `draftChanges: [{playerId, null}]`, `redactEnvelope: true`. The draft is read from `ctx.drafts[actor]`, never from `writeProgress`; a missing or malformed draft counts as empty | `PlayerFinishedWriting{playerId}`, then (when this was the last writer) the play-start events from settle |
| `confirmSubmission` | Remove card from hand, append `Submission`; if `expected` all submitted, settle closes the round | `SubmissionConfirmed{round, playerId}` (+ `SubmissionsClosed` from settle) |
| `writeIn` | Mint red card, register, append `Submission{..., writeIn: true}` directly (never enters a hand), `powerUsage.writeIn = true`; same follow-up as above | `SubmissionConfirmed{round, playerId}` (identical to a hand play; K-A) |
| `redraw` | Hand to `redDiscard`; draw 7 (8.4); `powerUsage.redraw = true` | `HandRedrawn{playerId}` |
| `closeSubmissions` | `closeRound("closed")` (8.3) | `SubmissionsClosed{round, judgeId, reason: "closed"}` |
| `pickWinner` | `resolveRound` (8.3) | `WinnerPicked`, then `GameFinished` or `RoundOpened`; plus `PlayerActivated`s |
| `passJudging` | `reassignJudge(reason: "passed")` (8.3) | `JudgeChanged{...}` (+ `RoundVoided`/`RoundOpened` in the void case) |
| `castVote` | Upsert `Vote` keyed `(round, voter)` | `VoteCast{round, voterKind}` |
| `endGame` | `abortRound` (hand-played submissions back to owners' hands, write-in submissions to `redDiscard`, green card back to green deck bottom), `phase = ENDED`, `round = null`, `paused = false` (set by the handler, so no `PausedChanged` is emitted, Q4), waiting fields cleared by settle step 5 | `GameEnded` only |
| `deleteGame` | state unchanged | `GameDeleted` |
| `markReminded` | `reminderDueAt = now + REMINDER_INTERVAL_MS`; `version` bumps; `episode`, `episodeGen`, `waitingSince` unchanged | none (the EventDoc is still written, with `events: []`; the Store adds one `Reminder` outbox row, 7.4) |

### 7.3 `deleteGame`

The Engine authorizes (host only, any phase) and returns `deleteGame: true` with `GameDeleted`; it does not remove anything. The application must perform S5 (aggregate, events, outbox, idem, pushSubs, seat Auth users) and must not commit the returned state.

### 7.4 `markReminded`

Adopted design (LLD 3 section 7, accepted by LLD 6). The Scheduler holds no game logic and never writes game fields (HLD T1); for each due game the sweep runs `markReminded{episode, episodeGen}` with `{kind: "system"}` through the ordinary command transaction, so the write is serialized with player commands. When `episode` and `episodeGen` match the state and `now >= reminderDueAt`, the Engine sets `reminderDueAt = now + REMINDER_INTERVAL_MS` (so each reminder is at least 24 h after the previous due time, since `now >= reminderDueAt`), bumps `version` (E3) and returns `events: []`: there is no domain event, so no view fan-out and no event-driven notification. Because the aggregate changed, the Store writes, in the same transaction, the EventDoc with `events: []` and exactly one `Reminder` outbox row (episode, `episodeGen`, due time consumed, `waitingOn`), which LLD 6 delivers; the advance and the send intent commit together or not at all. A mismatch or a not-yet-due call is a no-op (`aggregateChanged: false`): nothing is written, not even a row.

**As built (1.7, #24)**, `commands/waiting.ts`: the handler returns the state unchanged with `aggregateChanged: false` unless the stored `episode` is non-null and equals the command's, `episodeGen` equals, the game is not paused, `waitingOn` is non-empty and `ctx.now >= reminderDueAt`; then it sets `reminderDueAt = ctx.now + REMINDER_INTERVAL_MS` and returns `aggregateChanged: true`, `events: []`. Settle runs as for any aggregate change and keeps the advance (the key is unchanged, so slot 5 keeps `waitingSince`, `episode` and `episodeGen`). The paused and empty-`waitingOn` clauses are unreachable from a settled state (the episode is null then) and exist so a hand-built or stale state cannot be advanced. The sweep must treat `WRONG_PHASE` and `NOT_FOUND` (the game was deleted) from this command as benign (the game moved on after the sweep read it); `NOT_AUTHORIZED` never occurs for the system actor.

## 8. Rules and algorithms

### 8.1 State machine

```
LOBBY --startGame (host, N>=3)--> WRITING
WRITING --all seated ready & N>=3 & minimums--> PLAYING            (automatic, in settle)
PLAYING: round SUBMITTING --(all expected in | close | pass)--> JUDGING --pickWinner--> next round SUBMITTING
PLAYING --winner reaches target--> FINISHED
LOBBY | WRITING | PLAYING | FINISHED --endGame--> ENDED
```

`paused` (stored, derived, recomputed by settle): `phase == PLAYING ? active.length < 3 : phase == WRITING ? seated.length < 3 : false`. `PausedChanged{paused}` is emitted when it flips. While `paused` in `PLAYING`, "needs play" commands return `PAUSED`; membership, drafts, host controls, `castVote` and `endGame` still work. Nobody is notified when a pause begins. Un-pausing (`PausedChanged{paused:false}`) notifies the players the game is waiting on (11.1).

### 8.2 `settle` (runs after every aggregate-changing command, before `version` is bumped)

Applied in this order; each step may emit events; the whole is deterministic in `rng` consumption. `settle.ts` names the slots `1`, `2`, `3`, `3a`, `4`, `5` in an ordered list (`SETTLE_SLOTS`, run by `runSlots`); each takes the state and `{rng, now, episodeStarted}` and returns `{state, events, episodeStarted?}`, and a slot that starts an episode raises `episodeStarted` for slot 5. Slots 2 and 5 are real since 1.2 and slot 1 since 1.4 (when every seated player is ready but the minimums fail at the frozen target, slot 1 does nothing and the game stays in WRITING; 1.6 added the test, `test/stalls.test.ts` V11, which passes against the 1.4 code because the slot already made the check) (#21: `beginPlay`, with `openRound`, `nextJudge`, `draw`, `topUp` and `activateReady`, all in `rules/`); slot 4 since 1.5 (#22: `closeRound`, `resolveRound`, `voidRound`). **Deviation (decided in #22, a change from the earlier wording that gave slots 3 and 3a and `reassignJudge` to #22):** slots 3 and 3a and `reassignJudge` pair with `passJudging` and eviction, so they were left to 1.6 (#23) and are real since then, with their ids and order unchanged. **Q1 (ruled in #23):** `settle` drops `PausedChanged` events that cancel to no net change against the stored `paused` (slot 2 pausing an unpaused game that slot 3 then recovers in the same command, the typical case being an eviction that leaves two active players and one ready), and reports one event when there is a net change, so the log never says "paused" and "resumed" for one command. Slot 4's loop is capped (`MAX_ADVANCE_STEPS`, 16, overridable by `SettleEnv.maxAdvanceSteps`, which tests exercise by calling the slot directly; `settle` does not plumb it): a step beyond the cap throws `EngineInvariantError` instead of hanging.

1. **Begin play.** If `phase == WRITING`, `target` and `writeCounts` are set, `seated.length >= 3`, every seated player is `ready`, and `meetsMinimums(totals, N, target)` (9.2): run `beginPlay` (8.7) and raise `episodeStarted` (the first round is a new episode). A null `target` or `writeCounts` (a state that never went through `startGame`) skips the slot, so settle stays total.
2. **Pause flag.** Recompute `paused` (8.1); emit `PausedChanged` on change.
3. **Recovery activation** (as built, 1.6). If `PLAYING` and `paused` and `active + ready >= 3`: `activateReady` all ready players now (they are dealt 7 in `joinOrder`, `PlayerActivated` each), then recompute `paused` and emit `PausedChanged` if it flipped. They are **not** added to `round.roster`, so they sit out the in-flight round. (Resolves the otherwise-deadlocked case where nobody could reach the next boundary; open question 3, proven by #23.)
3a. **Judge assignment** (as built, 1.6). If `PLAYING`, not paused, and `round.judgeId == null` (the judge was evicted while paused with no one to take over, 8.3): run `reassignJudge("resumed")` with no outgoing judge, which picks `nextJudge(active, judgeCursor)`, and raise `episodeStarted`. A player who recovery just activated may be the new judge and is not on `roster`: `reassignJudge` adds them (8.3).
4. **Auto-advance** (as built in 1.5, #22; only if `PLAYING`, not paused and the round has a judge, repeated until stable; a close or a void raises `episodeStarted`). "Expected" is the roster minus the judge, restricted to players who are still active (a roster player who has left does not hold the round open, as in `waitingOn`). The void branches are reached since 1.6 by eviction and `passJudging`, and by `removeCard` of the only revealed play of a JUDGING round (8.6); while paused, slot 4 does not run, so that round stays JUDGING with `submissions: []`, `revealOrder: []` (and a null `judgeId` if the judge was evicted too) until recovery un-pauses, then slots 3, 3a and 4 run in order (proven by #26 in `test/remove-card.test.ts`) (a submitter leaves a JUDGING round with one play; the new judge's own card was the only submission; the real chain of V9 voids and reopens after a resume):
   - `SUBMITTING` and no `expected` player lacks a submission: if `submissions.length >= 1` then `closeRound("allIn")`, else `voidRound("no_submissions")`.
   - `JUDGING` and `revealOrder` is empty: `voidRound("no_submissions")`.
5. **Waiting fields** (4.2): recompute `waitingOn`, `episode`, `waitingSince`, `reminderDueAt`.

### 8.3 Rounds

`openRound(state, rng, now, judge?)` (as built in 1.4, #21, with `nextJudge` and `beginPlay`; `judge` is a `PlayerId`; it sets `round` and `judgeCursor` and leaves `phase` to the caller; precondition after step 1: `active >= 3`, `greenDeck` non-empty, else `EngineInvariantError`):
1. Activate ready players at this boundary (8.5), dealing in `joinOrder` (E18).
2. If `judge` is given (only by `voidRound`, below) use it; else `judge = nextJudge(active, judgeCursor)`. Either way `judgeCursor = judge.joinOrder`.
3. `greenCardId = greenDeck.shift()`; `roster = active ids`; `number = history.length + 1`; `phase = SUBMITTING`; `judgeReassigned = false`; `changedAtVersion = state.version + 1`.
4. Event `RoundOpened{round, judgeId, greenCardId, expected}` where `expected` = roster minus judge.

`nextJudge(players, cursor, rng)` (returns the `Player`): among active players sorted by `joinOrder`, the one with the smallest `joinOrder > cursor`, else the smallest overall (wrap). If `cursor == null`, `rng.int(active.length)` over the sorted list (first judge, random, E12). Using `joinOrder` rather than list index keeps rotation stable when the previous judge has left.

`closeRound(state, rng, reason)` (as built; precondition SUBMITTING, at least one submission and a judge, else `EngineInvariantError`): `revealOrder = rng.shuffle(submissions.map(s => s.cardId))` (E10), one shuffle; `played = submissions.map(s => s.playerId)` (as built in #28, the public trace the Projector reads, OQ 20); `phase = JUDGING`; `changedAtVersion = state.version + 1`; event `SubmissionsClosed{round, judgeId, reason}` with `reason in {"allIn","closed"}`. Players in `expected` who had not submitted keep their hand and sit out.

`resolveRound(state, winnerCardId, rng, now)` (E11, E14; returns `{state, events, roundRecords}`; the card must be a revealed submission of this JUDGING round and `target` must be set, else `EngineInvariantError`), steps in order:
1. Winner = the submission owner; `scorePile.push(greenCardId)`. The judge cannot win (judge has no submission; E12).
2. Build `RoundRecord`/`RoundSummary`; append summary to `history`; emit `roundRecords`. As built: `plays` and `playsDetail` are in `revealOrder` order (the owner is public from here on), `absent` is the roster minus the judge minus `round.played` (as built in #28: not `submissions`, so the author of a play the host removed with `removeCard` is not absent, OQ 20), `resolvedAt = now`, and a pitch is copied into `playsDetail` only.
3. All submitted cards go to `redDiscard` (write-in cards too; they circulate afterwards like any card). The `RoundRecord`, `RoundSummary` and `history` carry no write-in marker (K-A): a resolved write-in play looks exactly like a hand play.
4. `topUp`: every active player is drawn up to 7 in `joinOrder` (8.4). (Superset of "each player who played"; it also repairs hands lowered by `removeCard`, E6.)
5. If `winner.scorePile.length >= target`: `phase = FINISHED`, `winnerId`, `round = null`, `paused = false`, events `WinnerPicked`, `GameFinished{winnerId}`; stop. Otherwise `round = null` and `openRound`. Events `WinnerPicked{round, judgeId, winnerId, winnerCardId}`, then `RoundOpened`.
As built, the rng order of one `pickWinner` is: the top-up reshuffle (only if the red deck runs dry), then any activation deal at the boundary; the next judge is `nextJudge` from the cursor and draws nothing. Ties cannot occur (one winner per round); gameplay.md's tie sentence is vacuous (open question 8).

`voidRound(state, rng, now, reason)` (as built; a round that still holds submissions is an `EngineInvariantError`): used only when a round has nothing to judge. The green card returns to the **bottom** of `greenDeck` (so E7's sufficiency is unaffected), submissions (none) are discarded, `round = null`, `RoundVoided{round, reason}`, then `openRound`. If the voided round's `judgeReassigned` is true (its judge came from `passJudging` or from a judge `leave`/`removePlayer`) and that judge is still active, `openRound` is called with `judge = round.judgeId` explicitly, so the passed-to player judges the replacement round (gameplay.md "Stalled judge"; the cursor already points at them, so `nextJudge` would skip them). Otherwise `openRound` rotates normally from `judgeCursor`. Round numbers stay contiguous because the number is `history.length + 1`.

`reassignJudge(game, reason, rng)` (as built in 1.6, #23; returns `{state, events}` and draws from `rng` only when `judgeCursor` is null; used by `passJudging`, judge `leave`, judge `removePlayer`, and settle step 3a): `newJudge = nextJudge(active excluding the outgoing judge when still active, outgoing.joinOrder)` (with no outgoing judge, step 3a: `nextJudge(active, judgeCursor)`). If no candidate exists (the evicted judge was the last active player; possible only while paused, since an unpaused game has at least two other actives), set `round.judgeId = null`, keep `judgeCursor`, bump `changedAtVersion`, emit no `JudgeChanged`, and stop: the round waits, paused, until settle step 3a assigns a judge when play can resume. Otherwise `judgeCursor = newJudge.joinOrder`. If `newJudge` has a submission in this round, remove it from `submissions` (and drop it from `revealOrder`, preserving the relative order of the rest; E10 holds because nothing is reshuffled): a hand-played card returns to that player's hand; a write-in card (`writeIn: true`) never left the hand, so it goes to `redDiscard` instead and the hand is unchanged (P-E6 holds; `powerUsage.writeIn` stays used). The new judge also leaves `round.played` (#28). `round.judgeId = newJudge`, `round.judgeReassigned = true`, `changedAtVersion` bumped. **As built (a small deviation, ruled in #23):** if `newJudge` is not on `round.roster` (recovery activated them mid-round, which can only be the "resumed" and "passed" cases) they are appended to it, so "the judge is on the roster" (E12) holds; the roster is otherwise fixed. The callers set `episodeStarted`. The outgoing judge, if still active and the round is `SUBMITTING`, is now an ordinary expected player (they are in `roster`); in `JUDGING` they sit out. Event `JudgeChanged{round, from, to, reason}` with `reason in {"passed","left","removed","resumed"}` (`from: null` for `"resumed"`). If afterwards the round has no submissions, settle's step 4 voids it and the replacement round keeps `newJudge` as judge (`voidRound` above; open question 7).

`abortRound(game)` (as built, only `endGame`; a game with no round is returned unchanged): each hand-played submission card returns to its owner's hand; a write-in submission card goes to `redDiscard`; the green card returns to the green deck bottom; `round = null`.

### 8.4 Dealing, top-up, red reshuffle

```
draw(n, into):                           // red only
  repeat n times:
    if redDeck empty:
      if redDiscard empty: stop          // short draw; cannot occur if R_min held (X6)
      redDeck = rng.shuffle(redDiscard); redDiscard = []
    into.push(redDeck.shift())
topUp(p): draw(7 - hand.length, p.hand)  // order: players by joinOrder
redraw(p): redDiscard.push(...p.hand); p.hand = []; draw(7, p.hand)
```
As built (1.4), `draw(pools, n, rng)` and `topUp(pools, hand, rng)` in `rules/cards.ts` are pure: they take and return the pools (and the hand) and consume `rng` only for the reshuffle. Initial deal: shuffled red deck, 7 to each active player in `joinOrder`. The red deck is reshuffled only when it is empty and a draw needs a card (gameplay.md: "When the red deck runs out, its discard pile is reshuffled"); `redraw` discards first and then draws, so the 7 cards needed always exist (`R_min` floor of 7). Greens are drawn only by `openRound`; they leave the deck permanently into score piles, so the green deck cannot run out before a winner exists (E7; X6 checks it).

### 8.5 Membership

`evictPlayer(game, playerId, status: "left" | "removed", rng)` (as built in 1.6, #23; returns `{state, events, draftChanges, episodeStarted}`, the events being the side effects only, `JudgeChanged`; the command adds the departure event first) in this order (E17):
1. `p.hand` and any submission card of `p` (unrevealed or in `JUDGING`) are appended to `redDeck`, then `redDeck` is reshuffled, **only if a card was appended (Q2: an empty hand with no hand-played submission draws nothing from `rng`)**; the hand goes first, then the submission card. Submission removed from `round.submissions` and `revealOrder`, and the seat from `round.played` (#28, even when the card was already gone, so a leaver is never counted as having played); **a write-in submission (Q3, never in the hand, fixture-tested until M7) goes to `redDiscard` instead and shuffles nothing**; this removal does not bump `round.changedAtVersion` (Q6, 5.3 step 3: only a judge, phase or voiding change does; a void or close that follows bumps it through settle). The asymmetry with `removeCard` of the same card, which does bump (8.6), is deliberate: eviction is a public player action the table already sees, while a host's removal silently changes what the judge is looking at.
2. `p.scorePile` is appended to `greenDeck` and reshuffled, only if the pile was non-empty (Q2); red is shuffled before green. **Declared decision (user decision U2, gameplay.md "Leaving", HLD E17):** a departing or removed player's points leave the game with them; rationale: the green deck must keep enough cards for the remaining players (E7).
3. `p`'s draft is deleted (`draftChanges`) only when `p`'s status was `writing` (Q7: a ready or active seat has no draft document); any cards they wrote but had not finished are lost (they were never pooled).
4. `status` set; hand and pile emptied. In LOBBY the record is deleted instead.
5. If `p` was the judge: `reassignJudge("left" | "removed")`.
6. Settle afterwards recomputes `waitingOn`, may auto-close (everyone left that was expected has now submitted) or void, may flip `paused`, may begin play (the only unfinished writer left in WRITING).

`activateReady`: each `ready` player (in `joinOrder`) gets `status = active`, 7 cards via `draw`, event `PlayerActivated{playerId}`. Activation happens (a) in `openRound` step 1 (the round boundary, E18), (b) in settle step 3 (paused recovery), (c) in `beginPlay`. A late joiner never receives cards while their status is `writing`.

Removing a ready late joiner before activation just releases nothing (their cards stay pooled; E8 forbids undoing authorship).

### 8.6 `removeCard` preconditions and special cases

**Shown to the table (user decision U3).** The host may remove only a card that has been shown to the table: the current round's `greenCardId`, a card in the current `revealOrder` (`JUDGING`), or a card appearing in any `history` summary (a played red card, or a green card of a resolved round, wherever it now sits: discard, a later hand, a score pile). Anything else (deck contents, hands never played, unrevealed `SUBMITTING` cards, imported or pooled cards) returns `NOT_FOUND` with no detail, identical to an unknown id. In practice removal is therefore possible only once play has begun. As built (1.8, #25): `shownToTable(g, id)` (selector, never exposed) is: still in the registry, and the current green, in `revealOrder`, or in any `history` summary; a card now in an unrevealed SUBMITTING play is not shown even if history names it (ruling: hidden information). The minimum-size guard is kept; the host's escape hatch for an offensive card the guard blocks is `endGame` (open question 11). **Conservative as built (cross-step review of 1.6 x 1.8):** the guard counts `seated` players including a late joiner still `writing`, but that joiner's owed `writeTarget` cards are not yet in the registry, so in a window X7 allows (for example a fifth player joining four at exactly the minimums, 9.4) every `removeCard` is `NOT_PLAYABLE` `below_minimum`, even a green when only red is short, until the joiner finishes. `checkPlayable` counts the owed cards and this guard does not; the window is accepted and `endGame` is the escape hatch. The test oracle `modelBlock` mirrors the handler, so no test would catch a change either way.

By zone: in a deck or discard, deleted. In a hand, deleted (hand shrinks, topped up at the next resolve). In a score pile, deleted (the player's score drops). In `round.submissions`, only a card already in `revealOrder` (`JUDGING`) qualifies (unrevealed `SUBMITTING` cards have not been shown): it is removed from `submissions` and `revealOrder`, the round is voided if none remain (by settle slot 4, so only while not paused: a paused game keeps a JUDGING round with an empty reveal list until recovery, 8.2), and its owner is not asked to replay. **As built (#28):** `removeCard` leaves `round.played` alone, so the public `submittedBy` keeps the author while the reveal loses the card (OQ 20). As `round.greenCardId`, replaced by the next card of `greenDeck` (`NOT_PLAYABLE`, detail `no_replacement` if the deck is empty); `changedAtVersion` bumped. The guard against dropping below minimums applies to the post-removal `totals` computed exactly as in 9.1 (every registry card of the kind in any zone, score piles, hands, discards and the current round included), compared with `meetsMinimums` (9.2). All of these bump `round.changedAtVersion` when a round zone was touched (as built: a revealed submission or the current green; a hand, pile or pool is not a round zone). Guard 9 order: `NOT_FOUND` (unshown or unknown, no detail), `NOT_PLAYABLE` `below_minimum` (post-removal totals at the seated count; not applied in LOBBY or with no target), `NOT_PLAYABLE` `no_replacement`. Not a round command: no `STALE`, no `PAUSED`. Events: `CardRemoved{cardId, kind}`, then settle's (`RoundVoided`, `RoundOpened`). `history`, `RoundSummary` ids and votes are left as they were (LLD 2 tolerates a missing card). **Known limitation (PR #74 review, for M2/M4 to revisit):** a card named in `history` has a public id, and a recycled one that now sits in an unrevealed SUBMITTING play answers `NOT_FOUND` while the same id elsewhere is accepted or `NOT_PLAYABLE`, so the host can learn that a recycled history card is currently played (never by whom). Accepted for v1 because hiding the play is the stronger rule; reds recycle only after a reshuffle.

### 8.7 `beginPlay`

In order: shuffle `redDeck` and `greenDeck` with `rng`; deal 7 to every `ready` player by `joinOrder` and set them `active`; first judge via `nextJudge(active, null)` (consumes `rng.int`); `judgeCursor` set; round 1 opened as in 8.3. Events: `PlayStarted{playerIds, firstJudgeId}`, `PlayerActivated` per player, `RoundOpened`. As built, `beginPlay(state, rng, now)` shuffles red then green, sets `phase = PLAYING` and `judgeCursor = null`, and calls `openRound`, which activates the ready players and draws the judge (`rng.int(active.length)` over the actives by `joinOrder`); `PlayStarted` is then prepended, because it needs `firstJudgeId`. The rng order, shuffle red, shuffle green, `int`, is pinned by a test. A `RoundOpened.greenCardId` can be a card pooled in the same command (the top of the shuffled green deck); it names no writer, because the EventDoc of a `finishWriting` omits the actor (E8).

### 8.8 Scoring, target, awards

- Target: `target = settings.targetOverride ?? defaultTarget(N)`; `defaultTarget(n)` = 8 for n <= 4, 7 for 5, 6 for 6, 5 for 7, 4 for n >= 8. Frozen at `startGame`; later joins do not change it (open question 10).
- Override range 2 to 10 (rationale: each player writes `T` green cards, and the HLD's example range tops out at 8).
- Winner of the game is whoever first has `scorePile.length >= target`, checked at resolution only (a `removeCard` can only lower scores).
- Awards (gameplay.md "People's choice"), computed on demand by `awards(game)` (selector; nothing stored):
  - `votesFor(round, cardId)` counts `Vote`s.
  - People's Choice = the player(s) with the highest total votes received across all their plays, minimum 1 vote; ties produce co-winners (open question 8).
  - Podium = the top 3 plays by votes (minimum 1), ordered by votes desc, then round asc, then `history` play order (deterministic tie-break); medals gold, silver, bronze by position.
  - Only when `settings.variants.peoplesChoice`. The judge's pick and votes are independent (E16): `resolveRound` never reads `votes`.
- Vote rules: voter key `p:{playerId}` for a seated player or `s:{uid}` for a spectator (allowed only if `spectators.enabled && spectators.vote`); one vote per `(round, voter)`, a later vote replaces; no vote for one's own card (owner looked up in `history`); votes are accepted for any resolved round while the game is PLAYING or FINISHED. The judge may vote. Total votes are capped at `MAX_VOTES` (1500); a vote that would add a new `(round, voter)` entry beyond the cap is rejected (`VARIANT_UNAVAILABLE`, `vote_cap`), while a replacement of an existing vote is still allowed. **E16 caveat (documented, accepted):** spectator voting is keyed by anonymous `uid`, so with `spectators.vote` on, a seated player can open a second anonymous session and vote for their own card or twice. E16's own-card rule is weak against this by design; People's Choice never affects scoring, so the impact is limited to the award.

## 9. Playability (pure functions in `rules/playability.ts`)

### 9.1 Formulas (HLD section 3.4, Q9)

```ts
const MIN_PLAYERS = 3, HAND = 7, NEW_DECK_RED = 10;   // the room size is MAX_SEATED (10) from @dc/contracts
// From @dc/contracts (shared with LLD 5): MAX_TOTAL_JOINS = 50 (joins ever, seated or not), MAX_VOTES = 1500 (votes[] length)
const gMin = (n: number, t: number) => n * t;
const rMin = (n: number) => HAND * n + Math.max(2 * n, HAND);
const defaultTarget = (n: number) => n <= 4 ? 8 : n === 5 ? 7 : n === 6 ? 6 : n === 7 ? 5 : 4;
```

`totals(game)` = `{ red, green }` counts of all registry cards of each kind in any zone including hands, discards and the current round (the HLD's "every card in the game's pools, hands and discard"). Pending drafts do not count.

### 9.2 Predicates

```ts
meetsMinimums(totals, n, t): boolean   // totals.red >= rMin(n) && totals.green >= gMin(n, t)
```
`n` is always the number of **seated** players (`writing`, `ready`, `active`). Used by: `startGame` (against projected totals, 9.3), settle step 1, `removeCard` (post-removal), and late-join requirement (9.4).

### 9.3 Per-player write counts at `startGame`

```ts
interface Existing { red: number; green: number }       // cards from importDeck, i.e. pool sizes at startGame
function writeCounts(n: number, t: number, existing: Existing, override: {red:number; green:number} | null)
  : { red: number; green: number } | "unmet" | "invalid"
```
- No imported cards (`existing = {0,0}`): `override` must be null (`"invalid"`, which `startGame` maps to `INVALID_ARGUMENT`, otherwise); result `{red: 10, green: t}` (new deck).
- Imported cards, no override: `{ red: ceil(max(0, rMin(n) - existing.red) / n), green: ceil(max(0, gMin(n,t) - existing.green) / n) }`. Both are at most the new-deck counts (HLD).
- Imported cards with override: accepted if `0 <= red <= 10`, `0 <= green <= t` and `existing.red + n*red >= rMin(n)` and `existing.green + n*green >= gMin(n,t)`; else `"unmet"` (`NOT_PLAYABLE`, detail `minimums`; an override out of range is unmet too). This is how "if the deck already meets both minimums the host may choose" is enforced, and it also covers partial reductions.
- The check runs at `startGame` (when `n` is known), not in `updateSettings`.

**Worked examples**

| Case | n, T | Inputs | Result |
|---|---|---|---|
| New deck, small | 3, 8 | none | `G_min = 24`, `R_min = 21 + max(6,7) = 28`. Write 10 red, 8 green: totals 30 red, 24 green. Meets both |
| New deck, full table | 10, 4 | none | `G_min = 40`, `R_min = 70 + 20 = 90`. Totals 100 and 40. Meets both |
| Reused deck, partial | 5, 7 | existing red 20, green 10 | `R_min = 35 + 10 = 45`, `G_min = 35`. Red per player `ceil(25/5) = 5`, green `ceil(25/5) = 5` |
| Reused deck suffices | 4, 8 | existing red 40, green 32 | `R_min = 36`, `G_min = 32`. Host may pick any red 0..10, green 0..8 such that the minimums hold: here `(0,0)` is accepted, and everyone is auto-ready so play starts at once |
| Override too low | 4, 8 | existing red 30, green 32, override (1, 0) | `30 + 4 = 34 < 36`: `NOT_PLAYABLE` |

### 9.4 Late joiners and WRITING-phase joiners

```ts
function lateJoinerRequirement(game, nAfterJoin): { red: number; green: number } {
  const pending = game.players.filter(p => p.status === "writing" && p.writeTarget);   // other unfinished writers
  const projRed = totals(game).red + sum(pending, p => p.writeTarget.red);
  const projGreen = totals(game).green + sum(pending, p => p.writeTarget.green);
  const cfg = game.writeCounts!;                                        // configured at startGame
  return { red: Math.max(cfg.red, Math.max(0, rMin(nAfterJoin) - projRed)),
           green: Math.max(cfg.green, Math.max(0, gMin(nAfterJoin, game.target!) - projGreen)) };
}
```
Rationale: counts the other pending writers' obligations, so several simultaneous joiners are not each asked to cover the same deficit; each sees the requirement recorded in their own `writeTarget` and nothing recomputes it later. `saveDraft` caps at `writeTarget`, and `finishWriting` needs equality, so after every pending writer finishes the totals meet the minimums by construction (X7).

Worked example: new-deck game, `n = 4`, `T = 8`, all in play (red 40, green 32). A fifth player joins: `R_min(5) = 45`, `G_min(5) = 40`. Deficits are 5 and 8, so the requirement is `max(10, 5) = 10` red and `max(8, 8) = 8` green. A sixth joins while the fifth is still writing: projected red 40 + 10 = 50, green 32 + 8 = 40; `R_min(6) = 54`, `G_min(6) = 6 × 8 = 48`; deficits 4 and 8; requirement 10 and 8 again.

As built (1.6, #23): `lateJoinerRequirement(game, nAfterJoin)` is in `rules/playability.ts`, with `game.writeCounts` and `game.target` read as zero for a state that never went through `startGame`, and `join` calls it with `seated + 1`. X7 is proved for joins on a new deck. **Not proven:** a pending writer who leaves after a later joiner was sized against their obligation can leave the later joiner's `writeTarget` short on a reused deck (on a new deck the configured counts of 10 red and `T` green per player leave slack, and the churn properties found no counterexample); `checkPlayable` would catch it in a scenario, and no generated scenario reuses a deck before M9 (`importDeck`).

Removals (E17): hands return to the red deck, so red totals are unchanged while `n` shrinks; green piles return to the green deck, so green totals are unchanged. Minimums can only get easier. Example: the 5-player game above loses a player: `n = 4`, red 50 vs `R_min(4) = 36`.

### 9.5 Cards still to write

`cardsStillToWrite(game, playerId) = writeTarget - writeProgress` (never negative). It is a selector; the Projector surfaces it (LLD 0 open question 5: the client does not recompute it). `saveDraft` keeps `writeProgress` at the saved counts, and `finishWriting` sets it to `writeTarget`, so a finished writer owes nothing.

## 10. Idempotency and concurrency boundary

| Concern | Owner | Detail |
|---|---|---|
| Idempotency ledger `(gameId, actor, idempotencyKey)` lookup and recording (E4) | Application layer (LLD 3 transaction, LLD 5 envelope) | Looked up before `decide` is called, recorded in the same transaction after. Engine is idempotency-agnostic: it never sees the key. Calling `decide` twice with the same command normally yields a different outcome (for example `ALREADY_SUBMITTED`), which is exactly why the ledger must short-circuit first |
| What the ledger stores | Application layer | Recommendation: store accepted results only. Rejections depend on the state at that moment and a retry may legitimately succeed after state changes, so replaying a stored rejection could be wrong. LLD 3 may choose otherwise |
| Optimistic concurrency (S1): CAS on `version` | Store (LLD 3) | The transaction reads `games/{id}`, calls `decide` on that snapshot, writes with the read version as precondition (Firestore transactions give this for free). A conflict reruns the whole body, including a fresh `decide` on fresh state; the seed of the attempt that commits is the one recorded |
| Semantic staleness (`STALE`) | **Engine** | `expectedVersion` is a field on the command. `decide` compares it to `round.changedAtVersion` (5.3 step 3). It is not equality with `state.version`, because other players' unrelated commands must not invalidate a judge's pick. The application passes `expectedVersion` through untouched and must not interpret it |
| `version` increment (E3) | **Engine** | `decide` sets `state.version = prev + 1` when `aggregateChanged`; the Store writes it. For `aggregateChanged: false` (draft-only `saveDraft`, `markReminded` no-op) the app writes only side documents and does not bump or fan out views |
| Atomicity (E2) | Engine returns everything (state, events, `draftChanges`, `roundRecords`) in one value; Store commits all in one transaction | A rejection carries nothing to commit |
| Command-level rate limiting, auth token checks | Application layer / Identity | Never in the Engine |

## 11. Domain events

Events contain ids, counts and enumerated kinds only; never card text, names, pitches or draft contents (N2, HLD 3.4). The EventDoc written by the app: `{ version, at, commandType, events: DomainEvent[] }` plus `seed` and `actorPlayerId?`, both omitted for `finishWriting`, `importDeck` and `writeIn` (`Accepted.redactEnvelope`, C-EV). One doc per `aggregateChanged` command; `events` may be `[]` (7.1 notes).

```ts
type DomainEvent =
  | { t: "GameCreated"; hostPlayerId: PlayerId }
  | { t: "SettingsUpdated"; keys: (keyof Settings)[] }
  | { t: "PlayerJoined"; playerId: PlayerId }
  | { t: "PlayerLeft"; playerId: PlayerId }
  | { t: "PlayerRemoved"; playerId: PlayerId }
  | { t: "DeckImported"; red: number; green: number }
  | { t: "WritingStarted"; target: number; writeCounts: { red: number; green: number } }
  | { t: "PlayerFinishedWriting"; playerId: PlayerId }
  | { t: "PlayStarted"; playerIds: PlayerId[]; firstJudgeId: PlayerId }
  | { t: "PlayerActivated"; playerId: PlayerId }
  | { t: "RoundOpened"; round: number; judgeId: PlayerId; greenCardId: CardId; expected: PlayerId[] }
  | { t: "SubmissionConfirmed"; round: number; playerId: PlayerId }              // same for hand plays and write-ins (K-A)
  | { t: "HandRedrawn"; playerId: PlayerId }
  | { t: "SubmissionsClosed"; round: number; judgeId: PlayerId; reason: "allIn" | "closed" }
  | { t: "JudgeChanged"; round: number; from: PlayerId | null; to: PlayerId; reason: "passed" | "left" | "removed" | "resumed" }   // from null only for "resumed" (8.3)
  | { t: "RoundVoided"; round: number; reason: "no_submissions" }
  | { t: "WinnerPicked"; round: number; judgeId: PlayerId; winnerId: PlayerId; winnerCardId: CardId }
  | { t: "VoteCast"; round: number; voterKind: "player" | "spectator" }
  | { t: "CardRemoved"; cardId: CardId; kind: CardKind }
  | { t: "GameFinished"; winnerId: PlayerId }
  | { t: "GameEnded" }
  | { t: "GameDeleted" }
  | { t: "PausedChanged"; paused: boolean };
```

HLD events kept as named: `PlayerJoined`, `PlayerRemoved`, `WritingStarted`, `PlayerFinishedWriting`, `RoundOpened{judge}`, `SubmissionConfirmed{playerId}`, `SubmissionsClosed`, `WinnerPicked`, `JudgeChanged`, `GameFinished`, `GameEnded`, `PausedChanged`. Additions: `GameCreated`, `SettingsUpdated`, `PlayerLeft` (voluntary, distinguishing it from removal), `DeckImported`, `PlayStarted`, `PlayerActivated`, `HandRedrawn`, `RoundVoided`, `VoteCast`, `CardRemoved`, `GameDeleted`.

Event emission order within a command is deterministic and given in 7.2. `SubmissionConfirmed` is public information (who played, not what; V3), so carrying `playerId` is safe; the event log is still client-denied. No event, EventDoc (a `writeIn` EventDoc records `commandType: "confirmSubmission"`), outbox row or `RoundRecord` marks a card or submission as a write-in (K-A); write-in usage exists only in the server-only `powerUsage` and `Submission.writeIn`.

**As built (1.9, #26).** The catalog above is exactly the `DomainEvent` union in `types.ts` (a test compares the two). Four tags are in the union with no emitter yet, each owned by a later step: `DeckImported` (M9, `importDeck`), `HandRedrawn` and `VoteCast` (M7, `redraw`, `castVote`), `GameDeleted` (M3, #36, `deleteGame`); `writeIn` is M7 too and will reuse `SubmissionConfirmed`. The Engine has no `EventDoc` type or builder: it hands the Store `events`, `seed` and `redactEnvelope` on `Accepted`, and the Store assembles the document (LLD 3 2.3, whose shape already matches). `redactEnvelope` is true for `finishWriting` only in M1 (`importDeck` and `writeIn` join it in M9 and M7); `events` is `[]` for `markReminded` and for a count-only `saveDraft` (and the latter, when the counts did not move, is `aggregateChanged: false`, so no document). N2 is enforced by a per-tag field whitelist plus a text scan over seeded games (every field an id, count, boolean or enumerated string). E9: no event pairs a card with a player (the matrix row), so the event log never carries the pairing. The test allows one case, `CardRemoved{cardId, kind}` from `removeCard` in JUDGING naming a card that is already revealed ownerless; that event has no player field. The leak there is not in the event but in the view diff (open question 20).

### 11.1 Events that drive notifications (HLD 3.8)

| Event | Recipients (LLD 6 resolves from the event and the post-state) | Message | Source |
|---|---|---|---|
| `WritingStarted` | players with status `writing` after settle (all seated players except any auto-ready with `{0,0}` counts) | Write your cards | U1 |
| `RoundOpened` | `expected` (all active non-judge roster players) | New green card, your turn | HLD |
| `SubmissionsClosed` (any reason) | `judgeId` | All cards in | HLD ("SubmissionsClosed / all submitted") |
| `WinnerPicked` | every seated player (status `writing`, `ready` or `active`; late joiners still writing included; not departed). `round` is carried so LLD 6 can dedupe | Result is in | HLD, K-D |
| `GameFinished` | every seated player (status `writing`, `ready` or `active`, late joiners still writing included) | Game over | HLD, K-D |
| `GameEnded` (host ends the game) | every seated player (status `writing`, `ready` or `active`; not departed), kind `game_ended` | The host ended the game. | K-D |
| Scheduler sweep (not an event; one `Reminder` outbox row per accepted `markReminded`, 7.4) | `waitingOn` of games with `reminderDueAt <= now`, in any phase (WRITING, SUBMITTING, JUDGING), including late joiners still writing during PLAYING (4.2) | Reminder | HLD, U1, K-E |
| `JudgeChanged` | `to` (the new judge) in either round phase; additionally, when `reason == "passed"` and the round is `SUBMITTING`, the old judge (`from`), who now owes a card (`owe_card`, LLD 6 3.2). `left`, `removed` and `resumed` notify only the new judge | You are now judging; old judge: your card is owed | U1 (open question 5 resolved) |
| `PausedChanged{paused:false}` | `waitingOn` of the post-state | Game resumed, it's your turn | U1 |
| `RoundVoided` | none (followed by `RoundOpened`) | | |
| `PausedChanged{paused:true}`, all others | none | | pause is silent |

Principle (U1): a player is pushed whenever they become newly waited-on, and reminded daily for as long as they remain waited-on. A late joiner who becomes waited-on (in WRITING or PLAYING) is already in-app, so no push, but is included in reminders. Results and the end of the game (`WinnerPicked`, `GameFinished`, `GameEnded`) reach everyone seated, late joiners still writing included (K-D). Copy is generic (no card text, no names). `WinnerPicked` and `RoundOpened` are emitted by the same command; LLD 6 sends one push per `(event, recipient)` (N1) and may merge them for the same recipient.

## 12. Moderation module

```ts
type TextKind = "name" | "card" | "pitch";
type CheckResult = { ok: true; text: string }                       // text = cleaned, to be stored
                 | { ok: false; reason: "EMPTY" | "TOO_LONG" | "INVALID_CHARS" | "PROFANITY" };
declare function check(text: string, kind: TextKind, mode: "on" | "off"): CheckResult;
```

- **Structural rules (both modes).** Clean: NFC, trim, collapse internal whitespace runs to one space, reject control and zero-width characters (`INVALID_CHARS`). Length by Unicode code point count against `TEXT_LIMITS` (`{name: 24, card: 80, pitch: 140}`, imported from `packages/contracts`, LLD 5): `name` 1 to `TEXT_LIMITS.name`, `card` 1 to `TEXT_LIMITS.card`, `pitch` 1 to `TEXT_LIMITS.pitch` (gameplay.md fixes only the 140). `EMPTY` and `TOO_LONG` otherwise. Rationale: structural limits must hold even when the filter is off, and this is the single place they are defined.
- **Profanity (mode `on` only).** Deterministic, local, no third-party call (M4). `wordlist.ts` exports `TERMS` (each entry: `{ term, match: "word" | "substring" }`) and `ALLOW` (known false-positive words). Pipeline `normalize(text)` produces a folded form:
  1. NFKC, then NFD and strip combining marks (diacritics).
  2. Lowercase; strip zero-width and soft-hyphen characters.
  3. Confusable fold: a small table of Cyrillic/Greek/full-width lookalikes to Latin (`а -> a`, `е -> e`, `о -> o`, `ρ -> p`, etc.).
  4. Leetspeak fold: `0->o, 1->i, 3->e, 4->a, 5->s, 7->t, @->a, $->s, !->i, |->i, +->t`. Applied only to a character that sits next to a letter, so "2024" and "100%" are not rewritten.
  5. Collapse any run of 3 or more identical letters to 2, then also test the version collapsed to 1 (catches "fuuuuck").
  Matching runs three passes on the folded string: (a) **token pass**: split on non-letters, a token equal to a `word` entry is a hit (so "Scunthorpe", "class", "assassin" are never hits); (b) **substring pass** on tokens for `substring` entries (reserved for long, unambiguous terms of 5 or more letters); (c) **squash pass**: remove all non-letters and test only `substring` entries of 5 or more letters (catches "f.u.c.k", "s p a c e d"). A token in `ALLOW` is skipped in all passes. Names are checked as one string and also per token.
- **Result and reason.** Failure returns `PROFANITY`; the Engine maps any failure to `CONTENT_REJECTED` with `detail` set to the reason. The matched word is never returned or logged (M3 asks for a user-facing reason: the client renders text per reason code, "this word isn't allowed in this game" for `PROFANITY`).
- **Invocation (M1).** In `decide`, guard step 8. **Wired in M1 (1.8, #25), four entry points:** `createGame` (host name, mode from the new game's settings), `join` (name), `saveDraft` (every red and green text, every call, so the stored draft is always clean; blank is `EMPTY`), `confirmSubmission` (pitch; blank is no pitch). **Later:** `writeIn` (text and pitch, M7) and `importDeck` (every text, M9) have no M1 owner. It is not re-run at `finishWriting`: texts were validated at save time under the mode then in force (M2). `check` receives `game.settings.profanity` at the time of the command; `updateSettings` of `profanity` never rewrites existing cards (M2).
- **As built (1.8, #25).** `normalize` runs to a fixed point (idempotent; Hangul, lowercase and leet contagion needed it). `check` matches three folds (leet; no leet, so a trailing "!" stays a separator; leet with up to 3 edge symbols trimmed) and for each also the form with letter runs reduced to one, so "zorrblat", "z0rbl@7!" and "zorblat!" are caught. `check` takes an optional list (default: the checked-in placeholder of fake tokens). `moderation/` imports only from itself and `@dc/contracts` (`TEXT_LIMITS`). `check` is exported as `checkText`. NAME_TAKEN key: `nameKey`, as in the bullet below. Terms are collapsed the same way as the text in the collapsed pass (so a doubled-letter term is caught when another letter is elongated; a collapsed term such as "bas" from "bass" can therefore match the text "bas", an accepted cost for the real list to weigh). The fixed-point loop is capped at `16 + 2 * length` passes (a long leet chain needs about one pass per character). `INVALID_CHARS` covers control characters, the soft hyphen, U+061C, U+180E, U+200B to U+200F, U+202A to U+202E, U+2060 to U+2064, U+2066 to U+206F, U+FEFF, U+FFF9 to U+FFFB, the tag block U+E0000 to U+E007F, and lone surrogates.
- **Wordlist maintenance.** The list is a checked-in TypeScript constant; changing it is a code change. The initial list content is not specified here (open question 11).
- Cleaned `text` is what is stored in `Game.cards` and `Player.name`; dedupe for `NAME_TAKEN` compares `nameKey(name)`: `normalize` of the cleaned name with its whitespace removed first (so "a 1" and "a1" are one key). `normalize` includes the leet fold, so names that differ only by a digit or symbol for a letter next to a letter collide ("Team A" and "Team 4", "Ann3" and "Anne"): deliberate impersonation protection, pinned by a test, and a behaviour change from the case-only key of 1.3.

## 13. Deck Library seam (D1 to D3)

Only the seam is reserved; LLD (later) designs the library.
- `importDeck{red[], green[]}` (host, LOBBY, before any card exists) is the single entry. It mints ids, registers cards, appends to `redDeck`/`greenDeck`, moderates each text, carries no authorship and no player ids (D2). The application layer (not the Engine) reads `hosts/{hostUid}/decks/{deckId}` and builds the command; the library never touches `Game` directly (D1).
- Imported cards are ordinary pool cards: they obey E5 (registry membership), and `startGame` treats pool sizes as `existing` for `writeCounts` (9.3), so D3 (counts and sufficiency still hold) is enforced by the same code as for written cards.
- The host's "how it combines" decision (Q5, Q7) is expressed entirely as `settings.writeCountsOverride` or its absence (formula default). Anything richer belongs to the library LLD and must reduce to those two.
- `saveDeck` needs the cards' text without authorship: `selectors.exportPools(game)` returns `{red: string[], green: string[]}` from `cards` for ids in the decks, discards, hands, piles (everything, since authorship does not exist) once `phase` is FINISHED or ENDED.

## 14. Selectors exposed to the Projector (LLD 2) and the app

Pure, total, side-effect free; none returns hidden state unless named server-only.

```ts
seated(g), activePlayers(g), isPaused(g), effectiveTarget(g)            // target ?? defaultTarget(seated.length)
expectedSubmitters(g): PlayerId[]; waitingOn(g): PlayerId[]; submittedBy(g): PlayerId[]   // who, never what (V3)
cardText(g, id): string; handOf(g, playerId): CardId[]                   // callers (the Projector) gate by viewer
revealList(g): { submissionId: CardId; text: string; pitch: string | null }[]   // JUDGING only, in revealOrder, no owners
ownSubmission(g, playerId): { cardId: CardId; text: string; pitch: string | null } | null   // the viewer's own play; the only owner-keyed read (LLD 2 `you.ts`)
submissionOwner(g, cardId): PlayerId | undefined                         // SERVER-ONLY; legal to expose only after resolution
shownToTable(g, cardId): boolean                                         // removeCard precondition (8.6); never exposed to clients
cardsStillToWrite(g, playerId): { red: number; green: number }
playabilityReport(g): { n; target; totals; rMin; gMin; meets: boolean }
awards(g): { peoplesChoice: PlayerId[]; podium: { rank: 1|2|3; round: number; cardId: CardId; playerId: PlayerId; votes: number }[] } | null
votesFor(g, round, cardId): number
exportPools(g): { red: string[]; green: string[] }
```

The Engine does not decide who may see what; that is LLD 2. It guarantees only that `Game` contains nothing about authorship (E8) and that `RoundRecord` is the single source for resolved-round text. **As built (1.9, #26)**, `selectors.ts` and `rules/awards.ts`, all exported except `exportPools` (M9, with the Deck Library seam). Rulings where the sketch above was silent: every selector is total (an unknown card id gives `""`, an unknown player gives `[]`, `null` or zero, never a throw) and returns copies, not aggregate arrays. `effectiveTarget` is `target ?? settings.targetOverride ?? defaultTarget(seated)` (LOBBY has no frozen target yet, so the override has to count). `waitingOn` is the settled scheduler field (4.2), not a second computation. `expectedSubmitters` is the roster minus the judge, still active; `submittedBy` is in confirm order. `revealList` is `[]` unless the round is JUDGING (the phase is the gate, not the presence of `revealOrder`). `ownSubmission` is the only read keyed by viewer. `submissionOwner` and `shownToTable` are **server-only** (doc comments say so): the first is the pairing E9 hides until `WinnerPicked`, the second is `removeCard`'s precondition. `awards` is `null` with the variant off; with it on and no votes it is `{peoplesChoice: [], podium: []}`; People's Choice lists co-winners in seat order; the podium is top 3 by votes, round, then `history` play order, rank by position (8.8). `votesFor` and `awards` are **fixture-proven only**: no `castVote` exists before M7, so the votes are fabricated in the tests, and open question 8's tie-breaks are still a decision of this LLD, not of gameplay.md. The Projector's use of these selectors is M2.

Write-in rule for the Projector (K-A): `Player.powerUsage` and `Submission.writeIn` are server-only; the Projector may expose a player's `powerUsage` (and "you used your write-in") only in that player's own view, never to other players or spectators, and never in the reveal, history, round docs or feed.

## 15. Invariant-to-test matrix

Test stack: `bun test` + fast-check (LLD 0 section 6). `FC_SEED` is read from the environment and printed on failure (P11); CI uses `numRuns: 200` per property, nightly `2000`. Tests live in `packages/engine/test`.

### 15.1 Shared harness (`test/support/`)

- Built in 1.2 (`test/support/`): `scriptedRng`, `counterMintId`, `makeGame`, `makePlayer`, `makeRound`, `addCard`, `deepFreeze`, `ctxFor`, `checkAll` over the append-only `checkers` array (`checkSerializable` and `checkVersion` so far), the per-command `enumerators` table and `exemptions` (a meta-test fails a registered command with neither), `junkCommands`, `runScenario`, and fixture command specs (`fixtures.ts`) with their own enumerators. 1.3 (#20) added the lobby enumerators and the `createGame` exemption, widened `pid` to 1024 ids (the 50-join loop needs more than 32; `pid(n)` for n < 32 is unchanged), and runs X2 to X5 and G1 over both the fixture and the real registry. A playing-phase builder against the real commands arrives with #22. 1.4 (#21) fixed `buildGame` so every state is coherent for the E5 and E6 checkers (the round's green card is no longer also in `greenDeck`, hand and submission ids no longer collide at six players, and WRITING states carry `target`, `writeCounts`, per-player `writeTarget` and the pooled cards of the ready players), added `recordingRng` and `gameWithDeck` to the factories, `drafts` and `actor` to `Step` (the oracle for E3, E5 and E8), and appended `checkConservation`, `checkHands`, `checkAggregateChanged` and `checkNoAuthorship` to `checkers`; (1.8, #25 added `removeCard`'s enumerator, written from 8.6 in `support/removal.ts`, the `checkRemoveCard` checker, a `removeCard` op in `membershipDriver`, and moved `checkScoring`'s pile rule to allow `removeCard`.) the enumerators for `startGame`, `saveDraft` (full, half and text-only drafts) and `finishWriting` (a draft equal to the target, from the drafts map) are in `legal.ts`. 1.5 (#22) added the enumerators for `confirmSubmission` (with a pitch too when the variant is on), `closeSubmissions` and `pickWinner`; made `buildGame` coherent for PLAYING, a new JUDGING shape (`revealOrder` set, at least one submission) and FINISHED (all carry `target`, and PLAYING and JUDGING meet `meetsMinimums` so a resolve can top up and open a round); added `support/round-fixtures.ts` (`roundGame`), a `drive` option on `runScenario` with `progressDriver` (plays whole games through the legal commands), and the checkers `checkOwnerHidden` (E9), `checkRevealOrder` (E10), `checkJudges` (E12, against an independent rotation model), `checkRoundMoves` (E5 per zone, E13), `checkTopUp` (E6), `checkPlayable` (E7), `checkScoring` (E14) and `checkFinished` (E15); and hardened the old checkers: `checkConservation`, `checkNoAuthorship` and `checkAggregateChanged` now throw when a step lacks the `drafts` or `actor` they need, and `checkNoAuthorship` matches whole draft texts (a short draft text is no longer a substring false positive).
1.6 (#23) added the enumerators for `passJudging`, `endGame` and the widened `join`, `leave` and `removePlayer`; `membershipDriver` (a `progressDriver` with churn: about one step in seven is a join, leave or removal, a late joiner writes and finishes, a paused table is recovered by joins, `endGame` about once in 300 steps); `park` in `round-fixtures.ts`; the checkers `checkEviction` (E17) and `checkLateJoin` (E18); and reworked `checkJudges` (the model follows a reassignment and a void that keeps the reassigned judge), `checkPlayable` (counts the pending writers' `writeTarget`s toward the minimums, X7), `checkScoring` (piles never exceed `history`, and move only by a pick or an eviction) and `checkRevealOrder` (a subsequence of the original, E10); `checkNoAuthorship` no longer scans player records in a command that also activated players.
- `deepFreeze` on every input to `decide`; assert no mutation (X4).
- `legalCommands(game, drafts): Array<{actor, cmd}>` enumerates every command a given state accepts: for each seated player and the host, each applicable command with concrete payloads (hand cards, reveal ids, valid drafts built from a text arbitrary that passes Moderation). It is written independently of `decide` (from gameplay.md), so it cross-checks the Engine; a property asserts every enumerated command is accepted (G1).
- `junkCommands(game)`: well-typed but illegal commands (wrong phase, wrong actor, bogus ids, oversized payloads), plus fully arbitrary JSON payloads for X1.
- `arbScenario`: `fc.record({ n: 3..10, target: option(2..10), variants: subset, profanity, importDeck: option({...}), steps: array(arbStep, {maxLength: 400}) })`; `arbStep` picks `{kind: "legal", pick: nat}` (index into `legalCommands`, with weights favoring progress commands: finishWriting, confirmSubmission, pickWinner), `{kind: "junk", pick}`, or `{kind: "membership", op: "join"|"leave"|"remove", ...}` (these also arrive through `legalCommands`, rate-limited so games finish).
- `runScenario(s)`: creates the game, applies steps through `decide` with a seed derived from the scenario seed and step index, applies `draftChanges` and keeps `RoundRecord`s; after **every** accepted or rejected command runs `checkAll(before, after, drafts, accepted)`. `checkAll` calls each global checker below and fails with the step index and seed.
- Global checkers: `checkConservation` (E5), `checkHands` (E6), `checkGreenSufficiency` (E7), `checkNoAuthorship` (E8: scans `JSON.stringify(game)` for each draft-author correlation: no field links a playerId to a card id before resolution except `round.submissions`), `checkRound` (E9 to E14), `checkVariants` (E16), `checkMembership` (E17, E18), `checkVersion` (E3), `checkSerializable` (X2).

### 15.2 Matrix

| Invariant | Unit tests (examples) | Property tests (fast-check) |
|---|---|---|
| **E1** typed rejection, no change | One test per (command x wrong phase) and (command x wrong role); table-driven from 7.1; guard order (5.3) pinned with combined-failure cases (non-member + stale -> `NOT_AUTHORIZED`; stale judge -> `STALE`) | P-E1: for `junkCommands`, result is `ok:false`, the code is in the allowed set, input state deep-equal to before. Also error codes for hidden-state probes are identical (`pickWinner` unknown vs other-round id) |
| **E2** atomic | Accepted value contains state, events, side documents together; rejection contains none | P-E2: `decide` never returns a partial: `ok:false` implies no value; `ok:true` implies `events.length >= 1` unless `!aggregateChanged` or the command is `markReminded` or a count-only `saveDraft` (both write an EventDoc with `events: []` when `aggregateChanged`) |
| **E3** version +1 | `saveDraft` text-only edit: `aggregateChanged: false`, same version; count change: +1 | P-E3: after each accepted command `after.version === before.version + (aggregateChanged ? 1 : 0)`; versions strictly contiguous over a run, and the set of event-doc versions the app would write equals exactly the set of aggregate versions (no gaps) |
| **E4** idempotency | Engine side: `decide` same input twice gives deep-equal outputs (purity). The ledger itself is out of the Engine (section 10); tested in LLD 3's emulator suite (retry returns original result, no second effect) | P-X3 below covers repeat purity; no Engine property for the ledger |
| **E5** conservation | Unit per zone move: deal, submit, resolve, redraw, reshuffle, evict (hand, pile, submission), removeCard each in each zone, `endGame` abort | **P-E5 (global)**: after every command, the multiset union of all zones (hands, piles, four pools, submissions, `round.greenCardId`) has no duplicates and equals `keys(cards)`; and `keys(after.cards) − keys(before.cards)` is non-empty only for `finishWriting`/`importDeck`/`writeIn`, and `before − after` only for `removeCard`; counts per kind change by exactly the command's documented amount |
| **E6** hands <= 7, top-up | Initial deal = 7; after resolve every active hand = 7 with an exhausted deck (forces reshuffle); redraw with small deck | P-E6: hands <= 7 after every command; after `pickWinner` every active hand is exactly 7 (given `R_min`, X6) |
| **E7** green sufficiency, minimums | `startGame` with imported deck below minimum -> `NOT_PLAYABLE`; late joiner computed requirement (9.4 examples); play to a win with N=10, T=4 and minimum-sized decks | P-E7: after every command in PLAYING `greenDeck.length >= 1` whenever a round must open; `meetsMinimums(totals, N, T)` holds in PLAYING for scenarios that respect `lateJoinerRequirement`; `startGame` accepted iff the formulas say so (compare against an independent implementation in the test) |
| **E8** no authorship | Draft -> `finishWriting`: `Game` JSON contains no draft text mapping to a player; ids are not sequential or sorted by author (statistical check over many runs); `Game` has no `drafts` field | P-E8: for random scenarios, for every writer, no field in `Game` or any event relates a card id to its writer id before resolution (scan serialized `Game` + events for co-occurrence); pool order after each `finishWriting` is independent of finishing order (compare distributions over seeds). **Envelope clause:** for `finishWriting`, `importDeck` and `writeIn`, `Accepted.redactEnvelope` is true and no EventDoc built from the result contains `seed` or `actorPlayerId`; ids come from `ctx.mintId()`, so re-running `decide` with the recorded seed of any other stored EventDoc and a different `mintId` yields different ids (ids are not reproducible from any stored seed). From any stored EventDoc plus the final state, authorship of a pooled card is not recoverable. **Write-in clause (K-A):** from all stored docs (EventDocs, outbox rows, `RoundRecord`s, and the views of every viewer other than the author) no write-in card or submission can be distinguished from a hand card: no `variant` or write-in field, a `writeIn` EventDoc carries `commandType: "confirmSubmission"` and events deep-equal to a hand play's, and `powerUsage` appears only in its owner's view (the view part is tested in LLD 2) |
| **E9** owner hidden | The Engine stores owners in `submissions` (needed), but `events` never contain `cardId` of a submission paired with `playerId` before `WinnerPicked` | P-E9: scan events emitted from `confirmSubmission`/`writeIn`/`closeSubmissions`: they contain no `cardId`. `revealList(game)` output never contains a playerId (V3 is tested again in LLD 2 on the view) |
| **E10** revealOrder fixed | `revealOrder` set at close; unchanged by `passJudging` except removal of the new judge's own entry (relative order preserved); if that entry is the new judge's write-in, the card goes to `redDiscard` and their hand is unchanged; unchanged across unrelated commands | P-E10: once non-null, for every later state with the same round number, `revealOrder` is a subsequence-preserving subset of the original; as a set equals submissions' cards |
| **E11** judge only picks revealed, only JUDGING | pickWinner in SUBMITTING -> `WRONG_PHASE`; unknown id and other-round id -> same `NOT_FOUND`; non-judge -> `NOT_AUTHORIZED` | P-E11: for random states, every `submissionId` not in `revealOrder` is rejected; every one in it is accepted when called by the judge |
| **E12** one judge, rotation | First judge from `scriptedRng`; rotation across a wrap; rotation with the previous judge removed; judge never in `submissions`; judge's score unchanged in own round; joinOrder with a late joiner; **pass then void**: `passJudging` to a player whose card was the only submission voids the round and the replacement round's judge is that passed-to player (same for a judge `leave`/`removePlayer` void), while a void with no reassignment rotates normally; **judge evicted while paused**: the last active player (the judge) leaves while paused, `round.judgeId == null`, no `JudgeChanged`; when recovery or a join un-pauses, settle assigns `nextJudge(active, judgeCursor)` with `JudgeChanged{from: null, reason: "resumed"}` | P-E12: each round has exactly one judge who is active at open; `round.judgeId` is null only while paused, and is non-null and active whenever not paused; consecutive judges follow `nextJudge` (compare to a reference model over `joinOrder`), except that a round voided after a reassignment reopens with the same judge; judge never appears in `roster.submissions`; judge's `scorePile` length unchanged by the round they judge |
| **E13** one submission per player, from hand, final | Second `confirmSubmission` -> `ALREADY_SUBMITTED`; card not in hand -> `NOT_IN_HAND`; `writeIn` after confirm -> `ALREADY_SUBMITTED`; after `redraw`-then-confirm | P-E13: `submissions` has unique `playerId`; each confirm consumed a card that was in the player's hand immediately before; no command removes a submission except pass/evict/removeCard (the documented cases) |
| **E14** resolves once, one point | `pickWinner` twice -> second is `WRONG_PHASE`; exactly one `WinnerPicked`; winner pile +1; `history` +1 | P-E14: across a run, `sum(scorePile.length)` + green cards removed/returned via evict reconciles with `history.length`; each `round` number resolved once; `winnerId != judgeId` |
| **E15** finish | Hit the target: phase FINISHED, `round = null`, only `castVote`/`endGame`/`deleteGame` accepted, others `WRONG_PHASE`; no `RoundOpened` after finish | P-E15: if a scorePile reaches target during a run, the next state is FINISHED and stays terminal (no accepted command except the three) |
| **E16** variants | Write-in and redraw each once (second -> `VARIANT_UNAVAILABLE`), disabled variant -> `VARIANT_UNAVAILABLE`; own-card vote -> `NOT_AUTHORIZED`; changing votes replaces; scoring identical with and without votes | P-E16: `powerUsage` flags only go false to true; `resolveRound` outcome equal for two runs differing only in injected votes (compare `history`, `scorePile`); no vote targets the voter's own play |
| **E17** removal | Remove: judge in SUBMITTING, judge in JUDGING (new judge's own hand-played card returns to hand; a write-in goes to `redDiscard`), player with an unrevealed submission, a player with a score pile, last unfinished writer in WRITING (play begins), second-to-last active (pause), the judge as last active player while paused (`judgeId = null`), host removing own seat; `endGame` with a write-in submission open: write-in to `redDiscard`, hand plays back to hands, hands <= 7; `removeCard` guard counts score-pile cards (a removal blocked only because piles are counted is still `NOT_PLAYABLE`) | P-E17: after any evict, the player's hand, pile, submission are empty; those cards are in the decks; `waitingOn` contains no departed player; judge is active or (paused only) null; conservation holds (E5) |
| **E18** late join | Join mid-round: status `writing`, no cards; finish mid-round: `ready`, no cards until next `RoundOpened`; activated with 7 cards and 0 points; paused-recovery activation sits out (not in `roster`) | P-E18: a player with status `writing`/`ready` never has cards or a submission; a player's first `PlayerActivated` coincides with `RoundOpened`, `PlayStarted` or the documented paused recovery; new player's `score = 0` |
| **M1** server-side at write | `check` wired into each entry point: table test over the four M1 entry points in section 12 (`writeIn`, `importDeck` are M7, M9) with a profane string expects `CONTENT_REJECTED` (mode on) and acceptance (mode off) | P-M1: any text rejected by `check(..., "on")` is rejected by every entry point; no entry point accepts text that `check` rejects |
| **M2** mode affects future writes only | Change `profanity` mid-game: existing cards unchanged; later `writeIn` follows new mode | P-M2: `updateSettings{profanity}` leaves `cards` deep-equal |
| **M3** reason | Each reason code is produced by a crafted input; the matched word never appears in the rejection | P-M3: `JSON.stringify(rejection)` contains no substring of the input beyond the fixed enum |
| **M4** deterministic, local | `check` called with the same input many times is identical; test asserts `moderation/` imports only from itself (lint P5 covers I/O) | P-M4: `check` is a pure function (same inputs, same output) and total (never throws) over `fc.fullUnicodeString`; fold idempotence `normalize(normalize(x)) === normalize(x)`; leet/diacritic/spacing variants of every listed term are caught while every `ALLOW` entry passes |
| **X1** `decide` is total | Table of malformed payloads | P-X1: over arbitrary JSON as `cmd` (type-cast), `decide` returns a `Result` and never throws |
| **X2** JSON-safe state | Roundtrip `JSON.parse(JSON.stringify)` equals the state | P-X2: after every command, `deepEqual(state, roundtrip(state))`; no `undefined` property values (Firestore) |
| **X3** determinism | Same `(state, cmd, ctx)` with `makeRng(seed)` returns deep-equal results | P-X3: run a scenario twice with the same seeds and the same scripted `mintId` -> identical state, events, records at every step; different seeds change only shuffle order and the first judge; a recorded `seed` replays the shuffles of any step that mints no ids |
| **X4** no mutation | deepFreeze inputs | P-X4: over all P-E1/P-E5 runs inputs are frozen and `decide` does not throw `TypeError` |
| **X5** `now`-independence | Two runs with different `now` | P-X5: equal states after zeroing `createdAt`, `openedAt`, `resolvedAt`, `waitingSince`, `reminderDueAt` |
| **X6** red supply never short | Min-size decks, N=3 and N=10, full game, all variants on (heavy `redraw`) | P-X6: `draw` never stops short in any scenario that satisfied `meetsMinimums` at start and respected late-join requirements |
| **X7** late-join sufficiency | Examples in 9.4 | P-X7: after all pending writers finish, `meetsMinimums(totals, N, target)` holds |
| **X8** waiting fields | Episode changes on writing start/open/close/judge change/void/un-pause, not on a submission or a `finishWriting`; `episodeGen` +1 on each of those (pause then un-pause in WRITING gives the same `"writing"` key with a higher `episodeGen`); `waitingOn` in WRITING = seated players with status `writing`; a late joiner in WRITING or PLAYING (SUBMITTING and JUDGING) is added to `waitingOn` without changing `episode`, `episodeGen` or `waitingSince`, and leaves it on `finishWriting`; `saveDraft` by a late joiner in PLAYING accepted, by a `ready` player `WRONG_PHASE`; `markReminded` with a stale `episodeGen` is a no-op; `reminderDueAt` null when paused/finished/ended | P-X8: `waitingOn` equals the independently computed set; `reminderDueAt` null iff `episode` null; immediately after a command that starts an episode, `reminderDueAt - waitingSince == 86_400_000`; at all times `reminderDueAt >= waitingSince + 86_400_000`; each accepted `markReminded` sets `reminderDueAt = now + 86_400_000` (strictly later than before) and leaves `waitingSince`, `episode`, `episodeGen` unchanged; `episodeGen` never decreases and changes iff `episode` starts |
| **X9** caps | `join` with `totalJoins = 50` -> `ROOM_FULL`/`join_cap` even with few seated (LOBBY leavers count); `join`/`leave` x 50 in LOBBY ends refused; `castVote` at `votes.length = 1500` -> `VARIANT_UNAVAILABLE`/`vote_cap`, but replacing an existing vote still accepted | P-X9: `totalJoins` never decreases and equals accepted `join` count; `votes.length <= MAX_VOTES` after every command |
| **X10** removeCard reach | Remove a green card of a resolved round, a played red card now in discard, a current-round green card: accepted; a deck card, an unplayed hand card, an unrevealed `SUBMITTING` card: `NOT_FOUND`, same as an unknown id; below-minimum removal -> `NOT_PLAYABLE`; `updateSettings{variants}` replaces the nested object | P-X10: `removeCard` accepted iff `shownToTable` and the guard passes; rejection for an unshown id is deep-equal to the rejection for a random unknown id |
| **G1** generator sanity | Every `legalCommands` entry is accepted | P-G1: all commands emitted by `legalCommands` are accepted (guards the harness itself) |

**Covered by 1.3 (#20), over the real `REGISTRY`** (`test/lobby.test.ts`, `test/playability.test.ts`, `test/decide.properties.test.ts`): E1 for `createGame`, `updateSettings`, `join`, `leave`, `removePlayer` (command x phase, command x role, guard order with combined failures, the junk list with per-guard expected codes, typed junk); E7, formula half only (`rules/playability.ts` pinned by the 9.3 examples and a property against an independent implementation; the `startGame` half is #21, the PLAYING half #22); X9, `join` half only (`join_cap`, 50 join and leave cycles, `totalJoins` monotonic and equal to accepted joins; the `castVote` half is its owner's); X1 to X5 and G1 re-run over the real rows with enumerators for `updateSettings`, `join`, `leave`, `removePlayer`, and `createGame` as an explicit exemption with its own property. Mid-game `join`, `leave`, `removePlayer` (E17, X7) are #23.

**Covered by 1.4 (#21), over the real `REGISTRY`** (`test/writing.test.ts`, `test/rounds.test.ts`, `test/deal.test.ts`, the global checkers in `test/support/checks.ts`): E1 for `startGame`, `saveDraft`, `finishWriting` (command x phase x role table written from 7.1, guard order with combined failures, the junk list, typed junk); E3 (`saveDraft` `aggregateChanged` iff the counts changed, text-only edit leaves version and state alone, every other accepted command +1 through `checkVersion` and `checkAggregateChanged`); E5 (conservation checker after every command, cards created only by `finishWriting`, per-kind deltas equal to the finisher's draft; per-zone unit tests for `draw`, `topUp`, the deal and the reshuffle branch); E6, helper half (hands at most 7 always, a newly activated player holds exactly 7, `topUp` with an exhausted deck); E7, `startGame` half (accepted iff the formulas say so, against an independent in-test implementation, on fixture decks; the PLAYING half is #22); E8 (ids from `mintId`, sorted `cards` keys, no id or text in events, player records or draft changes, redacted envelope, spread of deck positions over seeds and finishing orders, no `Game.drafts`); settle slot 1 and the first judge (rng order pinned by a recording rng, event order, `nextJudge` rotation and wrap); X1 to X5 and G1 re-run with the three new enumerators; a scripted LOBBY, `startGame`, all finished, PLAYING run with round 1 open. Not covered here, by design: "after `pickWinner` every active hand is 7" (E6), the E7 PLAYING half and E12 rotation are #22 (done, see 1.5 below); moderation and `CONTENT_REJECTED` are #25; the PLAYING late-joiner paths are fixture-only until #23.

**Covered by 1.5 (#22), over the real `REGISTRY`** (`test/round-rules.test.ts`, `test/round-commands.test.ts`, `test/game.test.ts`, `test/support/round-checks.test.ts`, the checkers in `test/support/checks.ts`): E1 for `confirmSubmission`, `closeSubmissions`, `pickWinner` (command x phase, command x role, guard order with combined failures, `needsPlay`, the junk list with per-guard codes, typed junk); E5 per zone (confirm, close, pick, void, the discard and the top-up) and the conservation checker over whole games; E6 post-resolve top-up with minimum-size decks that force the reshuffle; E7, PLAYING half (`meetsMinimums` and a non-empty green deck after every command, including a real new-deck N = 3 start with exactly G_min); E9 (event scan over these commands; #26 re-runs it over the full catalog and owns `revealList`); E10; E11 (with a property over random JUDGING games); E12, rotation half (wrap, joinOrder gap, late joiner, the judge never in `submissions`, their score unchanged in their round, first judge from a scripted int, rotation checked against an independent model); E13; E14; E15 as far as reachable; X6, redraw-free half (N = 3 and N = 10, new and minimum-size decks); X1 to X5 and G1 re-run with the three new enumerators; the scripted 3-player game from `createGame` to a win (event order, rng order, final scores) and seeded N = 3 to 10 games under `runScenario`. **Not covered here, by design:** E15's accept half (`castVote`, `endGame`, `deleteGame` in FINISHED) and E4 idempotency (LLD 3); pitch moderation (#25); `passJudging`, `reassignJudge`, slots 3 and 3a, eviction, pause and resume with a null judge, E12 stall cases, E17, E18, X7 (#23); `writeIn`, `redraw`, `castVote`, E16 and X6 with heavy redraw (M7), `importDeck` (M9) and `deleteGame` (M3); `revealList` and the final event catalog (#26, LLD 3); X8 episodes and `markReminded` (#24, covered below); projection (M2). The void branches of slot 4 and `voidRound` are fixture-tested only, since nothing reaches them before eviction (#23).

**Covered by 1.6 (#23), over the real `REGISTRY`** (`test/membership.test.ts`, `test/stalls.test.ts`, `test/stall-properties.test.ts`, the checkers in `test/support/checks.ts`): E1 for `passJudging` (host only, PLAYING only, `PAUSED`, `STALE`, integer `expectedVersion`, guard order), `endGame` (host only, four phases, ENDED rejected) and the widened `join`, `leave`, `removePlayer`; E10 under `passJudging` (the new judge's entry removed, the rest in order, a write-in to `redDiscard`); E12 stall half (pass in SUBMITTING and JUDGING, pass then void, judge leave or removal then void, a non-reassigned void rotating, the judge evicted while paused with a null judge, then resumption by recovery with `JudgeChanged{from: null}`, and the `checkJudges` model); E15 accept half for `endGame` only; E17 except the `removeCard` clauses (the unit scenarios of 8.5, `evictPlayer`'s order and rng pinned with a recording rng, the property over churned games and over every order of leaves); E18 (a joiner is `writing` with no cards, activation only at a boundary or by recovery, 0 points); X7 (the requirement against an independent implementation, and every PLAYING state of a churned game meeting the minimums counting pending writers); settle slots 3 and 3a, the `PausedChanged` cancellation (Q1) and slot 1's minimums-unmet case; X1 to X5 and G1 re-run with the new enumerators. A mutation pass (skipped hand return, no green reshuffle, swapped shuffle order, unconditional red shuffle, no submission removal, no `revealOrder` filter, slot 3 without the `>= 3` test, void forgetting `judgeReassigned`, cfg-only requirement, a requirement that ignores pending writers, no `PausedChanged` cancellation, slot 3a off, a draft that is not deleted, write-in to the wrong zone, `endGame` leaving `paused`, `abortRound` dropping the green card, no `changedAtVersion` bump for a null judge) goes red for each. **Not covered here, by design:** moderation and `removeCard` (the E17 `removeCard` clauses, X10) are #25; X8 episodes and `markReminded` are #24 (covered below); `revealList` and the event catalog are #26; real `writeIn`, `redraw`, `castVote` and E16 are M7, so the write-in branches of `reassignJudge`, `evictPlayer` and `abortRound` are fixture-tested only; `importDeck` is M9; `deleteGame` and E15's `castVote` and `deleteGame` accepts are M3; E4 and CAS are LLD 3; the projection of a null `judgeId` is M2; the notification mapping of `JudgeChanged` is LLD 6; Auth deletion on leave is LLD 4; the Store applying `draftChanges` is M3.

**Covered by 1.7 (#24), over the real `REGISTRY`** (`test/waiting.test.ts`, `test/waiting-properties.test.ts`, `checkWaiting` in `test/support/checks.ts`, which `runScenario` now runs after every step of every scenario): E1 for `markReminded` (system only; WRONG_PHASE in LOBBY, FINISHED and ENDED; INVALID_ARGUMENT for a malformed `episode` or `episodeGen`; guard order; not stale-checked, not needs-play) and the no-op rules (wrong episode, stale or future `episodeGen`, not yet due by one millisecond, paused, empty `waitingOn`, a null episode); the accepted advance in WRITING, SUBMITTING and JUDGING (`reminderDueAt = now + 24 h`, `version + 1`, `events: []`, nothing else differs; settle runs and keeps the advance; chained calls 24 h apart); X8 scenarios through real commands: episode and `episodeGen` change on writing start, round open, close, judge change, void and un-pause (WRITING with the same key and a higher generation, and PLAYING by recovery), and not on a submission or `finishWriting`; `waitingOn` per phase; a late joiner in WRITING, SUBMITTING and JUDGING joins `waitingOn` with the episode, generation and clock untouched and leaves on `finishWriting`; `saveDraft` by a late joiner accepted and by a `ready` player `WRONG_PHASE`; `reminderDueAt` null when paused, FINISHED and ENDED; P-X8 over seeded games with churn and `markReminded` calls (due, stale generation, wrong episode) under `runScenario` with a clock that advances an hour per step, `waitingOn` against an independent model written from 4.2, and the sharpness of `checkWaiting`. A mutation pass (advance by `due + 24 h`, advance to `now` with no 24 h, ignore `episodeGen`, ignore the episode, ignore `now >= due`, ignore `paused`, ignore an empty `waitingOn`, reset `waitingSince`, a late joiner bumping the episode, `finishWriting` starting an episode, a user actor accepted) goes red for each. **Not covered here, by design:** the Store's EventDoc for `markReminded` and the `Reminder` outbox row (M3); the sweep, recipients and delivery (LLD 6); wire rejection of `markReminded` from a client (LLD 5, API4); `writeIn`, `redraw`, `castVote` phases (M7); projection (M2); moderation and `removeCard` (#25); the event catalog (#26). The same-key void-then-reopen path (a void that reopens under the stored key) is covered by a hand-built state and the unit test of `waitingFields` only: 297 voids over 399 seeded churn games never reopened under the stored key, because a void from SUBMITTING cannot happen while unpaused and a void from JUDGING changes the round phase in the key.

**Covered by 1.8 (#25), over the real `REGISTRY`** (`test/moderation.test.ts`, `test/moderation-wiring.test.ts`, `test/remove-card.test.ts`, `test/support/removal.ts`, `checkRemoveCard`): V1 normalize (folds, idempotence property); V2 `check` structure and passes; M4 (pure, total, deterministic, every term variant caught, every `ALLOW` entry passes, import scan); M3 (reasons, no input in the rejection); M1 at the four entry points (table and P-M1, guard order after 7 and before 9); the pitch (blank is none, `TOO_LONG`); `saveDraft` every text every call; NAME_TAKEN through the fold; M2 (P-M2, later writes follow the mode, `finishWriting` does not re-moderate); `removeCard` V10 to V14 (guards, reach, per zone, minimums with piles, conservation, P-X10) with an enumerator written from 8.6 and added to the churn driver, so X1 to X5, G1, P-E5 and P-E17 re-run with it. A mutation pass (see the PR ledger) goes red for each mutant. **Not covered here:** `writeIn` and `importDeck` moderation and the later-`writeIn` clause of M2 (M7, M9); real wordlist content (M7); client reason rendering (LLD 5, 7); the Store's `removeCard` EventDoc and `draftChanges` (M3; the Engine has no EventDoc builder, 11); the Projector on a removed history card (M2); host UI (M4). The "not covered" notes of 1.4 to 1.7 above that name moderation, `CONTENT_REJECTED`, `removeCard` or X10 as #25 are closed by this paragraph.

**Covered by 1.9 (#26), over the real `REGISTRY`** (`test/events.test.ts`, `test/selectors.test.ts`, `src/index.test.ts`): the event catalog against section 11 and the `DomainEvent` union (23 tags; four deferred with no emitter, by a source scan); the exact ordered events per registered command (a scripted game from `createGame` to round 2, then the side-effect paths: `closeSubmissions`, a winning `pickWinner`, `passJudging` in both phases and the void, judge `leave` and `removePlayer`, `removeCard` with and without a void, `endGame`, `markReminded` due and not due) and the `PausedChanged` that rides with `leave`; the EventDoc inputs (`redactEnvelope` true for `finishWriting` only, `seed`, `events: []` for `markReminded` and `saveDraft`, no events on a rejection or an `aggregateChanged: false` acceptance); N2 (field whitelist plus a text scan, with counters proving rounds and pitches were in flight, and a sharpness test for the whitelist); E9 re-run over every command of seeded churn games (not only the round commands); every selector of section 14 but `exportPools` (total, pure under `deepFreeze`, copies), `revealList` (JUDGING only, `revealOrder`, no player id by deep scan, V3), `ownSubmission` (own play only), `awards` and `votesFor` on fixtures, and the public export list. A mutation pass (see the PR ledger) goes red for each mutant. **Not covered here:** the stored `EventDoc`, contiguous versions and the omission of `seed` and the actor from the raw document (M3); outbox rows and notification mapping (M6); `writeIn`, `redraw`, `castVote`, E16 and vote-driven `awards` (M7); `DeckImported`, `importDeck` redaction and `exportPools` (M9); `GameDeleted` and the `deleteGame` row (M3, #36); the Projector's use of the selectors and a removed history card (M2); host UI and API exposure (M4). **This paragraph closes the earlier pointers:** the "until #23" items of 1.4 and 1.5 (late-joiner PLAYING paths, the void branches of slot 4 and `voidRound`) were proven by #23, `revealList` and the event catalog (named for #26 in 1.5 to 1.7) by #26.

Additional scripted scenario tests (unit): full 3-player game to a win using `scriptedRng`; stalled judge in `SUBMITTING` and `JUDGING` including the void case (judge + one submitter whose card is the new judge's); redraw with an exhausted deck; paused recovery; People's Choice awards with ties; `passJudging` guarded by stale `expectedVersion`.

## Open questions / conflicts

1. **Error taxonomy gaps (proposed codes).** HLD 4.3 has no code for: playability unmet or nothing to close (`NOT_PLAYABLE`), malformed or out-of-range payload (`INVALID_ARGUMENT`), variant disabled or used up (`VARIANT_UNAVAILABLE`). Proposed in 5.3 with enumerated `detail` strings. Alternative is to fold them into `WRONG_PHASE`, which would hide useful reasons. LLD 5 must add them to `@dc/contracts` or veto them.
2. **Scheduler writes the aggregate.** Tech-stack section 6 has the sweep "advance `reminderDueAt` by 24 h"; HLD T1 says the Scheduler never changes game state. **Resolved by LLD 3 section 7 (accepted by LLD 6):** the `markReminded` system command (7.4) is adopted; the write is serialized with player commands and gets an EventDoc with `events: []`; it emits no domain event, and the Store writes one `Reminder` outbox row in the same transaction, which LLD 6 delivers; `Actor` has `system`.
3. **E18 versus pause deadlock.** "Late joiners never receive cards mid-round" plus "paused until a third player joins" deadlocks when the only way to un-pause is a late joiner waiting for the next round boundary. Chosen: activate ready players immediately when paused (settle step 3); they sit out the in-flight round. This bends E18's literal text (they receive cards, but not in the round). **Proven by #23** (`test/stalls.test.ts` V9: a late joiner's `finishWriting` un-pauses a paused game, the activated player sits out and gets `NOT_AUTHORIZED` `sitting_out`).
4. **E15 versus voting on the final round.** E15 says only read commands and `endGame` after `FINISHED`; People's Choice votes on the final round could never be cast. Chosen: `castVote` (and `deleteGame`) are accepted in FINISHED.
5. **Notification triggers missing from HLD 3.8.** **Resolved by user decision U1 (C-WRITING):** 11.1 now notifies on `WritingStarted`, on `JudgeChanged` (the new judge, plus the old judge when `reason == "passed"` and the round is `SUBMITTING`, since they now owe a card; LLD 6 3.2) and on un-pause; the Engine keeps an episode in WRITING (4.2) so reminders cover WRITING, SUBMITTING and JUDGING. A late joiner's activation needs no trigger (the next `RoundOpened` covers it). LLD 6 maps these.
6. **`greenDiscard` is dead.** HLD pools list `greenDiscard`, but gameplay.md gives green cards no discard path (won cards go to piles; voided cards return to the deck). The field is kept, always empty. Remove it if HLD allows.
7. **Void round and judge rotation.** After a void caused by `passJudging` (the new judge held the only submission), the replacement round's judge is the passed-to player. Rotating one further was the alternative. **Resolved:** kept and now stated in gameplay.md ("Stalled judge"). Mechanism (review fix R1): `reassignJudge` sets `round.judgeReassigned`, and `voidRound` reopens with that judge explicitly instead of calling `nextJudge`, which would have skipped them because the cursor already points at them (8.3). The same applies to a void after a judge `leave`/`removePlayer`. **Proven by #23** (V8: pass then void, leave then void, removal then void, and a non-reassigned void rotating).
18. **Write-ins are indistinguishable (K-A, decided).** Write-in cards stay in the game and recirculate through `redDiscard`. No event (`SubmissionConfirmed` has no `variant`), EventDoc (`commandType: "confirmSubmission"` for `writeIn`), outbox row, `RoundRecord`, history summary or other viewer's view marks a card or submission as a write-in; `powerUsage` is server-only and projected only to its owner. **Accepted residual:** players may still guess that a card is a write-in from unfamiliar text or style.
19. **Judge evicted while paused (decided).** If the judge is evicted and no other active player exists (only possible while paused), `round.judgeId` is null until settle can resume play, then `nextJudge(active, judgeCursor)` takes over with `JudgeChanged{from: null, reason: "resumed"}` (8.2 step 3a, 8.3). LLD 2 must tolerate a null `judgeId` in a paused round; LLD 6 maps `resumed` like `left`. **Proven by #23** (V5, V9: the judge evicted as the last active player while paused, then a real chain of a joiner finishing, recovery, resumption, void and reopen under the resumed judge).
20. **A revealed play vanishing from JUDGING shrinks `submittedBy` and the reveal list (resolved, issue #28).** Three paths remove a revealed play from a JUDGING round: `removeCard` (8.6), a submitter who `leave`s or is removed (E17 step 1), and `passJudging` or judge eviction, where `reassignJudge` removes the new judge's own play from `revealOrder`. Without a trace a diff of the projected `submittedBy` would name the author of a card that is ownerless before `WinnerPicked` (E8, E9, V3). **Resolved (#28):** `Round.played: PlayerId[]`, snapshotted by `closeRound`, pruned by `evictPlayer` and `reassignJudge` (the players' own, public actions: the signal is accepted and pinned in `test/project/oq20.test.ts`), never by `removeCard` (the host's silent action). In JUDGING the Projector's `submittedBy` is `played` sorted by `joinOrder`, so after a removal the table shows N players played and N-1 cards, and nothing names the author. `resolveRound` computes `absent` from `played`, so the removed card's author is not recorded absent. This is a change to the M1 Engine shape (the earlier text said Engine behaviour stays as built), made before M3 persists `Game`; `RoundSummary`, `RoundRecord` and the 8.6 preconditions are unchanged. **Residual signal, accepted:** if that author later leaves, `played` shrinks while the reveal does not, which tells an observer the leaver wrote the removed card; it follows the leaver's own public action and concerns a card that is already withdrawn.
8. **gameplay.md silences filled by this LLD**: tie-breaks for People's Choice (co-winners) and the podium (votes, then round, then play order); one vote per voter per round, replaceable; votes allowed for any resolved round; the judge may vote; the tie-after-round sentence is moot since each round awards exactly one point.
9. **Aggregate size and votes.** **Resolved** by `MAX_VOTES = 1500` (`vote_cap`, 7.1; LLD 5 8.2) and `MAX_TOTAL_JOINS = 50` (`join_cap`, via monotonic `totalJoins`), which together bound `votes[]` and `players[]` (LOBBY leavers' deleted records can no longer be churned without limit). Moving votes to a subcollection stays an option if the cap proves too low.
10. **Target and N after start.** The default target is frozen at `startGame`; late joiners raise `N` without changing `T`. gameplay.md's table is silent about growth. Alternative: recompute the default if the host never overrode it (changes win conditions mid-game; rejected).
11. **Wordlist content and policy.** The mechanism and the `removeCard` guard are **resolved by #25** (placeholder list of fake tokens; content stays with M7). The module defines mechanism only. The actual term list, whether any "hard" list applies when the filter is off (gameplay.md says off for adult groups), and the language scope need a content decision. Also, `removeCard` guarded by minimums (8.6) means a host cannot delete an offensive card from a game sitting exactly at `R_min`/`G_min`; the escape hatch is `endGame`. **Decided (U3):** guard kept, and removal is limited to cards shown to the table (8.6).
12. **`writeProgress` and `drafts[]` placement.** HLD lists `drafts[]` on the aggregate and `writeProgress` on players; tech-stack stores drafts in a subcollection. Resolved here as described in 4.1 (counts mirrored, text in drafts docs, `saveDraft` bumps the aggregate only on count changes). LLD 3 must accept the `draftChanges` side channel and the `aggregateChanged: false` path.
13. **`updateSettings` phase.** HLD table: LOBBY only. Q8 says a mid-game profanity change is fine. Chosen: `profanity` only is allowed in WRITING and PLAYING.
14. **Name uniqueness scope.** I4 says unique within a game; departed players' names are freed here (uniqueness among seated only), so history may show two players with one name in rare cases. Alternative: reserve names forever.
15. **Id and uid conventions.** The Engine assumes the app mints `PlayerId` and that seat uid is `seat:{gameId}:{playerId}`, and takes `gameId`, `roomCode`, `hostPlayerId` as `createGame` inputs. LLD 4 and 3 must confirm.
16. **Event docs and versions (decided).** Every accepted command with `aggregateChanged: true` writes `events/{version}` (possibly `events: []`); versions are contiguous with the aggregate version, no gaps. LLD 3 2.3/5.5 and its `events` wording must match (it previously allowed gaps). **Engine half proven by #26** (the events, `seed` and `redactEnvelope` the Engine hands over, `test/events.test.ts`); the stored document, contiguity and the omission on the raw doc are LLD 3 (M3). `finishWriting`, `importDeck` and `writeIn` omit `seed` and `actorPlayerId` from their EventDoc (C-EV).
17. **Leaver score pile (declared decision, not open).** A departing or removed player's score pile returns to the green deck; points leave with them (8.5 step 2, U2).

## Interfaces to other LLDs

| LLD | Engine provides | Engine expects |
|---|---|---|
| 2 Projector | `Game`, `Round`, `RoundRecord`, `Player` types; selectors in section 14 (`revealList`, `submittedBy`, `waitingOn`, `cardsStillToWrite`, `awards`, `playabilityReport`); the guarantee that `Game` has no authorship (E8) and that owners are public only after `WinnerPicked`; `actorRole` for viewer classification | `project`/`projectFeed` live in `packages/engine/src/project`; the Projector treats `submissionOwner` and `hand` as secret and gates by `Roles`; exposes `powerUsage` only to its owner and never projects `Submission.writeIn` (K-A); tolerates `round.judgeId == null` while paused; it reads resolved-round text from `RoundRecord` docs, not from `Game` |
| 3 Store & command transaction | `decide` result with `state`, `aggregateChanged`, `events`, `draftChanges`, `roundRecords`, `seed`, `deleteGame`; scheduler fields `phase`, `paused`, `reminderDueAt`, `waitingOn`, `waitingSince`, `episode`, `episodeGen` as top-level fields; `version` already incremented; `redactEnvelope`; the event-doc rule (item 16); section 10 boundary | Read the aggregate and (for `saveDraft`/`finishWriting`) the actor's draft doc in one transaction; supply `ctx` (`now`, `makeRng(seed)` from a CSPRNG seed, a CSPRNG `mintId`, `actor`, `drafts`); write draft changes, round records, events (`{version, at, commandType, events}` plus `seed`/`actorPlayerId` unless `redactEnvelope`; `commandType: "confirmSubmission"` for `writeIn`; one doc per `aggregateChanged` command), outbox rows, ledger, views; skip version bump and fan-out when `aggregateChanged` is false; on `deleteGame` perform S5 instead of committing; the idempotency ledger and CAS retry; single-field index on `reminderDueAt` (no `paused` filter) |
| 4 Identity | `actorRole`, `seatUid` convention, the rule that commands resolve `uid` to a player through `game.players[].uid`; `join` requires `actor.uid === seatUid(...)`; `PlayerRemoved`/`PlayerLeft` events to trigger Auth user deletion and token revocation | Mints `playerId` and seat tokens before calling `join`; confirms uid format; supplies `hostId`/`hostPlayerId` for `createGame`; host reissue needs no Engine command |
| 5 Command API & contracts | Payload field list in section 7, `ErrorCode` set including proposed codes, `Rejection.detail` enum values, `expectedVersion` semantics (5.3 step 3) | Defines zod schemas and exports `Command`/`ErrorCode` types from `@dc/contracts`; validates the envelope; passes `expectedVersion` through untouched; maps `EngineInvariantError` to an internal error; maps `Rejection` to the wire; `markReminded` is callable only by the system actor (never from a client callable) |
| 6 Notifications & Scheduler | Event catalog with exact payloads (section 11), the trigger table (11.1), `waitingOn`/`episode`/`episodeGen`/`reminderDueAt` maintenance, `markReminded{episode, episodeGen}` | Resolves recipients from events and post-state, dedupes `(eventId, uid)` (N1), never includes text (N2); runs the sweep query on the denormalized fields; implements the 11.1 trigger table (U1) |
| 7 Web Client | Nothing directly (the client never imports the Engine); derived values reach it through `GameView` | Renders `Rejection` codes and `detail` strings (including `CONTENT_REJECTED` reasons) as user copy; does not recompute counts or rules |