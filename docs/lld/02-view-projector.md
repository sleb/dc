# Deep Cuts: LLD 2, View Projector & GameView

Status: draft v0.1. Companion to [gameplay.md](../gameplay.md), [high-level-design.md](../high-level-design.md) (HLD), [tech-stack.md](../tech-stack.md), [00-platform-build-deploy.md](./00-platform-build-deploy.md) (LLD 0) and [01-game-engine.md](./01-game-engine.md) (LLD 1). This LLD specifies `project` and its helpers in `packages/engine/src/project/`: who the viewers are, exactly what each sees in every phase, how the per-viewer view documents are fanned out, what a stored round record contains, and how the anonymity guarantee is tested. It builds on LLD 1's names and types unchanged (`Game`, `Player`, `Round`, `RoundRecord`, `RoundSummary`, `Draft`, `Roles`, `actorRole`, the section 14 selectors, the section 11 events). The HLD's V1 to V7 are kept as written; refinements and additions here are numbered **PJ1 onward** so the HLD numbering is not disturbed. Where this document had to choose, the choice is stated with a one-line rationale; real gaps and conflicts are collected in "Open questions / conflicts". "Must" statements are testable.

## 1. Scope and principles

- `project` is the only function that turns a `Game` into something a client may read (V1). Everything else in this document exists to make that one function easy to trust: a closed allowlist of output fields, one fan-out routine that cannot forget a viewer, and a test harness that tries to break both.
- Pure and total (PJ1): output depends only on `(game, viewer)`. No clock, no randomness, no I/O, no reading of Firestore. Timestamps in the stored envelope are supplied by the caller.
- **Content authority.** `GameView`, `ViewDoc`, `RoundDoc` and their zod schemas live in `packages/contracts` (LLD 5 owns the files; tech-stack section 8). This LLD specifies their content and semantics; the TypeScript below is normative for field names, nullability and meaning. `contracts` imports no workspace package (LLD 0 section 3), so the view types cannot reference `Game`, `Player` or `Card`, which is the structural half of the type guard in section 11.6.
- Optional keys are omitted, never `undefined` (X2/Firestore); "nothing here" inside a present section is `null`.
- Out of scope: Firestore transactions and rules (LLD 3), identity (LLD 4), command envelope (LLD 5), notifications (LLD 6), rendering (LLD 7).

## 2. Package layout and public API

```
packages/engine/src/project/
  index.ts          # public exports (below)
  viewer.ts         # Viewer, viewerFor, viewersOf, docIdOf
  base.ts           # shared (viewer-independent) part of a view, built once per projector instance
  you.ts            # the only module allowed to read hands, own submission, own votes, powerUsage
  host.ts           # HostPanel
  turn.ts           # YouTurn derivation
  projector.ts      # project, makeProjector (split out of index.ts in 2.3 so fanout.ts imports it without a cycle)
  fanout.ts         # fanOut, fanOutWith (test seam), assertViewDoc, sameContent, draftRegion, ViewWrite, the region field lists
  size.ts           # utf8Length (the PJ14 counter)
  feed.ts           # toRoundDoc, projectFeed
  rev.ts            # export const PROJECTOR_REV = 1
packages/engine/test/project/   # section 11
```

```ts
export function project(game: Game, viewer: Viewer): GameView;
export function makeProjector(game: Game): (viewer: Viewer) => GameView;   // builds the shared part once
export function viewerFor(game: Game, uid: Uid | null): Viewer;            // null = anonymous spectator
export function viewersOf(game: Game): ViewTarget[];                       // every doc that must exist
export function fanOut(prev: Game | null, next: Game, o: { now: number; storedRev: number }): ViewWrite[];   // storedRev = the viewsRev of the stored docs (store.viewsRev)
export function draftRegion(draft: Draft | null, seq: number): { draftSeq: number; draft: Draft | null };
export function toRoundDoc(rec: RoundRecord): RoundDoc;
export function projectFeed(records: readonly RoundRecord[], sinceRound?: number): RoundDoc[];
export const PROJECTOR_REV: number;
export const VIEW_REGION_FIELDS: readonly [...];   // the mergeFields lists of 8.4
export const DRAFT_REGION_FIELDS: readonly [...];
```

`project`/`projectFeed` are the names LLD 1 section 2.1 re-exports. Signatures differ from the HLD's (3.6): `project` is unchanged, `projectFeed` takes records rather than `(game, viewer)`; reasons in sections 3.1 and 7. Allowed imports inside `project/`: LLD 1 types, `selectors.ts` and `@dc/contracts`. Lint (extends LLD 0 P5), on `packages/engine/src/project/**`:

- `submissionOwner`, `exportPools` and `handOf` may be imported only by `you.ts` (and `handOf` only there); no other file in `project/` may name them.
- No object spread of a `Game`, `Player`, `Round` or `Submission` value (`no-restricted-syntax` on spread of identifiers typed from `../types`, backed by the strict-schema check in PJ2). View objects are built field by field.

**As built (2.2, #28).** `packages/engine/src/project/` held `index.ts`, `viewer.ts`, `base.ts`, `you.ts`, `host.ts` and `turn.ts`; `fanout.ts`, `feed.ts` and `rev.ts` were 2.3 (#29), so there was no `PROJECTOR_REV` yet. The Engine index exported `project`, `makeProjector`, `viewerFor`, `viewersOf`, `docIdOf` and the types `Viewer` and `ViewTarget`. `ViewTarget` is `{ docId, viewer }`; `docIdOf(viewer)` is the uid, or `"spectator"` for the shared doc. `project` throws `EngineInvariantError` (fail closed, nothing is guessed) for a `player` viewer who is not seated and for a host viewer whose uid is not the host's; whether a viewer gets the host panel is decided by the game (`seat.uid === hostId`), not by the viewer's own `isHost`. `makeProjector(game)` builds the shared part once (`base.ts`); the views it returns share that part's nested arrays and objects, so callers treat them as immutable.

**As built (2.3, #29).** `project/index.ts` is now only the public export list; `makeProjector` and `project` moved to `projector.ts` so that `fanout.ts` can import them without a cycle. New: `rev.ts` (`PROJECTOR_REV = 1`), `size.ts` (`utf8Length`), `fanout.ts` and `feed.ts`. The Engine index adds `fanOut`, `draftRegion`, `toRoundDoc`, `projectFeed`, `PROJECTOR_REV`, `VIEW_REGION_FIELDS`, `DRAFT_REGION_FIELDS` and the type `ViewWrite`; `fanOutWith`, `assertViewDoc`, `sameContent` and `utf8Length` are exported from their files for the tests and stay out of the index. The details are in 8.1 to 8.4 and 11.5 to 11.7.

The lint (eslint.config.js, tested in `lint-test/lint-policy.test.ts` L8) is a little stricter than the two bullets: `handOf` and `ownSubmission` may be imported only by `you.ts`, and `submittedBy` (time order, PJ6), `submissionOwner` and `exportPools` by no file in `project/` (PJ4: never called); and the spread rule is syntactic, not type-aware, and bypassable: it bans every object spread except one named `base`, so a Game value spread under that name, `Object.assign` or `structuredClone` of a Game value get past it, and the strict schema (PJ2) and review are the backstop; in `project/**` the only object spread allowed is `...base`, the shared part built from named fields. The base `CLOCK_AND_ENTROPY` and import rules are re-spread in the `project/**` block because a later flat-config block replaces the earlier one's options.

## 3. Viewers

### 3.1 The `Viewer` type

```ts
type Viewer =
  | { kind: "player"; uid: Uid; playerId: PlayerId; isHost: boolean }   // seated: status writing | ready | active (incl. the host's own seat)
  | { kind: "spectator"; uid: Uid | null; isHost: boolean }             // uid null = the shared spectator doc; isHost true = a host with no seat
  | { kind: "departed"; uid: Uid; playerId: PlayerId; reason: "left" | "removed" | "gone" };
```

This is the HLD's `{kind: 'player'|'spectator', playerId?, isHost}` widened by one kind (`departed`) and by `uid` (so the doc key is derivable from the viewer). The judge is not a viewer kind: judge-ness is a property of the game (`round.judgeId`), computed inside `project` from `playerId`, so a judge change cannot leave a stale viewer. Audiences in the view (section 4) are: `player`, `host` (unseated host), `spectator`, `departed`.

### 3.2 Deriving a viewer: `viewerFor(game, uid)`

Uses `actorRole(game, {kind:"user", uid})` from LLD 1 section 6, plus a lookup of departed records:

| Condition (first match) | Viewer |
|---|---|
| `roles.playerId !== null` (seated) | `player`, `isHost = roles.host` |
| `roles.host` (host with no seat: left, removed themselves, never seated) | `spectator`, `uid = hostId`, `isHost = true` |
| `uid` matches a `players[].uid` with status `left` or `removed` | `departed`, `reason = status` |
| otherwise (including `null`) | `spectator`, `uid = null`, `isHost = false` |

Order matters: a host who has left their own seat has a `left` player record whose `uid` equals `hostId`; the host rule wins, so the host never receives a tombstone (PJ9). LLD 1 `Roles.spectator` also covers departed players for command authorization; the view distinguishes them because they must not see the game (section 5.4).

### 3.3 The full viewer set: `viewersOf(game)`

```ts
interface ViewTarget { docId: string; viewer: Viewer }
```

| docId | Viewer | Included when |
|---|---|---|
| `player.uid` (`seat:{gameId}:{playerId}`, or `hostId` for the host's seat) | `player` | one per player with status `writing`, `ready` or `active` |
| `hostId` | `spectator{uid: hostId, isHost: true}` | host has no seated player record (and `hostId` is not already a `player` doc) |
| `"spectator"` | `spectator{uid: null, isHost: false}` | always (its `enabled` flag carries `settings.spectators.enabled`) |
| `player.uid` | `departed` | one per player with status `left` or `removed` whose `uid !== hostId` |

`viewersOf(next)` is complete for fan-out, and `fanOut` additionally tombstones any docId present in `viewersOf(prev)` but absent in `viewersOf(next)` (LOBBY `leave` deletes the player record, LLD 1 7.2) with reason `"gone"`. Cardinality: seated (at most 10) + spectator + optional host + departed (bounded by total joins; see open question 9).

### 3.4 Key stability, rejoin, and the host's shared seat

- The doc key is the Firebase `uid` (tech-stack section 5). A seat's uid is `seat:{gameId}:{playerId}` (LLD 1 `seatUid`) and never changes: `rejoin` mints a fresh custom token for the same uid (tech-stack section 4) and a host `reissue` rotates only the stored secret hash. So a rejoining player's listener path is unchanged and nothing is rewritten on rejoin (PJ10).
- The host's seat has `uid = hostId` (the host's email-link uid), so the host has exactly one doc, `views/{hostId}`, whether seated or not. When the seat is lost the doc is rewritten as the unseated-host view (hand gone, host panel kept). When the host has a seat, the doc is a `player` view with the host panel attached.
- Anonymous spectators share `views/spectator`; their per-device uids never key a view doc, so uid churn is irrelevant. A removed player's Auth user is deleted (tech-stack 4) so they cannot rejoin; a new join gets a new `playerId` and uid, and therefore a new doc.
- `"spectator"` cannot collide with a uid: seat uids contain `seat:` and Firebase-generated uids are 28 characters.

## 4. `GameView` and the stored document

### 4.1 The view document (envelope)

```ts
// games/{gameId}/views/{docId}
interface ViewDoc {
  schema: 1;                  // wire schema version
  viewsRev: number;           // PROJECTOR_REV that produced `view` (K-F; was `rev`); orders same-version snapshots (8.4)
  gameId: GameId;
  enabled: boolean;           // spectator doc: settings.spectators.enabled; all other docs: true. Read by the spectator rule (tech-stack 5)
  version: number;            // == view.version (duplicated at top level for rules, queries, debugging)
  generatedAt: number;        // ctx.now of the commit that wrote this region; display/debug only
  view: GameView | null;      // null only when enabled == false (spectator doc)
  // second region, written independently (section 8.4); absent (or null for `draft`) unless the viewer is a writer.
  // Optional on purpose: `ViewWrite.doc` omits both so a fan-out write cannot clobber them (built as optional in contracts, #27).
  draftSeq?: number;
  draft?: Draft | null;       // the viewer's OWN unfinished draft text; Draft is LLD 1's { red: string[]; green: string[] }
}
```

The `view` region is a complete replacement every time it is written (never a delta), which is what keeps F2 true. The `draft` region exists because saving a draft must not fan out to every viewer and must not require reading other players' drafts (LLD 1 4.1: `saveDraft` does not bump the aggregate unless counts change).

### 4.2 Types

```ts
type GameView = SpectatorView | HostView | PlayerView | DepartedView;

interface LiveViewBase {                        // everything a spectator sees
  kind: "live";
  gameId: GameId;
  version: number;                              // aggregate version this view was projected from (V6)
  phase: Phase;                                 // LLD 1: LOBBY | WRITING | PLAYING | FINISHED | ENDED
  paused: boolean;
  settings: PublicSettings;
  target: number;                               // effectiveTarget(game); preview in LOBBY
  targetFrozen: boolean;                        // game.target !== null
  writeCounts: { red: number; green: number } | null;      // game.writeCounts (per-player counts), null before startGame
  players: PlayerPublic[];                      // ordered by joinOrder; includes departed (needed to render history)
  waitingOn: PlayerId[];                        // selector waitingOn(game); who the game is waiting for (WRITING, SUBMITTING, JUDGING)
  round: RoundPublic | null;                    // non-null only in PLAYING
  resolved: number;                             // history.length; round docs 1..resolved exist (section 7)
  winnerId: PlayerId | null;                    // FINISHED
  awards: AwardsView | null;                    // FINISHED or ENDED, peoplesChoice variant on
}
interface SpectatorView extends LiveViewBase { audience: "spectator" }
interface HostView      extends LiveViewBase { audience: "host"; host: HostPanel }              // host with no seat
interface PlayerView    extends LiveViewBase { audience: "player"; you: YouView; host?: HostPanel }
interface DepartedView  { kind: "departed"; audience: "departed"; gameId: GameId; version: number; reason: "left" | "removed" | "gone" }

interface PublicSettings {                      // Settings minus writeCountsOverride (host panel)
  targetOverride: number | null; profanity: "on" | "off";
  variants: { pitch: boolean; writeIn: boolean; redraw: boolean; peoplesChoice: boolean };
  spectators: { enabled: boolean; vote: boolean };
}

interface PlayerPublic {
  id: PlayerId; name: string; joinOrder: number;
  status: PlayerStatus;                         // writing | ready | active | left | removed
  isHost: boolean;                              // player.uid === game.hostId (the uid itself is never exposed, PJ7)
  score: number;                                // scorePile.length
  cardsLeft: { red: number; green: number } | null;   // selector cardsStillToWrite, only while status == "writing"
}

interface RoundPublic {
  number: number; judgeId: PlayerId | null; phase: RoundPhase;   // null only while paused after the last active judge was evicted (LLD 1 8.3, oq 19)
  green: { id: CardId; text: string };
  expected: PlayerId[];                         // non-judge active roster members (who may submit), by joinOrder
  submittedBy: PlayerId[];                      // who has submitted, never what; sorted by joinOrder, NOT by time (PJ6)
  reveal: RevealCard[] | null;                  // JUDGING only
}
interface RevealCard { submissionId: CardId; text: string; pitch: string | null }   // revealOrder order; no owner

interface AwardsView {                          // selector awards(game); tallies appear only here
  peoplesChoice: PlayerId[];
  podium: { rank: 1 | 2 | 3; round: number; cardId: CardId; playerId: PlayerId; votes: number }[];
}

interface YouView {                             // the viewer's own secrets and affordances
  playerId: PlayerId; status: PlayerStatus; isHost: boolean; isJudge: boolean;
  turn: YouTurn;                                // section 4.4
  score: number;
  roomCode: string;                             // shown so players can invite; not given to spectators (R2)
  hand: { id: CardId; text: string }[];         // PLAYING and status == "active" only; [] otherwise
  writeTarget: { red: number; green: number } | null;
  cardsLeft: { red: number; green: number } | null;
  powerUsage: { writeIn: boolean; redraw: boolean };      // own only (PJ5)
  yourSubmission: { cardId: CardId; text: string; pitch: string | null } | null;   // SUBMITTING/JUDGING, own
  myVotes: Record<string, CardId>;              // keys = round numbers as strings, ascending; peoplesChoice only
}

interface HostPanel {
  roomCode: string;
  playability: { n: number; target: number; totals: { red: number; green: number }; rMin: number; gMin: number; meets: boolean };  // playabilityReport(game)
  writeCountsOverride: { red: number; green: number } | null;
}
```

There is deliberately no `result` field (the HLD's representative view had one). Resolved rounds, with owners, texts and pitches, are the `RoundDoc`s of section 7; the view carries only `resolved` so the client knows how many to expect. Rationale: texts of old cards are not derivable from `Game` once a card is removed or a pitch is dropped, a record is already world-readable, and omitting them keeps every view small and uniform.

### 4.3 Departed viewers

`DepartedView` contains no player list, settings, round or card. It tells the client "you are no longer in this game" and nothing else. A removed player's Auth user is deleted and their refresh tokens revoked (tech-stack 4), but an already-issued ID token stays valid for up to an hour and Firestore rules cannot check revocation, so an open listener could keep reading `views/{uid}` for that time. The tombstone is what it reads. After it, the client may call the `spectate` callable and follow the shared spectator doc if enabled (this is also what a voluntary leaver gets).

### 4.4 `YouTurn`

`you.turn` is computed once, here (`turn.ts`, `youTurn`), so the client never derives rules (C1, LLD 0 open question 5). Precedence as built (#28), first match wins: LOBBY; `over` (FINISHED or ENDED, which also beats a late joiner's `write`); `write` or `ready`; `paused`; `sit_out`; then the judge or submission state. A PLAYING game with no round (never the case once settled) falls back to `wait`.

```ts
type YouTurn = "lobby" | "write" | "ready" | "submit" | "submitted" | "judge" | "wait" | "sit_out" | "paused" | "over";
```

| Phase and state | `turn` |
|---|---|
| LOBBY | `lobby` |
| WRITING or PLAYING, status `writing` | `write` |
| WRITING or PLAYING, status `ready` | `ready` |
| PLAYING and `paused` (status `active`; `write` and `ready` come first, so a paused late joiner is still `write` or `ready`) | `paused` |
| PLAYING, active, not in `round.roster` (activated by paused recovery, LLD 1 8.2 step 3) | `sit_out` |
| SUBMITTING, judge | `wait` |
| SUBMITTING, non-judge, no submission / has submission | `submit` / `submitted` |
| JUDGING, judge | `judge` |
| JUDGING, non-judge | `wait` |
| FINISHED, ENDED | `over` |

## 5. Redaction tables

Legend: **Y** visible; **own** the viewer's own value only; **-** absent (key omitted); **host** visible only if `isHost`. Columns: **Pl** non-judge player, **Jd** judge, **H** host with a seat (a Pl or Jd plus the host panel), **HU** host with no seat, **Sp** spectator (shared doc), **Dp** departed. Every Y in a Pl cell is also a Y for Jd and H unless a note says otherwise.

### 5.1 Shared fields (`LiveViewBase`)

| Field | Pl | Jd | H | HU | Sp | Dp | Phase notes |
|---|---|---|---|---|---|---|---|
| `kind`, `gameId`, `version`, `audience` | Y | Y | Y | Y | Y | Y | `Dp` gets the reduced `DepartedView` only |
| `phase`, `paused`, `settings`, `target`, `targetFrozen`, `writeCounts` | Y | Y | Y | Y | Y | - | `writeCounts` null before `startGame` |
| `players[]` (`id`, `name`, `joinOrder`, `status`, `isHost`, `score`) | Y | Y | Y | Y | Y | - | departed players stay listed with `score: 0` |
| `players[].cardsLeft` | Y | Y | Y | Y | Y | - | non-null only for status `writing` with a non-null `writeTarget` (WRITING, or a late joiner in PLAYING; null in LOBBY, #28); counts, never texts (V4) |
| `waitingOn` | Y | Y | Y | Y | Y | - | `[]` in LOBBY, FINISHED, ENDED |
| `round` | Y | Y | Y | Y | Y | - | null outside PLAYING |
| `round.green`, `number`, `judgeId`, `phase`, `expected` | Y | Y | Y | Y | Y | - | public by gameplay.md (the green card is revealed to all) |
| `round.submittedBy` | Y | Y | Y | Y | Y | - | SUBMITTING and JUDGING; who, never what (V3). SUBMITTING: from the live submissions; JUDGING: from `Round.played` (as built in #28, LLD 1 OQ 20), so a host `removeCard` does not shrink it. A player who leaves or is removed, or who is passed the judging, drops out of the list (open question 8) |
| `round.reveal` | Y | Y | Y | Y | Y | - | JUDGING only, same list in the same order for everyone (PJ6); includes `pitch` when the variant is on; no owner and no write-in marker (PJ5) |
| `resolved`, `winnerId` | Y | Y | Y | Y | Y | - | `resolved` = number of immutable round docs; `winnerId` FINISHED only (gated by the phase, not by the field: null in ENDED even if the stored field were set, #28) |
| `awards` | Y | Y | Y | Y | Y | - | FINISHED or ENDED with `peoplesChoice` on; null before. Votes are never tallied in any earlier view (PJ5) |

`round.reveal` for non-judge players deliberately matches HLD V3 ("non-judges see the same list and no owners") and gameplay.md ("all submitted red cards are shown in random order"). A player who is `writing` or `ready` (late joiner) sees it too.

### 5.2 Viewer-specific fields

| Field | Pl | Jd | H | HU | Sp | Dp | Phase notes |
|---|---|---|---|---|---|---|---|
| `you` | own | own | own | - | - | - | any phase with a seat |
| `you.hand` | own | own | own | - | - | - | only PLAYING and status `active`; `[]` in every other phase, including FINISHED and ENDED (PJ9) |
| `you.yourSubmission` | own | - | own | - | - | - | SUBMITTING and JUDGING for a non-judge who submitted; null once the round resolves. The card also appears in `reveal`, which is fine because the owner knows it |
| `you.powerUsage` | own | own | own | - | - | - | never shown for other players: a visible write-in flag would identify the owner of the write-in card among the reveals (PJ5). It is the only place write-in or redraw usage appears; no `reveal` entry, `players[]` entry, `RoundDoc` or other viewer's doc marks a card or submission as a write-in (K-A) |
| `you.writeTarget`, `cardsLeft` | own | own | own | - | - | - | status `writing` with a non-null `writeTarget` only (late joiners included); both null in LOBBY, never `{0, 0}` (#28) |
| `you.myVotes` | own | own | own | - | - | - | only with `peoplesChoice`; a spectator's votes are held by the client (open question 5) |
| `you.roomCode` | own | own | own | - | - | - | not in the spectator doc (R2) |
| `you.turn`, `isJudge`, `isHost`, `score`, `status`, `playerId` | own | own | own | - | - | - | |
| `host` (`roomCode`, `playability`, `writeCountsOverride`) | - | - | host | host | - | - | every phase including ENDED, for a seated and an unseated host (ruling in #28: `HostView.host` is required by the schema). Pool sizes and thresholds only; no card identities |
| `draft` region (`ViewDoc.draft`) | own | own | own | - | - | - | WRITING, or PLAYING for a late joiner with status `writing`; cleared (`null`) by `finishWriting` and on eviction |

### 5.3 What each phase contains

| Phase | What the views carry |
|---|---|
| LOBBY | Players and statuses, effective target preview, settings, host panel (playability). No `round`, no hands, `you.turn = lobby` |
| WRITING | `cardsLeft` per writer, `waitingOn` = unfinished writers, own `draft` region. Others' drafts, and every card in the pools, are absent (V4, E8). After `finishWriting` the player sees only `ready`; their own cards are not shown back to them (they are anonymous now) |
| PLAYING / SUBMITTING | Green card, `expected`, `submittedBy`, own hand and own `yourSubmission`. No texts of anyone else's submission, and no owner/card pairing in any view |
| PLAYING / JUDGING | `reveal[]` for everyone in `revealOrder` order, `submittedBy`, own hand. No owners (E9) |
| PLAYING and `paused` | Same data as the underlying phase plus `paused: true`; `you.turn = paused` for active players. Hands stay visible. `round.judgeId` may be `null` (judge evicted with no one to take over, LLD 1 8.3); then `isJudge` is false for everyone and `turn` is `paused` as usual. A paused `JUDGING` round may also hold an empty reveal list (a `removeCard` emptied it while paused, LLD 1 8.2, 8.6); it is voided on recovery. On resume the Engine assigns a judge (`JudgeChanged{from: null, reason: "resumed"}`) |
| Round resolves | The same commit that finishes the round writes `rounds/{n}` (owners, texts) and rewrites every view with the next round (or FINISHED). Views carry `resolved = n` |
| FINISHED | `winnerId`, `awards`, `round: null`, `you.hand: []`, `turn = over`; all history in round docs |
| ENDED | As FINISHED without `winnerId`; `round: null`. Views remain readable until `deleteGame` (Q10) |
| Late joiner | Sees everything a player sees (status `writing`, then `ready`) with an empty hand and `turn` of `write`, `ready`, then `sit_out` or the normal turn once activated at the next boundary |

### 5.4 What a removed or departed player sees

On the commit that sets their status to `left` or `removed` (or deletes their LOBBY record) their doc is rewritten, in that same transaction, to `view: DepartedView` with `draft: null`. They see nothing else of the game through that doc; the shared spectator doc and the world-readable round docs remain open to anyone with the game id (see open question 2). Their hand, pile and draft were already released by the Engine (E17).

## 6. Redaction invariants

The HLD's V1 to V7 stand. They are refined as follows; each new rule has a test in section 11.7.

| # | Rule | Refines |
|---|---|---|
| **PJ1** | `project`, `makeProjector`, `viewersOf`, `fanOut`, `toRoundDoc` are pure and deterministic; equal inputs give byte-equal JSON. | V1 |
| **PJ2** | **Closed allowlist, fail closed.** A view is assembled field by field. Before any view is written or returned, it is parsed with the strict contracts schema (`z.strictObject`); an unknown key, a missing key or a size over the hard cap (PJ14) throws, aborting the command transaction (nothing commits). **As built (2.3):** the parse, the envelope checks (`enabled` iff `view`, `gameId`, `viewsRev`, `doc.version == view.version`, no draft-region keys) and the cap live inside `fanOut` (`assertViewDoc`), the one routine every view write passes through, so the Store cannot skip them; the Store's own `ViewDocSchema.parse` (LLD 3 5.2) is a redundant second check. The thrown `EngineInvariantError` carries zod issue paths and codes and numbers only, never a value (a leaked card text must not reach a log). `fanOut` returns the object it built, not the parse clone. `project()` itself is not parsed: the API wrapper parses the command response (LLD 5 API8). | V1 |
| **PJ3** | **Card exposure allowlist.** In a viewer's doc (view and draft regions), a card id or card text may appear only if it is: in the viewer's own hand; the viewer's own submission; the current green card; in `reveal` (JUDGING); in `awards.podium` (id only); or the viewer's own draft text. Every other card, including all of the pools, other hands, and other drafts, is absent. | V2, V4 |
| **PJ4** | **No owner/card association.** Before `WinnerPicked`, a pending submission's `cardId` appears in a doc only at the paths `view.round.reveal[*].submissionId` and `view.you.yourSubmission.cardId`, and no object holding a pending `cardId` also holds a `playerId`. `submissionOwner` is never called by the Projector. | V3, E9 |
| **PJ5** | **Own-only data.** `hand`, `yourSubmission`, `draft`, `powerUsage`, `myVotes`, `writeTarget`, `roomCode` (outside the host panel) are projected only from the viewer's own player record. Vote tallies are not exposed before FINISHED or ENDED. **Write-ins are indistinguishable (K-A):** `powerUsage` is the only projected trace of write-in or redraw usage and appears only in its owner's doc; no other path in any doc (reveal, `yourSubmission`, `players[]`, `RoundDoc`) carries a write-in marker, so from another viewer's docs a write-in card cannot be told from a hand card. | V2, V4, E8 |
| **PJ6** | **Reveal stability and non-correlation.** `reveal` equals `round.revealOrder` order exactly and is identical for every non-departed viewer in the same state. `submittedBy` and `expected` are sorted by `joinOrder`, never by submission time, so neither correlates with `revealOrder`. Across commands inside one JUDGING round, the order of the surviving cards never changes (E10). | V3, E10 |
| **PJ7** | **No identity or internal fields.** No doc contains a `uid` (own or others), `hostId`, any token or secret, a seed, `episode`, `waitingSince`, `reminderDueAt`, `changedAtVersion`, `openedAt`, event data or the Auth-derived `seat:` prefix. Host-ness is exposed only as `isHost` booleans. | V4 |
| **PJ8** | **Subset chain.** The spectator view's JSON is a subset (same path, same value) of every player view's JSON from the same state, apart from `audience`; the unseated-host view is a subset of the seated host's view (apart from `audience`). | V5 |
| **PJ9** | **Minimal terminal and departed views.** `DepartedView` contains no game state. FINISHED and ENDED views have `round: null` and `hand: []`. The host rule beats the tombstone rule (3.2). | V7 |
| **PJ10** | **Versioning.** `view.version` is the aggregate `version` of the state it was projected from; per doc the pair `(version, viewsRev)` never decreases lexicographically (a rebuild at the same `version` raises `viewsRev`); `ViewDoc.version === view.version`; a rejoin or link reissue writes nothing. `draftSeq` increases by 1 per draft write. | V6 |
| **PJ11** | **Fan-out completeness.** After every committed command, for every `ViewTarget` of `viewersOf(next)`, the stored doc's `view` equals `project(next, viewer)` ignoring `version` and `generatedAt`; every docId in `viewersOf(prev)` but not `viewersOf(next)` holds a tombstone; no other doc changed. Skipping unchanged views never breaks this. | V6 |
| **PJ12** | **Atomic with state.** `fanOut` output is written in the same transaction as the aggregate, events and round docs (S2); no committed state exists whose views are not written. | S2 |
| **PJ13** | **History safety.** A `RoundDoc` is written once, only for resolved rounds, contains no votes, hands, drafts, write-in markers or other rounds' data, and is identical for every reader. | V7, S3, E8 |
| **PJ14** | **Size.** Test budget: each view doc at most 64 KiB serialized at the worst case (10 players, 80-code-point cards in UTF-8 worst case, 140-character pitches). Runtime hard cap: 512 KiB, enforced with PJ2. The Firestore limit is 1 MiB. **As built (2.3):** `VIEW_DOC_BUDGET_BYTES` and `VIEW_DOC_MAX_BYTES` are in `@dc/contracts` (`limits.ts`); the size is the UTF-8 length of the doc's JSON (`utf8Length`), a proxy for Firestore's own count, which is close to but not the same as it. | tech-stack 5 |
| **PJ15** | **Canonical shape.** Objects are built with a fixed key order and `Record` keys inserted ascending, so `JSON.stringify` is canonical; arrays are ordered (by `joinOrder`, `revealOrder`, round number). **As built (2.4):** the fixed order is the order the strict contracts schema declares the keys, recursively, with one convention: in a live view `audience` leads (the projector spreads the shared base after the tag, as pinned by the goldens since 2.2; the tombstone keeps `kind` before `audience`, as declared). Record keys ascend (for the integer-like keys of `myVotes` JavaScript guarantees it). `test/project/keyorder.ts` walks the zod definitions and the suite checks every `fanOut` doc and every `RoundDoc` (detector `keyOrder`). The earlier wording, "canonical equality `JSON.stringify` vs sorted-key stringify", could not hold: schema order is not alphabetical, and sorting would reorder every doc and force a `PROJECTOR_REV` bump for no reader benefit. Byte determinism itself is PJ1 (A5). | PJ1 |

Notes on V3 and "opaque ids". `submissionId = cardId` (LLD 1 3.1) and card ids are random and uncorrelated with owners or with join order, so showing them leaks nothing. The only people who ever see the id of a card that is not in a public place are its holder and, after it is submitted, everyone in JUDGING. A card that returns to a hand later (after the pass, after resolution and reshuffle) is again private.

## 6.1 Example (JUDGING, a non-judge player; abridged)

```json
{ "kind": "live", "audience": "player", "gameId": "g1", "version": 57, "phase": "PLAYING", "paused": false,
  "round": { "number": 4, "judgeId": "p_k3m", "phase": "JUDGING",
             "green": { "id": "c_9x2", "text": "Sticky" }, "expected": ["p_a1b", "p_c2d"],
             "submittedBy": ["p_a1b", "p_c2d"],
             "reveal": [ { "submissionId": "c_q7w", "text": "Pizza", "pitch": null },
                         { "submissionId": "c_t4e", "text": "The DMV", "pitch": "ask anyone" } ] },
  "you": { "playerId": "p_a1b", "turn": "wait", "hand": [ /* 7 cards, own */ ],
           "yourSubmission": { "cardId": "c_q7w", "text": "Pizza", "pitch": null }, "...": "..." }, "...": "..." }
```

## 7. Resolved history: `rounds/{n}` and `projectFeed`

### 7.1 What replaces `projectFeed(game, viewer, sinceRound)`

LLD 1 keeps only id-only `RoundSummary` in the aggregate and returns the full `RoundRecord` in `Accepted.roundRecords` at `pickWinner`; texts and pitches exist nowhere else (a later `removeCard` deletes from the registry). So the feed cannot be projected from `Game`. The feed is the set of immutable `games/{id}/rounds/{n}` docs, and:

```ts
interface RoundDoc {                         // authoritative in contracts
  schema: 1;
  round: number; judgeId: PlayerId; winnerId: PlayerId; winnerCardId: CardId;
  green: { id: CardId; text: string | null };
  plays: { playerId: PlayerId; cardId: CardId; text: string | null; pitch: string | null }[];   // revealOrder order (RoundRecord.playsDetail)
  absent: PlayerId[];                        // roster members who did not play
  resolvedAt: number;
  redacted: boolean;                         // true once a moderation removal blanked a text (open question 3)
}
function toRoundDoc(rec: RoundRecord): RoundDoc;                                 // field rename and null-fill only, no viewer input
function projectFeed(records: readonly RoundRecord[], sinceRound?: number): RoundDoc[];   // round > sinceRound, ascending
```

`projectFeed` no longer takes a viewer: the document has one shape for every reader, which is exactly what makes it safe to make world-readable. It exists for tests, local tools and any future non-Firestore adapter (`GET /feed?since=N` in HLD section 5). `RoundRecord.plays` is dropped as redundant with `playsDetail`. **As built (2.3):** `toRoundDoc` builds the doc field by field in schema order, `pitch ?? null` (an empty pitch stays `""`), `redacted: false`, and does not parse (the Store parses what it writes); `projectFeed` filters `round > sinceRound` (default 0), sorts numerically and throws `EngineInvariantError` if a round appears twice among the results. Queries order by the `round` field, not by doc id (string ids `"10"` sort before `"2"`).

### 7.2 Why a round doc is safe for any signed-in user (PJ13)

- Everything in it became public at the instant the result was committed (gameplay.md "Result: ... everyone sees who played what"; HLD V3 last sentence; E9). Nothing in it is hidden for a still-open round: it is created in the transaction that resolves the round and never before.
- It contains ids, card texts and pitches, but no write-in marker (a write-in play looks like any other play, K-A), not names (names are in `players[]` of the view, so a name is not duplicated into an immutable doc), not hands, not drafts, not authorship (which does not exist after E8; a player's own authored text is not recorded anywhere).
- Spectators and players see the same history (V5, V7), so "readable by any signed-in user who knows the game id" adds no exposure beyond what both audiences already have, subject to open question 2 (spectators can be disabled).

### 7.3 What must not go in it

- **Votes.** Voting is allowed on any resolved round later (LLD 1 8.8), so a vote tally would make the doc mutable, violating S3. Tallies appear only in `awards` at the end. gameplay.md creates no conflict: it shows only the final award and podium.
- **Pitch text: in.** A pitch is part of what was played ("a short written justification ... with their card"); the history feed shows "every card played and who played it". Excluding it would hide the funniest part of a round. It is moderated at write time (M1). No conflict with gameplay.md; note that a pitch is shown to the judge before the result (section 5.1) and writing style may hint at an author. That is inherent to the variant (open question 10).
- Anything keyed to a viewer (`myVotes`, own hand at the time).
- **Write-in markers.** Neither `plays[]` nor any other field says a card was written in (K-A; `RoundRecord` carries none, LLD 1). Accepted residual: a reader may guess from unfamiliar text.

## 8. Fan-out and the store boundary

### 8.1 Algorithm

```ts
interface ViewWrite {
  docId: string; doc: Omit<ViewDoc, "draft" | "draftSeq">;   // view region fully populated; the type cannot carry the draft region (8.4)
  clearDraft?: true;                           // a seated player's doc stopped being a player's (left, removed, gone, host left the seat): the Store also sets draft = null
}
function fanOut(prev: Game | null, next: Game, o: { now: number; storedRev: number }): ViewWrite[] {
  const skip = o.storedRev === PROJECTOR_REV;          // a skip is only allowed while the stored docs already carry this rev
  const pn = makeProjector(next), pp = prev && makeProjector(prev);
  const before = new Map(prev ? viewersOf(prev).map(t => [t.docId, t]) : []);
  const out: ViewWrite[] = [];
  for (const t of viewersOf(next)) {
    const v1 = pn(t.viewer);
    const b = before.get(t.docId);
    if (skip && b && pp && sameContent(pp(b.viewer), v1)) continue;   // sameContent ignores only the view's top-level `version`, and compares `enabled`
    out.push(write(t, v1, next, o.now));
  }
  for (const [docId, b] of before) if (!nextIds.has(docId)) out.push(tombstone(docId, b, "gone"));
  return out;
}
```

- The set is computed from the **states**, never from events. Events could narrow it (a `SubmissionConfirmed` obviously changes every view; a `PausedChanged` changes all), but an event-to-viewer table is a second source of truth that can silently disagree with `project`, and a missed viewer is a stale-secret or stale-state bug. Correctness therefore never depends on events (PJ11). Events are not an input.
- The projections of `prev` and `next` are both computed in memory (PJ1): there are no extra Firestore reads for the comparison.
- `prev === null` (createGame) writes every target; `fanOut(null, g)` equals `fanOut(g, g, {storedRev: 0})`, which is what the rebuild uses. `deleteGame` writes nothing (LLD 1 7.3).
- **As built (2.3).** Targets in `viewersOf(next)` order, then tombstones in `viewersOf(prev)` order. A doc is `{schema, viewsRev, gameId, enabled, version: next.version, generatedAt: now, view}`, built in that key order (PJ15, checked by the suite since 2.4). The shared spectator doc when `settings.spectators.enabled` is false is `enabled: false, view: null`, at the game's version, and is skipped like any other when unchanged (4.1; the sketch above ignored it). `sameContent(a, b)` compares `enabled` and the view with only its top-level `version` omitted (so neither `generatedAt` nor the doc's own `version`). A tombstone is the departed view with reason `gone`, `version = next.version`; a later leave or removal is a `departed` doc from `viewersOf(next)`, not a tombstone, and the host leaving the seat never gets one (PJ9). `clearDraft` is set exactly when the previous viewer of that doc was a `player` and the next is not, so a rebuild, a first write and a join never set it and `draftSeq` is not bumped on every rebuild. Two targets with the same docId throw `EngineInvariantError` rather than write one doc twice. Rejoin and link reissue leave the state equal and so write nothing (PJ10). Every doc passes `assertViewDoc` before it is returned (PJ2, PJ14).
- `aggregateChanged: false` commands (draft-only `saveDraft`, no-op `markReminded`) skip `fanOut` when the stored `store.viewsRev` equals `PROJECTOR_REV`; the Store writes only the draft region (8.4). When `store.viewsRev` differs (behind after a deploy, or ahead after a rollback; see 8.2), the Store calls `fanOut(game, game, {now, storedRev: store.viewsRev})` anyway (K-F; `fanOut` will not skip, because that value is not `PROJECTOR_REV`), writes every view at the unchanged `version` with the new `viewsRev`, and sets `store.viewsRev`. The rebuild decision is independent of `aggregateChanged`; the one exception is a no-op system `markReminded`, which stays zero-write (LLD 3 5.6; the next user command or `rebuildViews` refreshes the views).
- Output order is `viewersOf` order (joinOrder, then host, spectator, departed) so transactions are deterministic and diffable in tests.

### 8.2 Skip-unchanged: worth it, with a guard

Decision: on by default. Rationale: it is cheap (the equality is one `JSON.stringify` compare of an under 20 KiB value) and it removes real noise rather than just write cost, since every skipped write is also a snapshot, a client render and a billed listener read for each viewer. Concretely it removes the writes in these common cases:

| Command | Views that change | Typical writes saved of ~11 |
|---|---|---|
| `markReminded` (hourly, per waiting game) | none | all 11 |
| `castVote` | the voter's own `myVotes` (and all at game end) | ~10 |
| `confirmSubmission`, `finishWriting`, `saveDraft` with count change, `closeSubmissions`, `pickWinner`, membership | essentially all | none |
| `updateSettings` | all (settings is public) | none |

At the game's scale the money is negligible either way (tech-stack section 10); the stated value is fewer snapshots and the `markReminded` case, which would otherwise rewrite every doc each day for every waiting game. The one hazard is a stale stored doc that no longer equals `project(prev, v)` (the projector code changed in a deploy). Guards:

- The aggregate document carries `store.viewsRev` (LLD 3 2.2; it is not part of the Engine's `Game`). **Store contract (K-F, implemented by LLD 3):** on every user command, accepted with or without an aggregate change (and every aggregate-changing system command; a no-op `markReminded` writes nothing), if `store.viewsRev !== PROJECTOR_REV` (behind after a deploy; ahead after a rollback to older code, which fails safe by rebuilding everything, and which should still ship a higher constant so clients do not discard its docs) the Store runs `fanOut` with `storedRev = store.viewsRev` and writes `store.viewsRev = PROJECTOR_REV` in the same transaction, so the first command of any kind after a projector deploy (a draft-only `saveDraft` included) rewrites every doc once. Each written `ViewDoc` carries `viewsRev = PROJECTOR_REV`. `PROJECTOR_REV` only increases; a rollback of projector code ships with a higher constant so clients do not discard its docs.
- Any change to the golden view corpus (section 11.5) must bump `PROJECTOR_REV`. **As built (2.3):** `test/project/rev.test.ts` fingerprints the 43 view goldens and the 7 envelope cells of `envelope-cells.ts` (what `fanOut` writes for a player, an unseated host, an enabled and a disabled spectator, a departed and a `gone` doc, and the draft region; sha256 of the sorted-key JSON of every `(cell name, value)`). `rev-pins.json` was generated once with the envelope cells included (rev 1 is unreleased, so that took no bump). The test compares the current fingerprint with `test/project/rev-pins.json`, which holds one pin per revision. It fails on a changed corpus without a bump, on a bump without a pin, on a gap, and on a revision below the newest pin; it needs no git state, so it works on batch branches. Changing a golden therefore means: bump `PROJECTOR_REV`, add the new fingerprint as the next pin, and keep the old pins. This replaces the earlier `git diff` wording; P8's `git diff --exit-code` after the tests is unchanged and still catches a snapshot regenerated and left uncommitted. Limits, stated: a view change that no golden covers is not detected; the current pin could be edited in place instead of bumping (review catches it; pin-history immutability in CI is not built); `RoundDoc` is outside the fingerprint (its golden is a snapshot only); and a stored `gone` tombstone cannot be rebuilt by a projector deploy (nothing in `viewersOf(next)` regenerates it).
- The skip is decided from `storedRev`, never from a caller's boolean: `fanOut(prev, next, {now, storedRev: 0})` disables it, and there is no flag a caller can set inconsistently with what is stored. **As built (2.4):** `fanOut` takes `{now, storedRev}` (there is no `skipUnchanged` boolean any more, added after review); a doc is skipped only when `storedRev === PROJECTOR_REV`, so a deploy behind or a rollback ahead rewrites every doc by construction, and a caller cannot ask for a skip it has no evidence for. Covered by `fanout.test.ts` (every fixture: an equal `storedRev` skips a version-only step, `0`, `PROJECTOR_REV - 1` and `PROJECTOR_REV + 1` write every doc) and by `store-sim.ts`, whose `commit` passes `store.viewsRev`.

### 8.3 Size budget

A view stays far below 1 MiB. Worst case at 10 players: hand 7 cards, reveal 9 cards plus 140-character pitches, roughly 220 characters per card pair, at most 4 UTF-8 bytes per character: about 8 KiB for `reveal`, 3 KiB hand, 2 KiB `players` for ten seated (a departed entry is about 100 bytes), `myVotes` about 40 bytes per round the viewer voted in (500 rounds is 20 KiB), `awards` under 1 KiB. Typical 3 to 10 KiB; budget 64 KiB (PJ14). The draft region is under 4 KiB (at most 10 red and 8 green texts of 80 code points). A test generates the maximal fixture and asserts the budget, and PJ2 enforces the 512 KiB hard cap at runtime so a bug cannot reach the 1 MiB limit unseen. **As built (2.3):** `test/project/maximal.ts` builds a 10-player JUDGING game (9 reveal cards of 80 four-byte code points, 140-code-point pitches, 24-code-point names, 7-card hands) and a FINISHED game with the host holding 1500 votes; every doc, with a worst-case draft region added, must be at most 64 KiB. Measured: the largest doc is about 35 KB (the host's, with 1500 `myVotes`), a JUDGING player's about 14 KB, the spectator's about 11 KB (golden table in `fanout-golden.test.ts`). The hard cap is tested at exactly 512 KiB (passes) and one byte over (throws), and with an inflated projector through `fanOut`.

### 8.4 `version`, drafts and staleness

- V6 is realized as `view.version` plus `ViewDoc.viewsRev` (PJ10, K-F). A client keeps the highest view it has seen for its doc, ordered by the pair `(version, viewsRev)` lexicographically, and applies a snapshot only if its pair is greater or equal. Equal means identical content; lower means older, including an older-projector snapshot at the same `version`, which is discarded in favor of a rebuilt one. A command response carries only `version`: the client applies it if `version` is at least the held `version`; a stale snapshot at the same version that arrives after it is followed by the rebuilt snapshot the same transaction wrote, so the doc converges.
- Because of skip-unchanged, a doc's `version` can lag the aggregate: it is the version at which that viewer's content last changed, not the latest commit. This is safe in both directions: a command response carrying version 10 and content identical to the stored version-8 doc makes the later arrival of the v8 snapshot harmless (it is ignored, equal content), and a real later change arrives with a higher version. The client must never infer "I am behind" from `view.version < aggregate version` on its own doc; the response `version` of its own command is the freshness signal.
- **Draft region.** A draft save changes only `draft` and `draftSeq` and must not bump the aggregate (LLD 1 4.1). It cannot share `version` for ordering, so the draft region has its own counter: the Store keeps `seq` in the draft doc (it already reads that doc in the transaction), increments it per save and writes `draftSeq`. Clients order the draft region by `draftSeq`, the view region by `(version, viewsRev)`.
- **Disjoint writes.** The Store writes the two regions with `set(..., {mergeFields: [...]})`: fan-out writes use `["schema","viewsRev","gameId","enabled","version","generatedAt","view"]` (so the `draft` fields are untouched by anyone else's command, and another player's `finishWriting` can never wipe your draft), a draft save writes `["draftSeq","draft"]`, `finishWriting` writes both (a `clearDraft` write). This relies on top-level field replacement semantics of `mergeFields` (replaces the named top-level field wholesale, so a removed key inside `view` does not linger). LLD 3 owns the code; this LLD owns the region split. **As built (2.3):** `VIEW_REGION_FIELDS` and `DRAFT_REGION_FIELDS` are exported from the Engine, a test proves they are disjoint and together exactly the `ViewDocSchema` keys, and `ViewWrite.doc` is typed without the draft region, so a fan-out write cannot clobber it at compile time. `draftRegion(draft, seq)` returns `{draftSeq, draft}` with a fresh copy of the draft.

### 8.5 Command response `view` (HLD 4.2)

`CommandResult.view` is `makeProjector(next)(viewerFor(next, actor.uid))`, from the same projector instance and code path as the fan-out, computed once in the transaction, not read back from Firestore (no extra read). It is the caller's own `GameView` (a spectator caller gets the spectator content; a departed caller gets the tombstone). It is content-identical to the doc that fan-out wrote for that caller, or to the doc that skip-unchanged left in place, and carries `version` of the new aggregate. For a draft-only `saveDraft` there is no new aggregate version: the response returns the unchanged view and the new `draftSeq`. The response is a convenience for instant feedback; the doc is the source of truth (a client that discards the response still converges through its listener). A rejection returns no view.

## 9. Replacement for the Change Feed

### 9.1 What the feed carries now (F1 revised)

tech-stack section 2 already revises F1; this section restates the revised guarantees as the Projector's contract.

| # | Guarantee |
|---|---|
| **F1'** | The feed is the pair of read paths the Projector writes: the viewer's own `views/{uid}` doc (or `views/spectator`) and the `rounds/{n}` docs. These carry game data, but only data already redacted for exactly that audience (PJ3 to PJ9) or public by resolution (PJ13). No other channel carries game data; there is no SSE endpoint. |
| **F2'** (F2 holds) | Lossy and unordered delivery is harmless. A snapshot is a complete document, never a delta, so any single snapshot is sufficient; coalesced or missed snapshots are repaired by the next one, and `(version, viewsRev)` (PJ10) orders them. |
| **F3'** (F3 holds) | Correctness never depends on the listener. A one-shot `getDoc` of the viewer's doc (server source) on open, on focus and at a low polling rate gives the same content. |
| **F4'** (F4 revised) | Who can read what: `views/{uid}` only when `request.auth.uid == uid`; `views/spectator` by any signed-in user while `enabled == true`; `rounds/*` by any signed-in user. Spectator access is therefore capability-by-game-id, not membership of the game; HLD F4 ("subscribing requires a valid principal for that game, spectators included") is relaxed accordingly (open question 2). |
| **F5'** (new) | Views and round docs change only inside the command transaction (PJ12), so a listener never sees a view that its own state has not committed. |
| **F6'** (new) | Cross-document consistency is eventual. A client that has a view with `resolved = n` but not yet `rounds/n` shows a loading state for that round; it must not guess. |

### 9.2 Superseded HLD text

This LLD supersedes the following HLD passages for the Firebase deployment (the HLD remains the technology-neutral fallback if Firestore is ever left, per tech-stack section 2):

- Section 2 diagram: the dashed `SSE: version hints` edge to `Change Feed`, the `BUS --> CF` edge, and the legend "Dashed = hint-only channel carrying no game data".
- Section 3.1 invariant C2 wording "fetches the current view and, optionally, the feed": replaced by "listens to its view doc and the rounds collection".
- Section 3.6 interface block (`projectFeed(game, viewer, sinceRound?)`) and the sentence defining `Viewer` as `{kind: 'player'|'spectator', playerId?, isHost}`: replaced by section 3.1 and 7.1 here. V1 to V7 are unchanged.
- Section 3.7 in full: F1 ("carries no game data, only `{gameId, version}`"), F4 ("requires a valid principal for that game"), and the interface `GET /games/{id}/events` (SSE).
- Section 5 queries: `GET /games/{id}/view` (replaced by a `getDoc`/listener on `views/{uid}`), `GET /games/{id}/feed?since=N` (replaced by a query on `rounds` ordered by `round`), `GET /games/{id}/events`.
- Section 5 "Representative `GameView`": replaced by section 4.2 (no `result`; `waitingOn` is a top-level list rather than a per-player boolean; adds `you.turn`, `resolved`, `host`).
- Section 6 flow step 3 ("Change Feed pushes `{version}`; other clients refetch") and the section 6 "Returning after two days" call to `GET /feed`.
- Section 9 build-order step 3 ("Change Feed (SSE hints)"): not built; listeners arrive with step 2.
- tech-stack section 5 data-model comment "`views/{uid}` projected `GameView` for one player" (now a `ViewDoc` envelope with two regions) and the rules sentence about rounds (see open question 2). tech-stack section 2's F1 paragraph stays correct.

## 10. Determinism and performance

- **Determinism (PJ1, PJ15).** No `Date`, `Math.random`, `Intl` locale-sensitive sorts or `Object.keys` order dependence. Sorting uses numeric `joinOrder` or `round`, never `localeCompare`. Two runs of the same scenario give byte-identical docs; a test serializes every doc of a recorded game twice with different `Map` insertion orders in the harness and compares.
- **Cost.** `makeProjector(game)` builds the shared part (`players`, `round` public, `settings`, `awards`) once; each viewer only adds `you` and the host panel (a shallow assembly over frozen shared sub-objects, never mutated). Work per view is O(players + hand + submissions); the card registry is accessed by id only and never iterated. For 10 players: `viewersOf` about 11 targets, `fanOut` does about 22 projections plus 11 stringify-compares. Budget: under 5 ms in Node for the worst-case fixture, well below command latency (cold start 1 to 2 s, transaction tens of ms). The CI check is a loose assertion at 25 ms p95 over 200 runs, run by `bun test`, to catch accidental quadratic behavior, not to enforce a tight number. Built in 2.3 (`fanout.test.ts` X1, 10 players, skip on, parse and size check included): p95 under 1 ms on the development machine.
- **Allocation.** Shared sub-objects are reused across viewers within one `fanOut`; they are deep-frozen in tests so a mutation bug fails loudly (X4 style).

## 11. Test strategy

Stack as LLD 0 section 6 and LLD 1 section 15: `bun test`, fast-check, `FC_SEED` printed on failure (P11). CI `numRuns: 200` per property, nightly `2000`. Everything lives in `packages/engine/test/project/` and reuses `test/support/` from LLD 1 (`legalCommands`, `junkCommands`, `arbScenario`, `runScenario`, `scriptedRng`, `deepFreeze`).

### 11.1 Harness

`runScenario` (LLD 1 15.1) gains an `afterStep` hook receiving `{before, after, drafts, accepted, step}`. The anonymity suite plugs into it and runs after every accepted and rejected command:

```ts
interface ProjectorUnderTest {                 // the real module, or a leaky mutant
  project(g: Game, v: Viewer): GameView;
  viewersOf(g: Game): ViewTarget[];
}
function runAnonymitySuite(impl: ProjectorUnderTest, o: { numRuns: number; seed?: number }): void;   // throws on first violation
```

Scenarios use the Engine's own legal-move generators, weighted toward progress commands and membership churn (late joins, leaves, removals, `passJudging`, `removeCard`), all variants randomly on, spectators on, 3 to 10 players, `steps` up to 400. Card texts and names come from an arbitrary that guarantees **unique, fixed-width sentinels** (`R0007x`, `G0012q`, `NAME03`), so no secret is a substring of another value and no sentinel is produced by Moderation folding. Hand ids are the Engine's real random card ids (substring-safe: `c_` plus 10 chars).

**As built (2.4)** (`test/project/`, test code only: nothing under `src/` changed, `PROJECTOR_REV` and the goldens are as they were). `runScenario` has the `afterStep` hook (`AfterStepInfo`: state before and after, the draft maps before and after, `accepted`, the `Step`); it only observes, so the trace is the same with and without it. `anonymity.ts` exports `runAnonymitySuite(impl, {numRuns, seed, detectors?, coverage?, weaken?})`, `ProjectorUnderTest {project(g, v, drafts), viewersOf, toRoundDoc(rec, before), roundDocs?(prev, next, records)}` and `REAL`. `project` also receives the draft maps (a real projector never sees them, E8, and ignores the argument; a mutant that leaks them needs them), `toRoundDoc` receives the state the record resolved from (the real one ignores it; M-writein needs the marker) and `roundDocs` is the write path of a commit (default one `toRoundDoc` per record; M-resolve overrides it). The suite throws `AnonymityViolation` (detector, scenario seed, step, viewer, path) at the first violation of an enabled **detector**; the 24 detectors are `cards drafts ownership identity internals strictParse othersData writeInMarker` (the oracle), `order time subset terminal size versioning stability determinism` (cross-viewer and cross-step), `roundDocs keyOrder` and `N1` to `N6` (non-interference). Switching a detector off lets the matrix of 11.4 prove each kills its mutant alone. Scenarios are real `decide` traces: the straight driver (`progressDriver`) and a churned driver (`membershipDriver` plus LOBBY churn, `endGame`, and in JUDGING a 55% chance of `passJudging`, a leave, a removal, a `removeCard` or a join instead of the pick, which is what keeps a JUDGING round alive across commands), roughly one step in nine a junk command (rejected steps are steps), 3 to 10 players, profanity on and off, every variant and spectators on or off, wrapped by the sentinel driver (`inject.ts`: card texts `R0007x`, `G0012q`, pitches `P0003x`, fixed width and unique, unchanged by Moderation in both modes, checked for all 30000). A scenario ends when its game does (about 100 to 130 steps), so the `steps` cap of 400 is never reached. Because `writeIn`, `redraw` and `castVote` are unregistered, `inject.ts` also decorates an after-state with the shapes of LLD 1 section 3 that already exist (`Submission.writeIn`, `powerUsage`, valid `Vote`s) and checks that copy as well; it is never fed back into `decide`, except by the tests that say so (H4: real `pickWinner`, `leave` and `removePlayer`, which read the marker, accept it and pass the structural checkers). **Cost:** CI runs the real projector on 60 scenarios of a fixed seed (where the H3 coverage counters are enforced: every (phase, audience) cell of `cells.ts`, JUDGING with a reveal that differs from submission order, submission time order different from `joinOrder`, an eviction, `passJudging` and `removeCard` inside a JUDGING round, spectators and pitch on and off, paused, a FINISHED game with votes, injected write-ins, redraws and votes, 3 and 9 or 10 players, and each of N1 to N6 applied) and on 40 scenarios of the random `FC_SEED`; `FC_NUM_RUNS` overrides the random run (the nightly's 2000). That was about 30 s added to `bun test packages` when it was built (52 s to about 83 s alone, about 100 s with a second test run on the machine; `anonymity.test.ts` about 25 s, `mutants.test.ts` about 13 s), measured; the plan's 200 scenarios would have been about 70 s. As the engine grew it rose to `anonymity.test.ts` about 71 s and `mutants.test.ts` about 40 s (a 4-core container, `bun run test` 281 s in all); three test-side changes, which check exactly what was checked before, brought them to about 65 s and 21 s (`bun run test` 214 s): `runScenario` freezes the state and the command instead of cloning and deep-comparing them per step (LLD 1 X4 already asks for frozen inputs; `harness.test.ts` H2 shows a mutated state or command fails the run, and fails it only through that guard), the oracle skips the classes of a detector a run has switched off (`checkDoc` and `checkRoundDoc` take `detectors`; `oracle.test.ts` O5 shows the result is the full result filtered, for every mode), and Q1 of `store-sim.test.ts` runs both stored revisions over the same generated games (it generated them twice, at about 30 s each). The fallback of 150 steps was not needed or used: games end after about 130 steps, so the cap of 400 is never reached, and the scenario count was cut instead. Every slow test sets a generous default timeout (600 s), and `bun run test` passes `--timeout 120000` for the whole repo (bun's 5 s default failed an M1 property test on the CI runner, which is about 3 times slower than a laptop; bunfig.toml has no honoured timeout key); the cached scenarios are deep-frozen, so a projector that writes into its input throws (a `determinism` violation) instead of corrupting later runs. A weakened generator (no injection, no churn, one table size) leaves counters at zero and fails the suite (`weaken` option, `anonymity.test.ts`). Token mode of the oracle: card ids and sentinels are found in a doc by regex (an occurrence inside a longer string is still found) instead of 500 substring scans per doc; a forbidden value that is not token-shaped is still searched by `includes`.

### 11.2 The forbidden-values oracle

For each `t` in `impl.viewersOf(after)` the suite builds the full stored doc (`view` region plus the viewer's own `draft` region from the harness's `drafts`) and `json = JSON.stringify(doc)`. The oracle is a second, independent implementation written from gameplay.md, not from `project`:

| Class | Forbidden values for viewer `t` | Check |
|---|---|---|
| Cards | every `cards` registry id and text **except** `allowed(t)` = own hand, own submission, current green card, reveal list (JUDGING), podium card ids (id only), own draft texts | `json.includes(x)` fails the step (PJ3) |
| Drafts | every draft text of every other player, including players who later finished | substring check |
| Pending ownership | pending `cardId`s may occur only at the two whitelisted paths (PJ4); additionally a tree walk fails if any object holds both a pending `cardId` and a `playerId` | path whitelist and co-occurrence walk |
| Identity | every `players[].uid`, `hostId`, any string containing `seat:`, `#k=`, `token`, `secret`; `roomCode` for audiences without it | substring (PJ7) |
| Internals | key names `uid`, `hostId`, `seed`, `episode`, `waitingSince`, `reminderDueAt`, `changedAtVersion`, `openedAt`, `submissions`, `revealOrder`, `pools`, `cards`, `scorePile` anywhere in the tree | key walk (also caught by the strict schema parse) |
| Unknown shape | any key not in the strict schema | `GameViewSchema.parse` (PJ2) |
| Others' data | `powerUsage`, `myVotes`, `hand`, `writeTarget`, `draft` of any player other than `t` | structural: those keys occur only under `you`, and only values of `t`'s player |
| Write-in markers (K-A) | any key or value marking a card or submission as a write-in: key names `variant`, `writeIn`, `isWriteIn`, `writtenIn` anywhere except `settings.variants.writeIn` and `t`'s own `you.powerUsage.writeIn`; the same scan over every `RoundDoc` | key walk with path whitelist (PJ5, PJ13) |

Cross-viewer checks per step: PJ6 (every non-departed viewer's `reveal` deep-equals `revealOrder` projected, same order), PJ8 (spectator JSON subset of each player's JSON; unseated host subset of seated host's), PJ9 (tombstones minimal), PJ10 (`(version, viewsRev)` never decreases per doc across steps; draft-only steps leave `version` unchanged and raise `draftSeq` by 1), PJ14 (size budget). Cross-step: reveal order of surviving cards unchanged inside a JUDGING round (E10 at the view level). Write-in indistinguishability (K-A, LLD 1 E8 clause): for every other viewer `u` and every `RoundDoc`, the JSON is unchanged when a write-in submission not owned by `u` is replaced by a hand card with the same id and text (the non-interference transformation (6) below).

**As built (2.4):** `oracle.ts` (imports only `@dc/contracts` and the Engine's types; `oracle.test.ts` O4 reads its import list) holds `allowedFor` (O1 tests it against the table, fixture by fixture), `forbiddenFor`, `checkDoc` and `checkRoundDoc` (both take an optional `detectors` set and skip the classes outside it; the result is the full result filtered, O5); `stored.ts` builds the doc the Store holds (view region plus the viewer's own `draft`). Deviations from the table above, each found by running the oracle against the real projector: (1) the ids of the viewer's **own votes** (`you.myVotes`) are allowed id-only, like the podium; the text stays forbidden. A card that was played, resolved and voted for can be dealt and played again, so its id may be both in `myVotes` and pending; `myVotes.<round>` is therefore a third path, besides `reveal[*].submissionId` and `you.yourSubmission.cardId`, at which a pending id may appear (the voter already knows the id; it says nothing about the new play), and it is checked against the viewer's own votes. (2) The identity class also forbids the room code in any doc whose viewer has no business with it (a spectator that is not the host, a departed viewer), searched as an escaped substring like every other forbidden string, so a name that embeds it is a finding too (review). (3) The internals list adds the aggregate's other private fields (`episodeGen`, `createdAt`, `totalJoins`, `roster`, `judgeReassigned`, `played`, `judgeCursor`, `writeProgress`, the four pool names, `votes` and `voter`; `votes` is allowed only as the public count at `awards.podium[n].votes`), and the identity class scans every voter string (`p:` and `s:` forms). (4) "Others' data" is checked structurally (`powerUsage`, `myVotes`, `hand`, `writeTarget` only at `view.you.*`, `draft` only at the top level, `you` only for a seated viewer) and by value against the viewer's own record. (5) A `RoundDoc` is scanned for cards of any other round or zone, open-round pitches, drafts, vote and uid strings, the internal and own-only keys and the marker keys, with no whitelist. (6) A value the viewer may see in one role is never forbidden in another: a doc is JSON, so a hidden card whose text equals someone's public pitch (or a revealed text that equals a non-public pitch) cannot be flagged, and the hidden text is still flagged when the value is not public (control in `oracle.test.ts`); found by review. The strict schema parse (class "Unknown shape") is `ViewDocSchema.safeParse` and runs on every doc of an injected state and on a sample of the others; every doc `fanOut` writes is parsed by `assertViewDoc` anyway (the `fanOut` leg of the suite, A4, passes every committed write through it). The PJ8 chain is realized as: the spectator view is a subset of every seated viewer's view and of the unseated host's; the unseated-host-in-seated-host leg has no state to compare in (a state has the host seated or not), so it is the spectator leg only, and the host panel is checked by the oracle. PJ10's `draftSeq` clause is not asserted: the counter belongs to the Store (M3, #33).

### 11.3 Non-interference test (the strong form)

Substring oracles prove that known secrets are absent. The metamorphic test proves that the view is a function of **only** what the viewer may know. For a sampled state and viewer `t`, build `game'` by applying all of these transformations, none of which `t` may be able to observe, then assert `JSON.stringify(project(game, t.viewer)) === JSON.stringify(project(game', t.viewer))`:

1. Re-mint ids and re-draw texts of every card outside `allowed(t)` (consistently across zones, via a rename map).
2. Swap two pending submissions neither of which belongs to `t` (judge, host, spectators and uninvolved players must see the same view). Three variants, each alone: swap their cards (id, pitch, write-in marker), swap their owners, swap their positions. Owner permutation on a position-ordered list does not move a card, so a reveal-in-submission-order mutant would survive it; a card swap does not move a player, so a submittedBy-in-time-order mutant would survive that.
3. Replace the texts of every other player's draft; replace others' `uid` values (not `t`'s and not the host's, whose `isHost` flag is visible) and flip their `powerUsage`; reverse the four pools.
4. Change `createdAt`, `openedAt`, `waitingSince`, `reminderDueAt`, `episode`, `episodeGen`, `changedAtVersion`, `totalJoins`. Never `hostId`: it drives the visible `isHost`.
5. Change other players' and spectators' votes. Before the end (not FINISHED or ENDED) change which cards they name and add a vote of a spectator: nothing may move, tallies are not exposed. After the end the tallies are public (`awards`) and the voters are not: re-label every other voter (tallies untouched) and nothing may move; `t`'s own votes (`myVotes`) are never touched.
6. Turn a pending or resolved write-in submission not owned by `t` into an ordinary hand-card submission with the same id and text (clear its owner's `powerUsage.writeIn`), or the reverse; applied to `RoundDoc`s too (K-A).

Failures print the minimal transformation that changed the view. This is the test that proves E9 for the judge: permuting owners must not change the judge's view.

**As built (2.4):** `noninterference.ts`: `TRANSFORMATIONS` (N1, N2a to c, N3 to N6) as pure `(game, drafts, viewer) => (game', drafts') | null`, `nonInterference(impl, game, drafts, viewer, ids)` returning the first transformation that moved the view and `firstDiff`'s JSON path (N8: the violation message names both), `SENSITIVITY` (N7: an own hand text, the green text, the reveal order and the own `powerUsage` each do move the view, so a pass is not a projector that ignores everything), `roundDocsAcrossToggle`/`resolveWith` for (6) on `RoundDoc`s through real `pickWinner`. The suite samples the judge, the shared spectator and one rotating viewer per state. (5) and (6) act on states the injector decorated (votes outside FINISHED, write-in markers); (6) toggles every non-`t` submission, so it also plants a marker on a plain submission, which is why N6 kills M-writein even without injection. A state change that none of these may move is also checked in the other direction by N7.

### 11.4 Canary and mutation strategy

The suite must be shown to fail on leaks. `test/project/mutants.ts` exports leaky projectors wrapping the real one (each is a few lines):

| Mutant | Leak | Must be caught by |
|---|---|---|
| M-hands | other players' `hand` in `players[]` | cards oracle, internals walk |
| M-owner | `owner: playerId` on each `reveal` entry | co-occurrence walk, strict schema |
| M-order | `reveal` in submission order | PJ6 / E10 check (shuffled order differs in most scenarios) |
| M-time | `submittedBy` in submission time order | PJ6 ordering check, non-interference (2) |
| M-power | `powerUsage` for all players | others' data check, non-interference (3) |
| M-writein | `writeIn: true` on the matching `reveal` entry and `RoundDoc` play | write-in marker walk, strict schema, non-interference (6) |
| M-draft | other players' draft texts in `players[].cardsLeft` | drafts oracle |
| M-uid | `uid`/`hostId` in `players[]` | identity oracle |
| M-spec | `you` block in the spectator view | PJ8 subset check, strict schema |
| M-deck | `pools` counts plus top card id | cards oracle |
| M-resolve | owners in `reveal` for `RoundDoc` before `WinnerPicked` (round doc written while JUDGING) | PJ13 check on the store simulation |
| M-votes (2.4, after review) | the aggregate's vote list, with its voter strings, in FINISHED and ENDED views | internals walk, identity oracle, non-interference (5), each alone |
| M-keyorder (2.4) | every object's keys in reverse order (shape-valid) | PJ15 key-order check only |
| M-shape (2.4) | `reveal` ordered by the owner's `joinOrder` (shape-valid) | PJ6 check and non-interference (2), each alone |

CI runs `runAnonymitySuite(mutant, {numRuns, seed: FIXED})` for each mutant under `expect(() => ...).toThrow()`; a mutant that survives fails the build. Seeds are fixed per mutant (and recorded) so detection is not probabilistic across CI runs. Optional, outside CI: a nightly Stryker or similar run against `src/project` with the suite as the oracle; hand-written mutants remain the gate because they test the specific threats in R1.

**As built (2.4)** (`mutants.ts`, `mutants.test.ts`): 14 mutants, not 11: M-keyorder and M-shape are added because the other eleven add a key (and M-votes after review: the aggregate's vote list and the voter strings in FINISHED and ENDED views, killed by `internals`, `identity` and N5 alone, N5 re-labelling every other voter after the end since tallies are public and voters are not), so the strict schema parse alone kills them and they prove nothing about the other detectors (M-order, M-time, M-keyorder and M-shape are shape-valid on purpose). Each records its fixed seed, run count (30) and the detectors that must kill it **alone**: K1 runs the suite with only that detector enabled and requires the violation to carry that detector's name; K2 requires the default configuration to kill each; K3 (`anonymity.test.ts`) requires the real projector to survive. Matrix (every cell is a test): M-hands: cards, internals, othersData (the mutant also adds `scorePile`, so the internals key walk has a key to find); M-owner: ownership; M-order: order, N2; M-time: time, N2; M-power: othersData, N3; M-writein: writeInMarker, N6; M-draft: drafts; M-uid: identity; M-spec: subset; M-deck: cards; M-resolve: roundDocs; M-keyorder: keyOrder (and nothing else kills it); M-shape: order, N2; M-votes: internals, identity, N5. Every mutant is also killed with `strictParse` switched off, and the four shape-valid ones survive `strictParse` alone. Realizations: M-writein puts `writeIn: true` on the reveal entry and, through `toRoundDoc(rec, before)`, on the `RoundDoc` play, for submissions that carry the marker (injected states); M-resolve overrides the write path (`roundDocs`) to emit a doc with owners at the command that closes the round, which `SimRounds` (store-sim.ts: written once, only for a round in `next.history`) refuses; M-keyorder reverses object keys only (integer-like record keys cannot be reordered in JavaScript). The matrix is as sensitive as the generator: M-writein survives the marker walk when the injector is off (`noInjection`), and a replay of a killed mutant gives the same message. N6 is also in the gate of the round-doc write path (`roundDocs || keyOrder || N6 || an oracle detector`), so an N6-only run also sees a write-in marker leaked through `toRoundDoc` alone (review). The Stryker nightly stays optional and unowned (no scheduled job exists, `ci.yml` only).

### 11.5 Snapshot (golden) tests

Fixtures are built with `scriptedRng` so every id is stable. One golden JSON per `(state, viewer)`, using Bun's `toMatchSnapshot`, committed under `test/project/__snapshots__/`:

**As built (#28):** Bun object snapshots in `test/project/__snapshots__/golden.test.ts.snap`, 43 cells from `test/project/cells.ts`, one per `(state, viewer)`, each reviewed by hand against sections 5.1 to 5.3 before it was frozen (the explicit assertions of `redaction.test.ts` and `turn.test.ts` are the first oracle, never a snapshot). `CI=1` refuses to write a missing snapshot. `GD2` checks the (phase, audience) coverage matrix and that the not-applicable cells (the judge outside an open round) really have none. Key order was not pinned by the goldens themselves; **as built (2.4)** the suite's `keyOrder` detector checks it (PJ15). The goldens are views only: the draft-region goldens (own `draft`) and the 10-player size fixture are #29's, as built (`fanout-golden.test.ts`: the ViewDoc envelope for a player, an unseated host, an enabled and a disabled spectator, a departed and a `gone` doc with `clearDraft`; `draftRegion`; the size table; `feed.test.ts` has the `RoundDoc` golden; all hand-reviewed against 4.1 and 7.1 before they were frozen). The 43 view goldens and the envelope cells are fingerprinted by the pin test of 8.2, so changing one needs a `PROJECTOR_REV` bump. The fixtures are `makeGame`, `roundGame` and `park` states, not scripted-rng games, with a separate property that projects real `decide` output for parse validity. The plan was:

LOBBY (host seated, other player, spectator); WRITING (writer mid-draft with own draft region, finished player, host, spectator, late joiner in PLAYING); SUBMITTING (judge, submitted player, unsubmitted player, sitting-out player, host with no seat, spectator); JUDGING (judge, non-judge, spectator, host); paused (3 to 2 active); FINISHED with People's Choice (winner, other, spectator); ENDED; departed (`left`, `removed`, `gone`); the tombstone-versus-host precedence; the 10-player maximal fixture for the size test. Roughly 35 snapshots. PRs that change a snapshot must also bump `PROJECTOR_REV` (8.2); `git diff --exit-code` after tests (LLD 0 P8) fails if a snapshot was silently rewritten.

**As built (2.5, #31).** The corpus now has a second consumer: `packages/contracts/fixtures/views/{state}__{viewer}.json` holds one committed `ViewDoc` per cell (43 files; the cell name with `/` → `__`, e.g. `writing__host-writer.json`). Each file is the view region only — `schema`, `viewsRev` (`PROJECTOR_REV`), `gameId`, `enabled`, `version`, `generatedAt` (a fixed `FIXED_NOW`), `view` — in `VIEW_REGION_FIELDS` order, with no `draft`/`draftSeq`. The Store writes the draft region on a draft save (8.4), the web reads it from its own `ViewDoc`, and the tests that need it compose it (5.5). `fixture-views.test.ts` proves all 43 docs deep-equal a `fanOut` write: 42 from `fanOut(null, game, { now: FIXED_NOW, storedRev: 0 })` — `departed/left` and `departed/removed` are departed targets from `viewersOf`, and `departed/host-precedence` is a live host doc named for its cell (its game has spectators disabled, but `enabled` is the live-doc flag and the doc is the host's, not the shared spectator doc) — and `departed/gone` through the LOBBY leave transition, with `prev` the cell game and `next` the same game without that player, whose tombstone is byte-identical to the fixture. The null-prev write at that docId is the seated player's live view (a gone player is not a viewer target), which is why the transition is the proof; the test asserts that too. The builder and writer are `test/project/fixture-views.ts` and `test/project/export-views.ts`, test-side code that ships nothing; `bun run fixtures:views` rewrites them with `JSON.stringify(doc, null, 2) + "\n"` and prunes unknown fixture-shaped `.json` files, so a renamed cell leaves no ghost and no other `.json` is touched. It is deterministic and byte-identical on a re-run, strict-parses with `ViewDocSchema`, and the files are read by `packages/contracts/test/views-fixtures.test.ts` with `ViewDocLooseSchema` (contracts imports no engine). CI `verify` runs `bun run fixtures:views` immediately before `git diff --exit-code`, asserted by `scripts/ci-policy.test.ts` on step indices. Exporting the derived files is not a corpus change, so `PROJECTOR_REV` did not move and `rev-pins.json` is untouched.

### 11.6 Type-level guards

```ts
// test/project/types.test-d.ts (checked by `bun run typecheck`, tsconfig.test.json)
type Assignable<A, B> = [A] extends [B] ? true : false;
type Expect<T extends true> = T;  type Not<T extends boolean> = T extends true ? false : true;
type _g = Expect<Not<Assignable<Game, GameView>>>;                 // a raw aggregate is not a GameView
type _p = Expect<Not<Assignable<Player, PlayerPublic>>>;           // nor are players
type _r = Expect<Not<Assignable<Round, RoundPublic>>>;
type _s = Expect<Not<Assignable<Submission, RevealCard>>>;
type Secret = "scorePile" | "pools" | "cards" | "drafts" | "submissions" | "revealOrder" | "hostId" | "uid" | "seed" | "episode";
type _k = Expect<Equal<Extract<DeepKeys<GameView>, Secret>, never>>;
type _e = Expect<Equal<GameView["audience"], "spectator" | "host" | "player" | "departed">>;
type _d = Expect<Equal<LiveViewBase["phase"], Game["phase"]>>;      // enums cannot drift between contracts and engine
```

**As built (2.4):** `test/project/types.test-d.ts` (with `types-support.ts`: `Assignable`, `Expect`, `Not`, `Equal`, `DeepKeys`), compiled by `bun run typecheck` through `tsconfig.test.json`: TY1 `Game`, `Player`, `Round`, `Submission` are not assignable to the public view shapes; TY2 `DeepKeys` of `GameView`, `ViewDoc` and `RoundDoc` contain none of the secret names (and `ViewDoc`/`RoundDoc` too, which the sketch did not list); TY3 enum equality (`audience`, `phase`, `status`, round `phase`); TY4 every guard is repeated under `@ts-expect-error` over a deliberately leaky type, so a guard that cannot fail turns the typecheck red. The runtime half is A8 in `anonymity.test.ts`: `JSON.parse(JSON.stringify(game))` fails `GameViewSchema` for every fixture and for scenario states (the strict schema is already strict; `.strict()` is not called).

Plus the structure: view types live in `contracts`, which cannot import `Game` (lint, LLD 0 section 3). The Store's write helper accepts only `ViewDoc` (LLD 3), `project` is the only producer, and PJ2's strict parse is the runtime backstop. A test also feeds `JSON.parse(JSON.stringify(game))` through `GameViewSchema.strict()` and expects it to fail to parse.

### 11.7 Invariant-to-test matrix

| Invariant | Tests |
|---|---|
| PJ1, PJ15 | Property: same scenario twice, identical bytes per step; deepFreeze of inputs (no mutation); key order equals the schema's declaration order (PJ15 as built, not a sorted-key stringify). **Built (2.4):** PJ1: detector `determinism` (a scenario replayed to identical states every eighth run, a frozen deep copy of every third state projected to identical bytes, the suite's digest equal across runs, `anonymity.test.ts` A5); PJ15: `keyorder.ts` and detector `keyOrder` over every `fanOut` doc and `RoundDoc`, M-keyorder |
| PJ2 | Strict parse of every doc each step; mutants M-owner, M-spec; hard-cap test with an inflated fixture. **Built (2.3):** `fanout.test.ts` P2a (each way `assertViewDoc` rejects), P2b (a leaky projector through `fanOutWith`; the message has paths and codes only), P2c (the built object is returned); the mutants M-owner and M-spec are #30. **Built (2.4):** both are in the matrix (11.4); every doc of every scenario is also strict-parsed by the oracle on injected states and a sample of the rest, and by `fanOut` for every write |
| PJ3 | Cards oracle (11.2); non-interference (1); mutants M-hands, M-deck, M-draft. **Built (2.4):** detectors `cards`, `drafts`, N1; the three mutants |
| PJ4 | Path whitelist and co-occurrence walk each step; non-interference (2) for judge, host, spectator; M-owner. **Built (2.4):** detector `ownership` (three whitelisted paths, 11.2 as built), N2a to c, M-owner |
| PJ5 | Others'-data check; write-in marker walk; non-interference (3), (5), (6); M-power, M-writein; unit: tallies absent until FINISHED. **Built (2.4), partial:** detectors `othersData`, `writeInMarker`, N3, N5, N6 and the two mutants, over write-in, redraw and vote states **modeled by the injector** (the projector, `fanOut` and `toRoundDoc` are invariant under the marker); the real commands do not exist yet, so the real-state proof is M7 steps 7.2 to 7.4 (`writeIn`, `redraw`, `castVote`); the tally-absence unit is `redaction.test.ts` (2.2) |
| PJ6 | Cross-viewer reveal equality, `revealOrder` equality, ordering of `submittedBy`; across-step stability through `passJudging` and eviction; M-order, M-time. **Built (2.4):** detectors `order`, `time`, `stability` (a JUDGING round kept alive by the churned driver through `passJudging`, leave, removal and `removeCard`), N2a to c, M-order, M-time, M-shape |
| PJ7 | Identity oracle and key walk; M-uid. **Built (2.4):** detectors `identity`, `internals`, N3, N4, M-uid |
| PJ8 | Subset checks (spectator in player; unseated host in seated host); M-spec. **Built (2.4):** detector `subset` (spectator in every seated viewer and in the unseated host; the unseated-host-in-seated-host leg has no state to compare, 11.2 as built), M-spec |
| PJ9 | Tombstone minimality; host-versus-tombstone snapshot; FINISHED hands empty. **Built (2.4):** detector `terminal` (exact tombstone keys, the host never holds one, `round: null` and `hand: []` in FINISHED and ENDED); the snapshot is 2.2's |
| PJ10 | Version monotonic per doc across a run; draft-only steps; rejoin and reissue produce zero writes (simulated store). **Built (2.4), partial:** detector `versioning`: every step of every scenario goes through `fanOutWith` and `SimStore.commit` (`(version, viewsRev)` never decreases, a command that changed nothing writes nothing and does not move the version, every write carries the state's version, a reissue writes nothing, `view.version` equals the state's); the `draftSeq` +1 clause is **not** asserted (the Store owns the counter; a sim counter would prove the sim): #33 (3.2). **Proved by #33** against the real Store in the Functions emulator: `functions/test-integration/store/drafts.test.ts` (30 text-only saves, `draftSeq` +1 each) and `merge.test.ts` (one write per doc, a leave at 7 stored at 8). **Built (2.3):** `SimStore.apply` throws if a doc's `(version, viewsRev)` would go down; the deploy cases are in `store-sim.test.ts` Q2 |
| PJ11 | **Store simulation** (2.3; 2.4 runs `fanOut` over its scenarios for PJ10 and PJ15 but does not repeat the full-rewrite comparison, which Q1 owns): an in-memory `Map<docId, ViewDoc>` driven by `fanOut` with the stored rev equal to `PROJECTOR_REV` (skipping) and at `0` (rewriting everything); after each step assert it equals the full rewrite `viewersOf(after).map(project)`; also with a simulated projector deploy (`viewsRev` behind), including a draft-only (`aggregateChanged: false`) first command: every doc rewritten at the same `version` with the higher `viewsRev`. **Built (2.3):** `test/project/store-sim.ts` (`SimStore`, `commit`, `divergence`, `vanished`; `commit` passes `store.viewsRev` as `storedRev`, so it skips only while the store is at `PROJECTOR_REV` and a rollback (ahead) also rebuilds everything) is driven by `fanOut` over `runScenario` traces from the straight and the churned driver, skip on and off (one property: each generated game is checked at both stored revisions); after every step the store equals a full rewrite by an oracle that is independent of `fanOut`, the docs not written are byte-unchanged, and the tombstones are exactly the ids that vanished from `viewersOf`. The test of the test is Q3: a store that kept its old docs across a projector deploy is flagged (hand-built, because `fanOut` now refuses to skip there), and the Store contract converges. #30 generalizes this to the anonymity suite; vote-driven cases are hand-built states until `castVote` is registered (M7) |
| PJ12 | Covered with LLD 3 (transaction test); here only that `fanOut` is a pure function returning every write |
| PJ13 | **Built (2.3), pure half:** `feed.test.ts` T3 over real `pickWinner` records. `RoundDoc` built only from `roundRecords`; scanned for votes, hands and other rounds; identical for all readers; equals `toRoundDoc(record)`; M-resolve. **Built (2.4):** `SimRounds` (written once, only for a round in the resolved history), detector `roundDocs` plus the oracle's `checkRoundDoc` on every doc of every scenario, the marker walk and N6 on `RoundDoc`s from a real `pickWinner` over a write-in-decorated state (partial for write-ins, as PJ5: M7 7.2 to 7.4); `removeCard` redaction of an already written doc (open question 3) is owned and proved by #33 against the real Store: `functions/test-integration/store/remove-card.test.ts` (a played card and a green card redacted, other fields byte-equal, refusals write nothing) and planner P5 (a card recycled across 91 rounds, within `MAX_WRITES`) |
| PJ14 | Maximal fixture size budget. **Built (2.4):** detector `size` on every doc of every scenario. **Built (2.3):** `size.test.ts` (S1 `utf8Length` equals `TextEncoder`, S2 the budget, S3 the cap at exactly 512 KiB and one byte over) |
| V5, V7 (HLD) | PJ8 and: no `round` state for ENDED/FINISHED; history appears only through `resolved` and round docs |

### 11.8 Companion rules tests (by reference)

LLD 3 owns `rules-test`. It must cover, for this LLD's documents: another player's `views/{uid}` denied; `views/spectator` denied when `enabled == false` and allowed when true; the departed tombstone readable only by that uid; `rounds/*` read allowed, write denied; aggregate and drafts denied. The Projector test suite and the rules suite together are the V2 to V5 guarantee: the former proves what is in each doc, the latter proves who can open each doc (LLD 0 P10).

## Open questions / conflicts

1. **Signature changes against the HLD and LLD 1.** HLD 3.6 gives `projectFeed(game, viewer, sinceRound?)` and a narrower `Viewer`; LLD 1 re-exports `project, projectFeed` and says the Projector "reads resolved-round text from `RoundRecord` docs, not from `Game`". Here `projectFeed(records, sinceRound?)` is viewer-independent, `Viewer` gains `departed`, and the HLD's `result?` is replaced by `resolved` plus round docs (section 4.2). LLD 1's export line needs only the new helper names (`makeProjector`, `viewerFor`, `viewersOf`, `fanOut`, `toRoundDoc`).
2. **World-readable round docs versus optional spectators.** tech-stack 5 says rounds are readable by any signed-in user "so correctness holds by construction (V5, V7)". But `settings.spectators.enabled` can be false; then anyone with the game id can still read all resolved history while the spectator doc is closed. Options: accept (the id is unguessable; recommended for v1), or make the rounds rule `get()` the caller's own view doc or the spectator doc's `enabled`. Also F4's "valid principal for that game" no longer holds for spectators (section 9.1). LLD 3 to decide.
3. **`removeCard` versus append-only round docs (S3, E5). Resolved (issue #33).** LLD 3 6.3 adopted the documented exception; no Engine change was needed (the Store finds the rounds from `prev.history` with `roundsContaining`). Proved by `functions/test-integration/store/remove-card.test.ts` and planner P5. Original text: A removed card's text stays in an already-written `RoundDoc`, which is world-readable. Proposal: a documented exception, rewriting that doc with `text: null` and `redacted: true`; the Store would do this in the `removeCard` transaction. Requires an Engine change to return which round docs are touched (LLD 1 8.6 does not say).
4. **Host `removeCard` reach.** gameplay.md says the host can remove "any card", but anonymity (V2, E8) means the host cannot see pool or hand cards, so in practice only cards that have been shown are removable: the current green card, cards in `reveal`, and played cards (by `cardId` from round docs). A host cannot pre-emptively remove an offensive card sitting in a deck. Recommend accepting and stating it in gameplay.md; the alternative (a host-visible pool listing) would show texts but never authorship, yet would reveal upcoming hands and so break V2 for the host-as-player.
5. **Spectator votes and the shared spectator doc.** The spectator doc is one doc for all spectators, so it cannot carry a spectator's own `myVotes`. The client keeps those locally (a repeat vote just replaces, LLD 1 8.8). The alternative is a per-spectator doc `views/{uid}` for spectator voters (added to `viewersOf` from `game.votes`), at the cost of fan-out growth. Chosen: client-local.
6. **Own drafts live in the view document.** The draft text must come back to a returning player on a new device (HLD C2), but tech-stack 5 denies the drafts doc to clients. This LLD puts it in a second region of the viewer's own doc with its own counter `draftSeq` (section 8.4), written with `mergeFields`. LLD 3 must keep `seq` in the draft doc and implement the disjoint writes. If LLD 3 prefers a `getDraft` callable, the draft region and `draftSeq` are deleted with no other effect.
7. **Skip-unchanged needs `viewsRev` on the aggregate document** (section 8.2). Resolved by LLD 3: it is `store.viewsRev`; the envelope carries `viewsRev` too (K-F) and the rebuild runs regardless of `aggregateChanged`.
8. **Eviction and `passJudging` reveal ownership of the vanishing card.** When a player is removed or leaves during JUDGING, or the host passes judging to a player who had submitted (E17, LLD 1 8.3), their card disappears from `reveal` and they disappear from `submittedBy` in the same view. Anyone who saw the earlier list can infer that card's owner. This follows from E17/gameplay.md ("that player's card goes back to their hand") and affects only a withdrawn card (the owner cannot win it), so it is accepted here, and the HLD acknowledges it (V3, added in #28). **As built (#28):** `leave`, `removePlayer` and `passJudging` of a submitter shrink `submittedBy` in JUDGING (via `Round.played`, which the Engine prunes) and the signal is pinned by `test/project/oq20.test.ts`; `removeCard` is not a signal (LLD 1 OQ 20, resolved): a host removal leaves `submittedBy` and `expected` as they were and only the reveal shrinks. Residual signals, accepted: if the removed card's author later leaves, is removed, or becomes judge via `reassignJudge`, `submittedBy` shrinks while the reveal does not, which identifies them as that card's author (pinned in `oq20.test.ts`).
9. **Unbounded player records.** Departed players stay in `players[]` (needed for history names) and each has a tombstone doc. Total joins are unbounded by the Engine (only seated count is capped at 10). Recommend LLD 3/5 cap total joins per game (for example 50) to bound view size and fan-out.
10. **Pitch text can hint at authorship.** The judge sees pitches before the result. The variant makes this inherent; no code mitigation is proposed. gameplay.md does not mention it.
11. **LLD 1 observations.** (a) `RoundRecord` duplicates `plays` and `playsDetail`; `RoundDoc` keeps `playsDetail` only. (b) `revealList(g)` (LLD 1 section 14) returns `{submissionId, text}`; the view also needs `pitch`, and a selector for the viewer's own submission (`ownSubmission(g, playerId)`) so that only `you.ts` touches the owner association. Both are small additions to selectors. (c) `RoundDoc` has no player names; LLD 1's `Player.name` is the only source, so names for departed players depend on keeping them in `players[]` (open question 9). (d) LLD 1 `Roles.spectator` includes departed players for command authorization, while the view treats them as `departed`; harmless but worth aligning in wording. (e) LLD 1 `effectiveTarget(g)` is computed from `seated.length` before `startGame`, so the lobby target preview changes as players join; after `startGame` it is frozen (`targetFrozen`).
12. **Names in an immutable doc.** Resolved-round docs hold `playerId`s, not names, so a client without the live `players[]` (a very late reader of a deleted-then-restored export) cannot render names. Accepted: names change only by leaving and rejoining under a new id, and `players[]` retains departed entries.
13. **Host seat sharing and email change.** One `views/{hostId}` doc serves both the seat and the host panel. If a future "host transfer" (deferred, I5) is added, `viewersOf` and the host rule in 3.2 change together.

## Interfaces to other LLDs

| LLD | This LLD provides | This LLD expects |
|---|---|---|
| 1 Engine | `project`, `makeProjector`, `viewerFor`, `viewersOf`, `fanOut`, `toRoundDoc`, `projectFeed`, `PROJECTOR_REV` exported from `packages/engine/src/project`; lint rules on `project/`; the test hooks `afterStep` and mutants (built in 2.4: `runScenario`'s `afterStep`, `test/project/mutants.ts`; test code, not exported) | `Game`, `RoundRecord`, `Draft`, `actorRole`, `Roles`, the section 14 selectors; additions: `pitch` in `revealList`, `ownSubmission`; `Accepted.roundRecords` (full record) at `pickWinner`; E8 (no authorship) and E9 (owner not exposed) stay true; `legalCommands`, `runScenario`, `scriptedRng` reused; a `history` summary or `RoundRecord` may name a card that `removeCard` deleted from `cards` (#25 leaves ids as they were), so the Projector tolerates a missing card text |
| 1 Engine, OQ 20 (resolved by #28) | `submittedBy` from `Round.played` in JUDGING; `expected` unchanged; the null `judgeId` and a paused JUDGING round with an empty reveal list (`reveal: []`) are projected as they are | `Round.played` (added in #28 to LLD 1 section 3): set by `closeRound`, pruned by eviction and `reassignJudge`, never by `removeCard`; `resolveRound` takes `absent` from it. No change to 8.6 |
| 3 Store & command transaction | `fanOut(prev, next, {now, storedRev})` returning every `ViewWrite` (incl. tombstones, `clearDraft`); `draftRegion`; the doc shapes `ViewDoc`, `RoundDoc`; region field lists for `mergeFields` (8.4: `VIEW_REGION_FIELDS`, `DRAFT_REGION_FIELDS`); `PROJECTOR_REV`; **`fanOut` already strict-parses and size-caps every doc it returns (PJ2, PJ14), so the Store's `ViewDocSchema.parse` is a redundant second check, kept or dropped by LLD 3** | In one transaction: write all `ViewWrite`s, round docs from `roundRecords`, state, events; pass `storedRev = store.viewsRev` (a skip needs it to equal `PROJECTOR_REV`, 8.2) and update `store.viewsRev`; maintain `seq`/`draftSeq` and write the draft region on `saveDraft`; skip `fanOut` when `aggregateChanged` is false unless `store.viewsRev !== PROJECTOR_REV` (then rebuild all views, K-F); `viewsRev` in every `ViewDoc`; strict-parse every doc before writing (PJ2; optional, `fanOut` has already done it); rules per 11.8 and open question 2; delete all docs under `views/` and `rounds/` on `deleteGame`; handle `removeCard` redaction of round docs (open question 3) |
| 4 Identity | `Viewer`/doc key rules: key = uid, stable across rejoin and reissue; host key = `hostId` | Seat uid format `seat:{gameId}:{playerId}` (LLD 1 `seatUid`); revoke on removal (the tombstone covers the ID-token window); anonymous spectator sign-in; `spectate` callable pointing at the shared doc |
| 5 Command API & contracts (schemas built in #27) | Normative content of `GameView`, `ViewDoc`, `RoundDoc`, `YouTurn`, `PublicSettings`; enumerations to keep equal to the Engine's (type test 11.6); size and nullability rules | Zod schemas as `z.strictObject` for all view types; export `GameViewSchema`, `ViewDocSchema`, `RoundDocSchema`; `CommandResult.view` is `GameView` produced by `makeProjector(next)(viewerFor(...))`; for `saveDraft` also returns `draftSeq` |
| 6 Notifications & Scheduler | Nothing at runtime: views carry no push data; `waitingOn` is exposed for display only | Notification payloads stay ids and generic copy (N2); nothing reads view docs; `markReminded` produces no view writes under skip-unchanged |
| 7 Web Client | Which docs to listen to (own `views/{uid}`, or `views/spectator`, and `rounds` ordered by `round`); `you.turn` so no rule logic is needed; the ordering rule (`(version, viewsRev)` lexicographic for view, `draftSeq` for draft, apply if greater or equal); the `resolved` handshake (F6'); `DepartedView` handling and the fallback to the spectator doc | Initialize App Check before attaching listeners (LLD 0 open question 4); persistent local cache for round docs; render `reveal`, `submittedBy` and `awards` as given without reordering; keep spectator votes locally (open question 5); never assume `view.version` equals the latest aggregate version (8.4) |
