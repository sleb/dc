# Deep Cuts: LLD 3, Game Store & Command Transaction (Firestore)

Status: draft v0.1. Companion to [gameplay.md](../gameplay.md), [high-level-design.md](../high-level-design.md) (HLD), [tech-stack.md](../tech-stack.md), [00-platform-build-deploy.md](./00-platform-build-deploy.md) (LLD 0), [01-game-engine.md](./01-game-engine.md) (LLD 1) and [02-view-projector.md](./02-view-projector.md) (LLD 2). This LLD specifies the Firestore data model, security rules, indexes, the `command` transaction, the other Store write paths (createGame, join interplay, deleteGame cascade), the reminder query, the outbox and event log, retention, and the Store's test plan. It builds on LLD 1's aggregate and `Accepted` shape and LLD 2's `ViewDoc`, `fanOut`, `viewsRev`, `draftSeq` and `RoundDoc` unchanged; where those or the HLD look wrong, the conflict is recorded rather than silently fixed. HLD invariants S1 to S5 are kept as written; new Store invariants are labeled **ST1 onward**. "Must" statements are testable. Code lives in `functions/src/store/` (Admin SDK, Node 22); it imports `@dc/engine` and `@dc/contracts` and is the only code that touches Firestore game data.

## 1. Scope and principles

- The Store is the only writer of game data (Admin SDK, service account `fn-runtime`, LLD 0). Clients never write Firestore (tech-stack section 2) and read only the documents named in section 3.
- One command is one Firestore transaction. Everything the command changes (aggregate, drafts, round docs, events, outbox, ledger, view docs, room code) commits together or not at all (S2, ST1).
- The Store contains no game rules and no redaction logic. It calls `decide` and `fanOut`, and writes what they return.
- The HLD's `load`/`commit` pair (HLD 3.5) cannot be split across a transaction boundary, so the Store's interface is `runCommand(input)`, which owns read, decide and write in one callback (section 5). `load(gameId)` remains as a read-only helper for tests and tools.
- Timestamps: game logic times (`at`, `createdAt`, ...) are epoch-ms numbers (as the Engine uses them). Only fields consumed by Firestore TTL are `Timestamp` values, and they are always named `expiresAt`.

## 2. Data model

### 2.1 Collection map

Extends tech-stack section 5. Items marked **new** are additions to that list (open question 1).

| Path | Doc id | Written by | Client read | TTL |
|---|---|---|---|---|
| `games/{gameId}` | auto-id, 20 chars | `runCommand`, `createGame`, deletion | never | none |
| `games/{gameId}/drafts/{playerId}` | `playerId` (`p_`+8) | `runCommand` | never (own text returns in the view doc, LLD 2) | none; deleted on finish/evict |
| `games/{gameId}/rounds/{n}` | round number, decimal (`"7"`) | `runCommand` at `pickWinner`; redaction (6.3) | any signed-in user (decision, 3.2) | none |
| `games/{gameId}/views/{docId}` | viewer uid (`seat:{g}:{p}`, or `hostId`) or `spectator` | `runCommand` (fan-out, draft region) | `{uid}`: that uid only; `spectator`: signed-in if `enabled` | none |
| `games/{gameId}/events/{version}` | decimal version | `runCommand` | never | none (9) |
| `games/{gameId}/outbox/{rowId}` | `v{version}_{i}` | `runCommand` | never | `expiresAt`, 14 days |
| `games/{gameId}/idem/{hash}` | base64url SHA-256 of `actor \0 key` (for `join`, `key` is the `keyHash`, never the raw key, 6.2) | `runCommand` | never | `expiresAt`, 7 days |
| `games/{gameId}/seats/{playerId}` **new** | `playerId` | Identity (LLD 4), atomically with `join` via `extraWrites` | never | none |
| `games/{gameId}/notifLog/{eventId}_{uid}` **new** | per N1 | Notifications (LLD 6) | never | `expiresAt`, 30 days |
| `roomCodes/{code}` | 4 letters, uppercase | `createGame`; deleted at FINISHED/ENDED/delete | never | none |
| `joinIdem/{keyHash}` **new** | hex `sha256(idempotencyKey)` of a join (K-C) | Identity's pure `extraWrites`, in the `join` transaction | never | `expiresAt`, 7 days |
| `deletions/{gameId}` **new** | `gameId` | `runCommand` (phase 0), deletion runner | never | `expiresAt` set when done, +7 days |
| `hosts/{hostUid}` | Auth uid | Identity (LLD 4) | never | none |
| `hosts/{hostUid}/decks/{deckId}` | auto-id | Deck Library (functions) | that host only | none |
| `hosts/{hostUid}/idem/{hash}` **new** | as above | `createGame`; the cascade's `hostIdem` stage deletes rows whose `gameId` is the deleted game | never | `expiresAt`, 7 days |
| `pushSubs/{uid}_{gameId}` | per tech-stack | Notifications callable | never | none; pruned on 404/410 |
| `rateLimits/{kind}_{key}` | per tech-stack section 7 | callables | never | `expiresAt`, 2 windows |

**TTL groups (the single list; LLD 0 configures exactly these, and every other section refers here).** One policy per collection group on field `expiresAt`: `idem` (covers both `games/*/idem` and `hosts/*/idem`), `outbox`, `notifLog`, `rateLimits`, `deletions`, `joinIdem`. Nothing else expires (ST11). LLD 0 must configure all six (open question 6).

### 2.2 The aggregate document

`games/{gameId}` holds LLD 1's `Game` with every Engine field at top level, unchanged, plus one Store-owned map the Engine never sees:

```ts
interface GameDoc extends Game { store: StoreMeta }
interface StoreMeta {
  schema: 1;
  viewsRev: number;                          // PROJECTOR_REV that produced the stored view docs (LLD 2 8.2; the same `store.viewsRev`, open question 7)
  updatedAt: number;                         // ctx.now of the last commit
  deleting: { at: number; by: Uid } | null;  // set in the deleteGame transaction; refuses all later commands (ST9)
}
```

- `load` splits `store` off before calling `decide`; `decide` returns a `Game`, and the Store re-attaches a fresh `store`. The Engine therefore stays ignorant of Firestore (X2: no `undefined`, no `Map`, no nested arrays, all of which Firestore rejects; the Admin client keeps `ignoreUndefinedProperties: false` so a bug fails loudly).
- Denormalized, top-level, queryable fields all come from the Engine's own `Game`: `phase`, `paused`, `reminderDueAt`, `waitingOn`, `waitingSince`, `episode`, `episodeGen` (K-E, LLD 1 4.2), `hostId`, `roomCode`, `createdAt`, `version`. The Store adds none and writes none of them separately: they change only when `decide` returns a new `Game` (ST12).
- Large fields are exempt from indexing (section 4) so the 40,000 index-entries-per-document limit and write-time index cost cannot matter.
- **No stored game predates the Store.** Nothing writes `games/{gameId}` before M3: the Engine is pure, `createGame` and `runCommand` are the only writers, and they land with the Store. So the persisted `Game` shape has no earlier version to migrate from, and a field the Engine adds (LLD 1's `Round.played`, M2) needs no defaulting or schema bump on read. A shape change after launch is a migration and takes `store.schema` (`StoreMeta.schema`, 2.2), not a per-field `??` fallback: a default would turn a loud failure into a wrong record (a round whose `played` defaults to `[]` records every roster member as absent).

### 2.3 Other document shapes

```ts
interface DraftDoc { red: string[]; green: string[]; seq: number; updatedAt: number }   // seq: the draftSeq source (LLD 2 8.4)
interface EventDoc { version: number; at: number; commandType: Command["type"]; events: DomainEvent[];   // events may be [] (markReminded, count-only saveDraft)
                     seed?: string; actorPlayerId?: PlayerId }   // seed and actorPlayerId are OMITTED for finishWriting, importDeck and writeIn (C-EV, E8): LLD 1 section 11 envelope otherwise; a writeIn doc records commandType "confirmSubmission" (K-A)
interface OutboxRow {
  id: string;                                            // the doc id, `v{version}_{i}`, also stored in the row
  gameId: GameId; version: number; i: number;           // i = index within the command's events (0 for a Reminder row)
  topic: "notify" | "identity";
  event: DomainEvent | { t: "Reminder"; episode: string; episodeGen: number; dueAt: number; waitingOn: PlayerId[] };   // episodeGen tells successive episodes of one kind apart (K-E)
  at: number;
  roster: { playerId: PlayerId; uid: Uid; status: PlayerStatus }[];   // seated players in the POST state, so consumers need no aggregate read
  judgeId: PlayerId | null; paused: boolean;
  round?: { number: number; phase: "SUBMITTING" | "JUDGING" };   // POST-state open round; absent in LOBBY, WRITING, FINISHED, ENDED
  waitingOn: PlayerId[];                                 // POST-state Game.waitingOn (ids only; WRITING, SUBMITTING or JUDGING)
  processedAt: number | null;                            // completion marker. notify/Reminder rows: set by LLD 6. identity rows: set ONLY by LLD 4 (section 8)
  notifAttempts?: number; poisonedAt?: Timestamp; notifSkipped?: boolean;   // LLD 6 bookkeeping
  notifDoneAt?: Timestamp | null;                        // LLD 6 progress on identity rows: written as null at creation on every identity row (so `== null` matches, section 8), absent on other rows
  expiresAt: Timestamp;
}
interface IdemDoc { at: number; expiresAt: Timestamp; commandType: string; version: number; draftSeq?: number; meta?: Json /* <= 1 KiB */ }
interface CreateLedgerDoc extends IdemDoc { commandType: "createGame"; version: 1; gameId: GameId; roomCode: string }   // hosts/{hostUid}/idem/{hash} (#34); IdemDoc itself is not widened
interface RoomCodeDoc { gameId: GameId; createdAt: number }   // roomCodes/{code} (#34)
interface JoinIdemDoc { gameId: GameId; playerId: PlayerId; uid: Uid; createdAt: number; expiresAt: Timestamp }   // joinIdem/{keyHash}; server-only; expiresAt = createdAt + 7d (K-C)
interface DeletionJob { gameId: GameId; hostId: Uid; requestedAt: number; status: "running" | "done";
                        stagesDone: string[]; seatUids: Uid[]; heartbeatAt: number; attempts: number; expiresAt?: Timestamp }
interface RateLimitDoc { kind: string; windowStart: number; count: number; lockedUntil: number | null; expiresAt: Timestamp }
interface DeckDoc { name: string; red: string[]; green: string[]; createdAt: number; updatedAt: number }  // no gameId, no authorship (D2); Library caps at 2000 cards
```
`DeletionJob.attempts` counts invocations, not stages (`runDeletion` increments it once at the start), and `expiresAt` is written only when `status` becomes `done` (as built, #36).

`ViewDoc` and `RoundDoc` are LLD 2's, authoritative in `@dc/contracts`; `seats` fields belong to LLD 4 (required here: `uid`, `secretHash: string | null` (null after removal or while reissuing, LLD 4 `SeatDoc`), `epoch: number` (incremented on every reissue/rotation; seat custom tokens carry it as the developer claim `ep`, and `assertSeatLive` rejects `seat_revoked` when `token.ep !== epoch`, K-B), `notBefore` (seconds; a session is live only if `auth_time > notBefore`, strict, K-B), `firstSignInAt: number | null` (null at join; set by Identity the first time `principalOf` resolves the seat or on `rejoin`; a join replay returns credentials only while it is null, K-C), `revokedAt`), `pushSubs` and `notifLog` to LLD 6 (required here: `gameId` and `uid` on `pushSubs` for the cascade).

### 2.4 Id conventions

- `gameId`: Firestore auto-id (20 random chars): unguessable, appears in the invite link. Never derived from user input.
- Room code: 4 letters from the 20 consonants `BCDFGHJKLMNPQRSTVWXZ` (160,000 codes). No vowels so the code cannot spell a word; no `Y`/`I`/`O` ambiguity. Lookup normalizes to uppercase.
- Idempotency doc id: `base64url(sha256(actorKey + "\0" + idemKey))` (`idemKey` is this module's internal name for the wire field `idempotencyKey`), `actorKey = uid | "system"`. Client keys never become document ids directly (length, charset, and two actors reusing a key cannot collide).
- **Join keys are credentials (K-C).** A join `idempotencyKey` is hashed at the boundary (`keyHash = sha256(idempotencyKey)`, LLD 4/5) and never logged or stored; Identity passes `idemKey = keyHash` to `runCommand`, so the `games/*/idem` doc id for a join is `idemId(seatActor, keyHash)` and `joinIdem/{keyHash}` is keyed by the hash. The raw key never reaches the Store.
- View doc ids and `playerId`s follow LLD 1/2. Colons in `seat:{g}:{p}` are legal in document ids.
- `events/{version}` and `rounds/{n}` use unpadded decimals; consumers order by the numeric field (`version`, `round`), never by id.

### 2.5 Size budgets

The 1 MiB document limit applies to the aggregate (everything else is bounded by construction). Firestore counts field names, string bytes plus 1, and 32 bytes overhead; the Store estimates with `1.15 x UTF-8 length of JSON.stringify(doc)`.

| Part of `GameDoc` | Typical (6 players, 90 cards, 25 rounds) | Heavy realistic (10 players, T=10, 200 cards, 91 rounds, 500 votes) | Adversarial bound (50 joins, 1000 cards of 80 four-byte chars, 91 rounds, 1500 votes) |
|---|---|---|---|
| `cards` registry (about 20 B of key and field names + text) | 6 KB | 25 KB | 360 KB |
| zones (`pools`, `hand`, `scorePile`, ids once more) | 3 KB | 8 KB | 40 KB |
| `history` (about 520 B per round at 10 players) | 6 KB | 47 KB | 47 KB |
| `votes` (about 60 B each) | 0 | 30 KB | 90 KB |
| `players` (about 700 B seated, 250 B departed) | 5 KB | 8 KB | 22 KB |
| `settings`, `round`, scheduler fields | 2 KB | 3 KB | 4 KB |
| **Total (estimate)** | **about 22 KB** | **about 120 KB** | **about 560 KB** |

Conclusions and rules:
- Normal games are an order of magnitude below the limit; even the adversarial bound is under 1 MiB, but only **if** the Engine caps total joins at 50 (`MAX_TOTAL_JOINS`, counted by the monotonic `totalJoins`, so LOBBY leavers count) and votes at 1500 (`MAX_VOTES`); both are defined in LLD 1 and `packages/contracts` (C-CAPS; open question 8, resolved). The Store guard below is the backstop.
- **Guard (ST6).** Before writing, `estimateBytes(nextDoc)`: above 600 KiB log `store.size.warn`; above 900 KiB the command fails with `AGGREGATE_TOO_LARGE` (nothing commits) **unless** `estimateBytes(next) <= estimateBytes(prev)`, so shrinking commands (`deleteGame`, `removeCard`) always work; `endGame` is exempt outright (5.9, #33: it can grow by a few digit bytes).
- **What spills out of the aggregate:** draft text (`drafts`), resolved-round texts and pitches (`rounds`), event history (`events`), and every viewer's data (`views`). **What stays in:** the card registry, id-only `history` summaries, `votes`, and `players`, all needed by `decide` in one read (tech-stack: a command is one read plus one write for state).
- Other docs: view docs at most 64 KiB tested and 512 KiB hard cap (LLD 2 PJ14; `VIEW_DOC_BUDGET_BYTES` and `VIEW_DOC_MAX_BYTES` in `@dc/contracts`, the cap enforced inside `fanOut`); draft docs about 4 KiB; round docs at most about 10 KiB; event docs about 0.2 to 2 KiB; outbox rows about 1 to 3 KiB (roster of at most 10 seats); idem docs under 2 KiB; deck docs under 700 KiB at the Library's 2000-card cap.

### 2.6 Retention and TTL

S5: games persist until the host deletes them, so nothing that defines a game ever expires. What is TTL'd is operational scaffolding only: the six groups of section 2.1, with these windows.

| Data | Retention | Why |
|---|---|---|
| aggregate, `rounds`, `views`, `events`, `drafts` of unfinished writers, `seats` | until `deleteGame` | S5. Events are about 0.4 KB per command (one per version), about 0.3 MB for a 700-command game, so keeping them costs less than the code to prune them |
| `idem` | 7 days (`expiresAt = at + 7d`) | a retry arrives within minutes; 7 days (tech-stack, LLD 0) is generous. A hit is honored even if the doc is expired but not yet swept (TTL deletion lags up to a day) |
| `outbox` | 14 days | long enough to redrive after an outage; consumers have long since acted |
| `notifLog` | 30 days | must outlive the outbox row, or a late redelivery could double-notify (N1) |
| `rateLimits` | 2 x window | counters only |
| `deletions` | 7 days after `done` | audit trail of deletes |
| `joinIdem` | 7 days (`expiresAt = createdAt + 7d`) | outlives the room code so a same-key join retry recovers its seat after the code expired or was released (K-C); after the first sign-in a replay returns `NOT_FOUND` anyway |
| `roomCodes` | released at FINISHED/ENDED/delete (not TTL) | finished games cannot be joined (LLD 1 7.1), so their code is dead weight; the link by game id keeps working (Q10) |
| `pushSubs` | until pruned (404/410, LLD 6) or game deleted | |
| `hosts/*/decks` | until the host deletes them; **not** touched by `deleteGame` | D2: a saved deck holds no game or player ids, so there is nothing to cascade |

## 3. Security rules

### 3.1 `firestore.rules`

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() { return request.auth != null; }

    match /games/{gameId} {
      // The aggregate and every private subcollection (drafts, events, outbox, idem, seats, notifLog)
      // are server-only: no rule below re-opens them.
      allow read, write: if false;

      // Resolved rounds only (PJ13). Readable by any signed-in user who knows the game id; see 3.2.
      match /rounds/{n} {
        allow get, list: if signedIn();
        allow write: if false;
      }

      // One projected, already-redacted view per viewer (LLD 2). Single-document reads only.
      // Seat uids (`seat:{gameId}:{playerId}`) must also present the seat's current epoch as the `ep` claim (K-B),
      // so a session redeemed from a pre-reissue custom token cannot read. Host uids and spectators carry no `ep`.
      match /views/{uid} {
        allow get: if signedIn() && request.auth.uid == uid && uid != 'spectator'
                   && (!uid.matches('^seat:.*')
                       || request.auth.token.ep == get(/databases/$(database)/documents/games/$(gameId)/seats/$(uid.split(':')[2])).data.epoch);
        allow list, write: if false;
      }

      // The shared spectator view. `enabled` mirrors settings.spectators.enabled; a missing doc denies.
      match /views/spectator {
        allow get: if signedIn() && resource.data.enabled == true;
        allow list, write: if false;
      }
    }

    // A host reads only their own saved decks. The profile and the createGame ledger stay server-only.
    match /hosts/{hostUid} {
      allow read, write: if false;
      match /decks/{deckId} {
        allow get, list: if signedIn() && request.auth.uid == hostUid;
        allow write: if false;
      }
    }

    // roomCodes, joinIdem, pushSubs, rateLimits, deletions, hosts/*/idem, and anything unlisted.
    match /{document=**} { allow read, write: if false; }
  }
}
```

The only rules `get()` is the seat-epoch check on `views/{uid}` for seat uids (`seats` docs are keyed by `playerId`, the third segment of the uid): each seat `get` and each listener attach costs one extra billed document read (about one per player per session, negligible at this scale, tech-stack section 10); host, spectator, round and deck reads add none. Collection-group queries (`collectionGroup('rounds')`) are not matched by the `games/{gameId}/rounds/{n}` pattern (it would need `/{path=**}/rounds/{n}`), so they fall to the final deny: nobody can enumerate rounds across games.

### 3.2 Semantics and decisions

- **Spectator and `enabled`.** `views/spectator` carries `enabled` at the top level (LLD 2 4.1). When the host turns spectators off, the next command rewrites the doc with `enabled: false, view: null`, and the rule denies. A missing doc also denies (`resource` is null, the expression errors, the request is denied); clients treat `permission-denied` on the spectator doc as "not available".
- **Seat and host reads.** A seat reads exactly `views/{its own uid}`, and only while its token's `ep` equals `seats/{playerId}.epoch` (K-B; closes LLD 4 open question 20: after a reissue, a session redeemed from a pre-reissue custom token is denied; the 1 h residual for a listener already open on a valid ID token is unchanged, LLD 4 6.1). The host's own seat uses `hostUid`, which has no `seat:` prefix and no `ep`, so the check does not apply; revocation leaves `epoch` unchanged, so a removed player can still read their tombstone. The host's doc id is the host uid, so a host who left their seat still has a readable doc (the unseated-host view). A removed player's ID token stays valid for up to an hour (LLD 2 4.3), during which they can read only their own tombstone.
- **World-readable rounds (resolves LLD 2 open question 2): accepted for v1.** Rationale: the game id is already in every invite link and late joins are open to anyone holding it (Q2), so gating history on spectators being enabled adds no real protection, and a `get()`-based gate would add a billed rules read to every listener. The rule is one line to tighten later (`exists(.../views/$(request.auth.uid)) || get(.../views/spectator).data.enabled == true`). HLD F4 ("valid principal for that game") is relaxed accordingly, as LLD 2 already notes.
- **No list on views.** Clients use `getDoc`/`onSnapshot` on a single path, never a query over `views`.
- **App Check** is enforced at the project level for Firestore (LLD 0), which rules tests cannot exercise; the post-deploy smoke covers it.

### 3.3 Denial matrix (`rules-test/`, `@firebase/rules-unit-testing`)

Principals (all in game `g1`, host uid `hostUid`):

| Id | Principal | Auth |
|---|---|---|
| `anon0` | not signed in | none |
| `spec` | spectator | anonymous Auth, random uid |
| `seatA`, `seatB` | players A, B | uids `seat:g1:pA`, `seat:g1:pB`, token claim `ep` equal to the seeded `seats/{pid}.epoch` (`pA`: 1, others 0) |
| `seatAold` | player A on a pre-reissue session | uid `seat:g1:pA`, token claim `ep: 0` (seat epoch is 1) |
| `host` | host of `g1`, seated | uid `hostUid` |
| `host2` | a different host | uid `hostUid2` |
| `gone` | removed player with a tombstone | uid `seat:g1:pR` (Auth user deleted but ID token still valid), `ep` equal to the seeded `seats/pR.epoch` (revocation leaves it unchanged) |

The Admin SDK bypasses rules and is not a rules-test principal. Table cells list the **only** operations that must succeed; every other (principal, operation) pair, for operations `get`, `list`, `create`, `update`, `delete`, must fail with `permission-denied`.

| # | Resource (seeded by `withSecurityRulesDisabled`) | Allowed (everything else denied) |
|---|---|---|
| 1 | `games/g1` | none |
| 2 | `games/g1/drafts/pA` (incl. by `seatA`) | none |
| 3 | `games/g1/rounds/1`, and `list` of `games/g1/rounds` | `get`, `list` for every signed-in principal; never `anon0`; no writes by anyone |
| 4 | `games/g1/views/seat:g1:pA` | `get` by `seatA` only (`seatAold`, `seatB`, `host`, `spec`, `gone` denied) |
| 5 | `games/g1/views/seat:g1:pB` | `get` by `seatB` only |
| 6 | `games/g1/views/seat:g1:pR` (tombstone) | `get` by `gone` only |
| 7 | `games/g1/views/hostUid` | `get` by `host` only (`host2` denied) |
| 8 | `games/g1/views/spectator`, `enabled: true` | `get` by every signed-in principal; not `anon0` |
| 9 | `games/g1/views/spectator`, `enabled: false` | none |
| 10 | `games/g1/views/spectator`, document missing | none |
| 11 | `games/g1/views` (collection `list`, any query) | none |
| 12 | `games/g1/events/1`, `outbox/v1_0`, `idem/x`, `seats/pA`, `notifLog/k` | none |
| 13 | `roomCodes/ABCD`, `joinIdem/h`, `pushSubs/seat:g1:pA_g1`, `rateLimits/join_x`, `deletions/g1` | none (including `seatA` on its own `pushSubs` and on the `joinIdem` row of its own join) |
| 14 | `hosts/hostUid` | none (including `host`) |
| 15 | `hosts/hostUid/decks/d1` and `list` of `hosts/hostUid/decks` | `get`, `list` by `host` only; no writes; `host2` denied |
| 16 | `hosts/hostUid/idem/x` | none |
| 17 | `collectionGroup` queries: `rounds`, `views`, `outbox`, `idem`, `decks`, `events`, `seats` | none, even for signed-in principals |
| 18 | `games` collection query (`where hostId == hostUid`) | none |
| 19 | any unlisted path (`foo/bar`, `games/g1/unknown/x`) | none |
| 20 | a user whose uid is the literal `spectator` reading `views/spectator` while `enabled: false` | none (documents the `uid != 'spectator'` guard) |
| 21 | `games/g1/views/seat:g1:pA` read with uid `seat:g1:pA` and no `ep` claim, or `ep` of a different type (`"1"`) | `get` by `seatA` only: both tokens denied (the epoch check, K-B; `seatAold` is covered by row 4) |

As built (#32): the table is data in `rules-test/matrix.ts`, and `rules-test/store.rules.test.ts` generates one test per (row, target, principal, operation) from it. Rows 20 and 21 add three tokens (`specLiteral`, uid `spectator`; `seatAnoEp`, no `ep`; `seatAstrEp`, `ep: "1"`), and all eleven principals run on every row, so each row also proves them denied. Operation semantics: on a document target, `get` is `getDoc`, `list` is a query over its parent collection, `create` is `setDoc` of a new id in the same collection (of the path itself when the row seeds it missing, row 10), `update` is `updateDoc`, `delete` is `deleteDoc`; a query target (rows 11, 17, 18) runs `list` only. An allowed `get` must also see the seeded document. A denied cell must fail with exactly `permission-denied`; no cell surfaced `not-found` or an evaluation error. That is 1595 cases (27 document targets times 5 operations plus 10 query targets, times 11 principals), about 15 s on the emulator. A final case-count guard (R2) fails if the executed count differs from the count the matrix implies, or if a row of 1 to 21 or a principal of the table above is missing.

LLD 0 P10's CI step ("collections named in `firestore.rules` must have a denial test") is `scripts/rules-coverage.test.ts`, in `bun run test` and so in the verify job (ST7). It normalizes paths to collections (`games/{}/views`) and fails, naming the path, if a collection a `match` in `firestore.rules` names is not exercised by a matrix row (C1), if the section 2.1 collection map differs from the set the matrix exercises (C2, row 19's unlisted paths aside; `games/{}/idem` and `hosts/{}/idem` stay distinct), or if tech-stack section 5 differs from section 2.1 (C3). It also checks that section 3.1 is `firestore.rules` verbatim and that this table and the principals table match the matrix.

## 4. Indexes and field exemptions

`firestore.indexes.json` (deployed before functions, LLD 0 P16):

```json
{
  "indexes": [
    { "collectionGroup": "games", "queryScope": "COLLECTION",
      "fields": [ { "fieldPath": "hostId", "order": "ASCENDING" }, { "fieldPath": "createdAt", "order": "DESCENDING" } ] },
    { "collectionGroup": "outbox", "queryScope": "COLLECTION_GROUP",
      "fields": [ { "fieldPath": "processedAt", "order": "ASCENDING" }, { "fieldPath": "at", "order": "ASCENDING" } ] },
    { "collectionGroup": "outbox", "queryScope": "COLLECTION_GROUP",
      "fields": [ { "fieldPath": "topic", "order": "ASCENDING" }, { "fieldPath": "notifDoneAt", "order": "ASCENDING" }, { "fieldPath": "at", "order": "ASCENDING" } ] },
    { "collectionGroup": "deletions", "queryScope": "COLLECTION",
      "fields": [ { "fieldPath": "status", "order": "ASCENDING" }, { "fieldPath": "heartbeatAt", "order": "ASCENDING" } ] }
  ],
  "fieldOverrides": [
    { "collectionGroup": "games", "fieldPath": "cards",    "indexes": [] },
    { "collectionGroup": "games", "fieldPath": "history",  "indexes": [] },
    { "collectionGroup": "games", "fieldPath": "votes",    "indexes": [] },
    { "collectionGroup": "games", "fieldPath": "players",  "indexes": [] },
    { "collectionGroup": "games", "fieldPath": "pools",    "indexes": [] },
    { "collectionGroup": "games", "fieldPath": "round",    "indexes": [] },
    { "collectionGroup": "games", "fieldPath": "settings", "indexes": [] },
    { "collectionGroup": "games", "fieldPath": "waitingOn","indexes": [] },
    { "collectionGroup": "views", "fieldPath": "view",     "indexes": [] },
    { "collectionGroup": "views", "fieldPath": "draft",    "indexes": [] },
    { "collectionGroup": "rounds", "fieldPath": "plays",   "indexes": [] },
    { "collectionGroup": "events", "fieldPath": "events",  "indexes": [] },
    { "collectionGroup": "outbox", "fieldPath": "event",   "indexes": [] },
    { "collectionGroup": "outbox", "fieldPath": "roster",  "indexes": [] },
    { "collectionGroup": "drafts", "fieldPath": "red",     "indexes": [] },
    { "collectionGroup": "drafts", "fieldPath": "green",   "indexes": [] },
    { "collectionGroup": "idem",   "fieldPath": "meta",    "indexes": [] },
    { "collectionGroup": "idem",   "fieldPath": "gameId",  "indexes": [ { "order": "ASCENDING", "queryScope": "COLLECTION_GROUP" } ] },
    { "collectionGroup": "idem",   "fieldPath": "expiresAt", "ttl": true, "indexes": [ { "order": "ASCENDING", "queryScope": "COLLECTION" } ] },
    { "collectionGroup": "outbox", "fieldPath": "expiresAt", "ttl": true, "indexes": [ { "order": "ASCENDING", "queryScope": "COLLECTION" } ] },
    { "collectionGroup": "notifLog",   "fieldPath": "expiresAt", "ttl": true, "indexes": [ { "order": "ASCENDING", "queryScope": "COLLECTION" } ] },
    { "collectionGroup": "rateLimits", "fieldPath": "expiresAt", "ttl": true, "indexes": [ { "order": "ASCENDING", "queryScope": "COLLECTION" } ] },
    { "collectionGroup": "deletions",  "fieldPath": "expiresAt", "ttl": true, "indexes": [ { "order": "ASCENDING", "queryScope": "COLLECTION" } ] },
    { "collectionGroup": "joinIdem",   "fieldPath": "expiresAt", "ttl": true, "indexes": [ { "order": "ASCENDING", "queryScope": "COLLECTION" } ] }
  ]
}
```

- A map or array exemption covers all subfields. `games.reminderDueAt`, `hostId`, `createdAt`, `phase`, `paused`, `store.viewsRev`, `pushSubs.gameId` and `joinIdem.gameId` keep automatic single-field indexes.
- The pinned `firebase-tools` 15.37.0 accepts `"ttl": true` in `fieldOverrides` and applies it; the six TTL policies deploy from this file (proven in #15, open question 6). The four composites and 17 exemptions are in the file since #32; #36 adds one enabled collection-group single-field index (`idem.gameId`, for the host-ledger cascade query). `scripts/firestore-indexes.test.ts` asserts set equality with this block, and that this block is the file; they reach staging with the first `deploy-staging` after the change, where `wait-indexes.ts` waits for them to be `READY`.
- The first outbox composite serves LLD 6's redrive query (`topic`-agnostic rows with `processedAt == null` older than a cutoff). The second serves the identity-row push-cleanup redrive (`topic == "identity"`, `notifDoneAt == null`, `at` older than a cutoff; section 8), which is independent of `processedAt` so a row LLD 4 already completed is still retried for push cleanup. The `deletions` composite serves the stuck-job sweep (section 6.4).
- **Index check.** The emulator does not enforce composite indexes, so correctness is checked two ways (#32): (1) `functions/src/store/queries.ts` declares every production query as data (`{id, collectionGroup, scope, parent, where, orderBy, source}`: `gamesByHost`, `waitingOn`, `outboxRedrive`, `identityCleanup`, `stuckDeletions`, `hostIdemByGame`, `pushSubsByGame`, `joinIdemByGame`, `seatBySecret`, `outboxSiblings`, `roundsByNumber`), and `queries.test.ts` asserts that each is served by the automatic single-field index (one field, the document id aside, at COLLECTION scope), by an enabled collection-group single-field index (the `idem.gameId` field override), or by a composite of the same group and scope with the equality fields first and then the inequality and orderBy fields in order and direction (Q1), that no `indexes: []` override covers a queried field or its parent map (Q2), and that every composite serves some declared query (Q3); (2) the post-deploy smoke (`scripts/smoke.ts`) runs each declared query with `limit 1` through the Firestore REST `runQuery`, where `FAILED_PRECONDITION` (missing or building index) is a hard failure naming the query and `PERMISSION_DENIED` a distinct one naming the likely missing role (LLD 0 failure-mode table). Consumers import their query shapes from `queries.ts` rather than redeclare them; that they do is each consumer step's to prove.

## 5. The `command` transaction

### 5.1 Store interface

```ts
export interface CommandInput {
  gameId: GameId;
  cmd: Command;                                   // LLD 1 section 7; expectedVersion passed through untouched
  actor: Actor;                                   // {kind:"user", uid} | {kind:"system"} (markReminded only)
  idemKey: string;                                // client UUID; for join the keyHash, never the raw key (2.4, K-C); "remind:{episode}:{dueAt}" for the system actor
  meta?: Json;                                    // <= 1 KiB, stored in the ledger, echoed on replay (Identity's join uses it)
  extraWrites?: (r: { prev: Game; next: Game }) => DocWrite[];   // PURE; run on a non-replay accept only (Identity's seats doc)
}
export type CommandOutcome =
  | { kind: "accepted"; version: number; view: GameView | null; draftSeq?: number; replay: boolean; meta?: Json }
  | { kind: "rejected"; rejection: Rejection; version: number }      // a typed domain result, HLD 4.3
  | { kind: "deleting" };                                            // deleteGame accepted; cascade runs asynchronously
// Failures (infrastructure or bugs) are thrown as StoreError, never returned (5.8).
export interface Deps { clock(): number; newSeed(): string /* CSPRNG, 128 bit; shuffles only */; mintId(): string /* CSPRNG, non-replayable; card ids (ctx.mintId, C-EV) */; faults?: FaultHooks /* emulator only, 10.3 */ }
```

### 5.2 Pseudocode

```ts
export async function runCommand(db: Firestore, d: Deps, i: CommandInput): Promise<CommandOutcome> {
  const gameRef = db.doc(`games/${i.gameId}`);
  const idemRef = gameRef.collection("idem").doc(idemId(i.actor, i.idemKey));
  let attempts = 0;
  try {
    return await db.runTransaction(async (tx): Promise<CommandOutcome> => {
      attempts++;                                            // with the diagnostic loadedVersion (5.9), the only closure mutations allowed (ST2)

      // ---------- 1. READS: every read happens before the first write ----------
      const [gSnap, iSnap] = await tx.getAll(gameRef, idemRef);
      if (!gSnap.exists || (gSnap.data() as GameDoc).store.deleting)
        return { kind: "rejected", rejection: { code: "NOT_FOUND" }, version: 0 };   // no decide, no writes
      const { store, ...prev } = gSnap.data() as GameDoc;

      // Idempotency hit: BEFORE decide and before any staleness test (5.4).
      if (iSnap.exists) return replay(prev, i, iSnap.data() as IdemDoc);

      const me = i.actor.kind === "user" ? actorRole(prev, i.actor).playerId : null;
      const extraRefs: DocumentReference[] = [];
      if (me && (i.cmd.type === "saveDraft" || i.cmd.type === "finishWriting")) extraRefs.push(draftRef(i.gameId, me));
      if (i.cmd.type === "removeCard") for (const n of roundsContaining(prev, i.cmd.cardId)) extraRefs.push(roundRef(i.gameId, n));
      if (i.cmd.type === "deleteGame") extraRefs.push(roomCodeRef(prev.roomCode));   // the code may already belong to a newer game (6.4)
      const extra = extraRefs.length ? await tx.getAll(...extraRefs) : [];
      const myDraft = me ? extra.find(s => s.ref.path.endsWith(`/drafts/${me}`)) : undefined;
      const codeSnap = extra.find(s => s.ref.path === `roomCodes/${prev.roomCode}`);
      const drafts: GameDrafts = myDraft?.exists ? { [me!]: toDraft(myDraft.data()!) } : {};

      // ---------- 2. DECIDE: pure, no I/O ----------
      const now = d.clock(), seed = d.newSeed();
      const res = decide(prev, i.cmd, { now, rng: makeRng(seed), mintId: d.mintId, actor: i.actor, drafts });
      if (!res.ok) return { kind: "rejected", rejection: res.error, version: prev.version };   // nothing is written, not even a ledger row
      const a = res.value;                                    // Accepted (LLD 1 5.1)

      // ---------- 3. WRITES (buffered by the transaction, committed atomically) ----------
      const w = new WriteSet(tx, { max: MAX_WRITES });        // merges same-document writes (5.2a), counts DISTINCT documents (5.7)

      if (a.deleteGame) {                                     // phase 0 of S5 (6.4): state is NOT committed
        w.update(gameRef, { "store.deleting": { at: now, by: actorUid(i.actor) } });
        if (codeSnap?.exists && codeSnap.get("gameId") === i.gameId)   // only if this game still holds the code (ST8)
          w.delete(roomCodeRef(prev.roomCode));
        w.create(deletionRef(i.gameId), newJob(prev, now));
        return { kind: "deleting" };                        // no ledger row: a replay hits the `deleting` check above and gets NOT_FOUND (6.4)
      }

      // Views: LLD 2 fan-out. fanOut itself strict-parses and size-caps every doc (PJ2, PJ14, `assertViewDoc`) and throws EngineInvariantError, which aborts the whole transaction;
      // the parse below is a redundant second check at the Store boundary (kept: it narrows the type and costs microseconds).
      const writeViews = (from: Game | null, to: Game) => {
        for (const vw of fanOut(from, to, { now, storedRev: store.viewsRev })) {   // a skip needs store.viewsRev === PROJECTOR_REV (LLD 2 8.2)
          const vd = ViewDocSchema.parse(vw.doc);             // envelope carries viewsRev = PROJECTOR_REV (LLD 2, K-F)
          w.merge(viewRef(i.gameId, vw.docId), viewFields(vd), VIEW_FIELDS);
          if (vw.clearDraft) w.merge(viewRef(i.gameId, vw.docId), { draft: null, draftSeq: FieldValue.increment(1) }, DRAFT_FIELDS);   // may collide with draftChanges below: WriteSet rules, 5.2a
        }
      };
      const viewsStale = store.viewsRev !== PROJECTOR_REV;    // stored views were produced by an older projector

      if (a.aggregateChanged) {
        const next = a.state;
        assert(next.version === prev.version + 1, "version contiguity (ST4)");
        const doc: GameDoc = { ...next, store: { schema: 1, viewsRev: PROJECTOR_REV, updatedAt: now, deleting: null } };
        guardSize(doc, prev);                                 // ST6
        w.set(gameRef, doc);                                  // full replace: removed keys vanish
        w.create(eventRef(i.gameId, next.version), eventDoc(next.version, now, a, i, seed, me));   // exactly one per version, `events: []` allowed (9); omits seed/actor for finishWriting, importDeck, writeIn (C-EV); writeIn is recorded as commandType "confirmSubmission" (K-A)
        for (const rec of a.roundRecords)                     // S3: create() fails if the round doc exists
          w.create(roundRef(i.gameId, rec.round), RoundDocSchema.parse(toRoundDoc(rec)));
        if (i.cmd.type === "removeCard") for (const s of extra) if (isRoundSnap(s) && s.exists) w.set(s.ref, redact(s.data() as RoundDoc, i.cmd.cardId));
        for (const row of buildOutbox(prev, next, i.cmd, a, now)) w.create(outboxRef(i.gameId, row.id), row.doc);
        if (leftJoinable(prev, next)) w.delete(roomCodeRef(next.roomCode));   // FINISHED or ENDED releases the code (ST8)

        writeViews(prev, next);                               // first command after a projector deploy rewrites everything
      } else if (viewsStale && i.actor.kind === "user") {
        // K-F: rebuild is independent of aggregateChanged, so a draft-only command after a deploy also refreshes views.
        // No version bump (PJ10): rebuilt docs keep view.version = prev.version, so clients prefer them by the higher viewsRev.
        // In the ahead branch (a rollback that did not ship a higher PROJECTOR_REV) the rewrite carries a lower viewsRev instead and
        // clients discard it at the same version; see 5.6.
        w.update(gameRef, { "store.viewsRev": PROJECTOR_REV, "store.updatedAt": now });
        writeViews(null, prev);                               // all of viewersOf(prev), as rebuildViews (6.5)
      }

      // Drafts (also the whole story for a text-only saveDraft, where aggregateChanged is false).
      // An absolute seq is written only where step 1 read the actor's draft doc (saveDraft, finishWriting);
      // every other clear (leave, removePlayer, any eviction) uses increment(1) so it can never lower draftSeq (5.6).
      const readMine = !!myDraft;                             // true iff the drafts doc was in the step-1 getAll
      const seq = (myDraft?.exists ? (myDraft.get("seq") as number) : 0) + 1;
      for (const c of a.draftChanges) {
        const absolute = readMine && c.playerId === me;
        const docId = viewDocIdOf(a.state, c.playerId);       // player.uid in the post state (departed players are retained there)
        if (c.draft) {
          assert(absolute, "text drafts only come from the actor's saveDraft");
          w.set(draftRef(i.gameId, c.playerId), { ...c.draft, seq, updatedAt: now });
          w.merge(viewRef(i.gameId, docId), draftRegion(c.draft, seq), DRAFT_FIELDS);
        } else {
          w.delete(draftRef(i.gameId, c.playerId));
          w.merge(viewRef(i.gameId, docId), absolute ? draftRegion(null, seq) : { draft: null, draftSeq: FieldValue.increment(1) }, DRAFT_FIELDS);
        }
      }

      for (const x of i.extraWrites?.({ prev, next: a.state }) ?? []) w.apply(x);
      if (!a.aggregateChanged && a.draftChanges.length === 0)  // no-op markReminded: zero writes
        return { kind: "accepted", version: prev.version, view: viewFor(prev, i.actor), replay: false };

      const mySeq = readMine && a.draftChanges.some(c => c.playerId === me) ? seq : undefined;   // only an absolute seq is meaningful to the caller
      w.create(idemRef, idemDoc(i, now, a.state.version, mySeq));
      d.faults?.fire("afterWritesBuffered");
      return { kind: "accepted", version: a.state.version, view: viewFor(a.state, i.actor),
               ...(mySeq !== undefined && !a.aggregateChanged ? { draftSeq: mySeq } : {}), replay: false };
    }, { maxAttempts: 8 });
  } catch (e) {
    throw mapStoreError(e, attempts);                         // 5.8
  } finally {
    log.command(i, attempts);                                 // command.done / command.rejected / txn.retry (LLD 0 section 9), after the transaction
  }
}
```

`viewFor(game, actor)` is `makeProjector(game)(viewerFor(game, uid))` (LLD 2 8.5), computed in memory with no extra read, `null` for the system actor. `VIEW_FIELDS = ["schema","viewsRev","gameId","enabled","version","generatedAt","view"]` and `DRAFT_FIELDS = ["draftSeq","draft"]` are the `mergeFields` lists of LLD 2 8.4 (the Engine exports them as `VIEW_REGION_FIELDS` and `DRAFT_REGION_FIELDS`, with a test that they partition the `ViewDoc` keys; the Store imports them) (`viewsRev` is the envelope field of K-F: clients order view snapshots by `(version, viewsRev)` lexicographically, so a rebuilt doc at the same `version` replaces the older one); `w.merge` unions the field lists when the same view doc is written twice (fan-out plus draft region), so each document is one write. The exact rules are in 5.2a.

### 5.2a `WriteSet` merge semantics

`WriteSet` keys every buffered write by document path and emits **one** write per path (the 5.7 count is distinct documents).

- `create`/`set`/`update`/`delete` on a path that already has a write throws `INVARIANT`, with one exception: `w.merge` calls on the same path combine.
- `w.merge` combines by field: the `mergeFields` lists are unioned. A field written twice with the same value is one field. The view region (`VIEW_FIELDS`) and the draft region (`DRAFT_FIELDS`) are disjoint, so the only field collisions possible are `draft` and `draftSeq`.
- **Draft-region precedence.** For a view doc that receives both a fan-out `clearDraft` (`{draft: null, draftSeq: increment(1)}`, a departed or tombstoned viewer) and a `draftChanges` write (`draftRegion(...)` with an absolute `seq`, written only when step 1 read that player's drafts doc, i.e. the actor's `saveDraft`/`finishWriting`; or `{draft: null, draftSeq: increment(1)}` for every other clear, including a self-evicting `leave` and `removePlayer`), the result is one merged write: an absolute `draftSeq` wins over an `increment` (safe, because an absolute value is always the read `seq + 1`, never below the stored one); two `increment` transforms on one field collapse to a single `increment(1)`, not `increment(2)`; `draft` takes the `draftChanges` value (a `clearDraft` only ever writes `null`, and a text draft never coexists with a departure in one command). So `draftSeq` advances by exactly one per command per view doc, which is all LLD 2 8.4 needs (strictly increasing).
- Any other same-field conflict with different values throws `INVARIANT` (nothing commits).
- The implementation computes the merged draft region per doc id once, before issuing `w.merge`, so the result does not depend on call order (test: `WriteSet` unit tests in both orders).

### 5.3 Ordering rules

1. **Reads before writes.** The Admin SDK throws if a read follows a write in a transaction. All reads are the two `getAll` calls above: aggregate and ledger first; then the actor's draft (only `saveDraft`, `finishWriting`), the round docs that contain a removed card (only `removeCard`, found from `prev.history`, 6.3), or `roomCodes/{prev.roomCode}` (only `deleteGame`, 6.4). No command reads view docs, other players' drafts (`leave` and `removePlayer` do not read the evicted player's draft; they clear `draftSeq` by `increment(1)`, 5.6) or `hosts`.
2. **Everything between reads and writes is pure:** `decide`, `fanOut`, `makeProjector`, schema parses, size estimates, `buildOutbox`, `extraWrites`.
3. **Writes are buffered** by the SDK and sent in one commit; ordering among them is irrelevant to correctness.

### 5.4 Idempotency and staleness placement

- **Ledger first.** The idem doc is checked immediately after the aggregate read and before `decide`. A retry of a command that already succeeded must return success even if its `expectedVersion` has since become stale, so the ledger check precedes the `STALE` guard (E4 beats guard 3 of LLD 1 5.3).
- **Replay result.** `replay()` returns `{kind:"accepted", replay:true, version: idem.version, view: viewFor(prev, actor), draftSeq: idem.draftSeq, meta: idem.meta}`: the original committed `version` as the freshness signal, but the caller's **current** view (the original view is not stored: it can be 64 KiB and is stale by definition). LLD 5 must document that `result.version` can be lower than `result.view.version` on a replay (open question 12).
- **Accepted only.** Rejections are not recorded (LLD 1 section 10's recommendation, adopted): a rejection reflects the state at that moment and a retry may legitimately succeed later. A rejected command writes nothing.
- **`STALE` lives in the Engine** (LLD 1 5.3 step 3, compares `expectedVersion` with `round.changedAtVersion`). The Store never interprets `expectedVersion` and never compares it to `state.version`.
- **Same-key concurrency.** Two concurrent requests with one key serialize on the aggregate lock; the second reads the first's committed ledger row and replays. No special code.

### 5.5 Retries and purity

- Admin-SDK transactions are **pessimistic**: `getAll` takes a lock on the aggregate, so concurrent commands on one game queue behind it instead of failing a compare-and-set. HLD S1's wording ("compare-and-set on `version`... loser is retried by `execute`") is realized as lock plus SDK retry on `ABORTED` (deadlock or lock timeout), with `maxAttempts: 8` and the SDK's exponential backoff; the callback is rerun from the top on fresh reads. The explicit `next.version === prev.version + 1` assertion and `create()` on `events/{version}` (fails if the id exists) make a lost update impossible even if the locking model changes (ST4).
- **The callback must be re-executable (ST2).** It may call only: Firestore reads and buffered writes through `tx`, `d.clock()`, `d.newSeed()` and `d.mintId()` (fresh per attempt; the committing attempt's values are the ones in the committed state, and for commands other than `finishWriting`, `importDeck` and `writeIn` the committing attempt's seed is the one stored in the event, LLD 1 section 10; those three store no seed, no actor), and pure functions. It must not call Auth, FCM, Identity, `fetch`, `Math.random`, or log counters; it mutates only `attempts`. `extraWrites` must be pure for the same reason (Identity mints `playerId`, secret and hash **before** calling `runCommand` so a rerun produces the same writes).
- The `command.done` log line carries `attempts`; `attempts > 1` feeds `dc_txn_retry_total` (LLD 0).

### 5.6 Drafts and the version bump

| `saveDraft` case | `aggregateChanged` | Writes |
|---|---|---|
| Edits to existing text, count of cards unchanged | false | `drafts/{pid}` (seq+1), `views/{uid}` draft region only, ledger row. **No** aggregate write, no events, no fan-out, no other player's view touched |
| A card added or removed (counts change `writeProgress`) | true | aggregate, `events/{version}` (with `events: []`, 9), `views` fan-out (all viewers; `cardsLeft` is public), draft region of the actor's doc in the same merge, drafts doc, ledger row |

- The draft region and view region of `views/{uid}` are disjoint field sets written with `mergeFields`, so another player's `finishWriting` can never wipe your draft and your draft save never touches `version`/`view` (LLD 2 8.4).
- `finishWriting` and eviction return `draftChanges: [{playerId, draft: null}]`; the Store deletes the drafts doc and clears the draft region (`draft: null`). For the actor of `finishWriting`, `draftSeq` is the absolute `seq+1` (its drafts doc is read in step 1); every other clear, including the actor's own `leave` (self-eviction) and a writer evicted by `removePlayer`, writes `FieldValue.increment(1)`, because step 1 did not read that drafts doc and an absolute value computed from nothing would lower `draftSeq`. No extra read is needed. When fan-out also clears the same view doc, the two combine into one write (5.2a).
- **Stale views on a draft-only command (K-F).** If `store.viewsRev !== PROJECTOR_REV` (behind after a deploy, or ahead after a rollback: fail safe, rebuild everything) when a user command commits with `aggregateChanged: false`, the Store still rebuilds every view (`fanOut(null, prev, {now, storedRev: store.viewsRev})` (which cannot skip, K-F)) and updates `store.viewsRev` (and `store.updatedAt`) without bumping `version`; the rebuilt docs carry the same `version` and the running envelope `viewsRev`. **Behind is the deploy case and the rebuilt docs win**, because a client applies a snapshot only if its `(version, viewsRev)` pair is greater or equal (LLD 2 8.4). **Ahead only arises from a rollback that did not follow the rule** of LLD 2 8.2 (a rollback of projector code ships with a higher `PROJECTOR_REV`, which puts it in the behind case); if it does arise, the rebuild writes the *lower* constant and clients discard those docs at the same `version`, keeping the newer-projector ones, until a rollback that follows the rule. Only a no-op system `markReminded` skips this (it stays zero-write; the next user command or `rebuildViews` refreshes the views). `rebuildViews` (6.5) is the second caller of the same rebuild branch: the first is any user command above, and both set `store.viewsRev` and `store.updatedAt` at the unchanged version.
- The ledger is written for draft-only saves too: without it a delayed retry of an older save could overwrite newer text after the client moved on. Reordering of two *different* saves in flight is the client's concern (LLD 7 serializes saves).

### 5.7 Write-count budget

Documented Firestore limit is 500 writes per transaction (the Store treats it as binding); the Store enforces `MAX_WRITES = 200` in `WriteSet` (distinct documents) and throws `TOO_MANY_WRITES` before commit. Worst case with a 50-join cap. Two shapes dominate, and they never coincide:

| Item | Any command except `removeCard` | `removeCard` |
|---|---|---|
| aggregate, events, ledger, room-code delete | 4 | 3 (no room-code delete) |
| round docs | at most 1 (`pickWinner`) | one redaction per resolved round that contains the card: at most one per round played, 91 in the heavy realistic case (a card is reused only when the deck recycles) |
| outbox rows (`WinnerPicked`, `RoundOpened`, `GameFinished`, identity rows, `WritingStarted`, `JudgeChanged`) | at most 6 | 0 |
| draft docs deleted (one per seated writer) | at most 10 | 0 |
| view docs: 10 seated + spectator + unseated host + 40 departed, only when `viewsRev` mismatches (otherwise tombstones are skipped as unchanged); draft-region writes merge into these (5.2a) | at most 52 | at most 52 (card text changes in views) |
| `join`: Identity's `extraWrites` (seat doc, `joinIdem` row) | +2 | n/a |
| **Total** | **at most about 75** | **at most about 146** |

Measured (#33): `budget.test.ts` pins a stale-`viewsRev` `updateSettings` on the 52-view game at exactly 55 writes (against an independent document diff); planner P5 bounds a stale `leave` on that game at <= 75 (52 view writes), and pins a `removeCard` of a card in 91 rounds with every view stale at exactly 3 + 91 + 52 = 146. Both are far under `MAX_WRITES = 200` and the 500 limit; a `removeCard` could only exceed 200 with more than 145 resolved rounds at 52 view docs (3 + 146 + 52 = 201 is the planner's `TOO_MANY_WRITES` case; earlier text said about 140), beyond the heavy realistic bound; it would then fail closed with `TOO_MANY_WRITES` (the host's escape hatch is `endGame`). A `removeCard` of a card that appears in no round touches no round doc.

Typical writes per command at 6 players are in section 12.

### 5.8 Errors and what the caller gets

| Situation | Result | Wire (LLD 5 maps) |
|---|---|---|
| `decide` returns a `Rejection` (incl. `STALE`, `NOT_AUTHORIZED`, `NOT_FOUND` for missing or deleting game) | `{kind:"rejected"}`, nothing written | `{ok:false, reason, version}` (HTTP success; HLD 4.2) |
| Ledger hit | `{kind:"accepted", replay:true}` | `{ok:true, version, view}` |
| Accepted | `{kind:"accepted", version, view}`; `view` is the caller's own `GameView`, never read back from Firestore | `{ok:true, version, view, draftSeq?}` |
| `ABORTED` after 8 attempts | `StoreError("CONTENTION")`, nothing committed | `HttpsError("aborted")`; client retries the same key (safe, ST3) |
| `UNAVAILABLE` / `DEADLINE_EXCEEDED`, and (#33, ruled in review) the other SDK-transient codes `CANCELLED`, `UNKNOWN`, `RESOURCE_EXHAUSTED`, `INTERNAL` | `StoreError("UNAVAILABLE")`; the commit **may** have happened (`UNAUTHENTICATED` and unnamed errors stay `INVARIANT`) | `unavailable`; the same-key retry returns replay or applies once |
| `EngineInvariantError`, `ALREADY_EXISTS` on `events`/`rounds` create, view schema parse failure (PJ2), version assertion | `StoreError("INVARIANT")`, nothing committed, logged with `gameId` and `version` (no payload) | `internal`; alert on any occurrence |
| `AGGREGATE_TOO_LARGE`, `TOO_MANY_WRITES` | `StoreError`, nothing committed | `resource-exhausted` |
| `ROOM_CODES_EXHAUSTED` (8 consecutive lost room-code races in `createGame`) | `StoreError("ROOM_CODES_EXHAUSTED")`, nothing committed | `resource-exhausted`; deliberately not `CONTENTION` (#34) |

Rejection versus failure: a rejection is a normal, typed answer about the caller's request against current state; a failure means the system could not decide or persist. Failures never carry a `reason` code from the HLD taxonomy, and rejections are never thrown.

### 5.9 As built (#33)

- **Planner and shell.** The pseudocode of 5.2 is split in two. `planCommand(reads, extra, input, {now, seed, mintId})` (`functions/src/store/plan.ts`) is steps 2 and 3 as a pure function: from the step-1 reads (the aggregate doc, the ledger doc, and the docs `extraReadPaths` asked for) it returns the outcome and a list of `DocWrite`s. `runCommand` (`run.ts`) is the shell: `runTransaction` with `maxAttempts: 8`, the two `getAll`s, the planner, then `applyWrites` buffers the `DocWrite`s on `tx`. `execute` is the same run with diagnostics (`attempts`, distinct documents written) for the harness. The write budget and the size guard are tested on the planner over large in-memory games (`plan.test.ts`), so the integration side needs no fixture of that size.
- **Module map.** `idem.ts` (`idemId`), `writeset.ts` (`WriteSet`, `DocWrite`, `increment`, `MAX_WRITES`, `applyWrites`), `outbox.ts` (`buildOutbox`, `NOTIFY_EVENTS`, `IDENTITY_EVENTS`), `events.ts` (`eventDoc`), `redact.ts` (`roundsContaining`, `redact`), `size.ts` (`estimateBytes`, `guardSize`), `errors.ts` (`StoreError`, `mapStoreError`), `plan.ts`, `run.ts`, `load.ts`, `refs.ts` (paths), `types.ts`; `index.ts` exports them for #34 to #36. As built (#34), the fresh `store` map (`withStore`) and the view fan-out (`planViews`) are exported from `plan.ts`, so `createGame` writes its two views and #35's `rebuildViews` can reuse the same step rather than the planner's K-F branch shape. `queries.ts` (#32) is unchanged.
- **`DocWrite`.** `{op: "create" | "set" | "update", path, data} | {op: "delete", path} | {op: "merge", path, data, fields}`; `increment(n)` is a plain marker turned into `FieldValue.increment(n)` by `applyWrites`, so the 5.2a rules compare values without Firestore. `extraWrites` returns `DocWrite[]`.
- **Deviations from the 5.2 pseudocode, ruled in #33.** (1) The zero-write return is taken only when nothing at all was planned: a K-F rebuild on a command with no aggregate change and no draft change still commits with its ledger row (the pseudocode's return would have dropped the ledger while the buffered rebuild committed). (2) The ledger's `draftSeq` is stored only when the response carried one (a draft-only save), so a replay returns what the original returned. (3) `actorPlayerId` in an event doc is the actor's seat in the pre-state, else in the post-state (a `join`'s new seat). (4) A failure that is none of 5.8's named kinds maps to `INVARIANT`, except the SDK-transient gRPC codes CANCELLED, UNKNOWN, RESOURCE_EXHAUSTED and INTERNAL, which map to `UNAVAILABLE` like UNAVAILABLE and DEADLINE_EXCEEDED, because a commit that failed with them may have landed (ruled in review of #33; the same-key retry replays or applies once, ST3); a `StoreError` carries `kind`, never a numeric `code`, because the SDK retries a callback error whose numeric code is retryable; a mapped error keeps the original as `cause` and its message carries the cause's name and code only. (5) `meta` above 1 KiB is an `INVARIANT` before the transaction. (6) Outbox rows are built only for an aggregate change (a no-op has none by construction). (7) **`endGame` is exempt from the size guard's hard limit.** It changes no content, but the `version` and `store.updatedAt` digits can grow the estimate by a few bytes, so "next <= prev" alone refused it on an oversize aggregate (found by `budget.test.ts`); the host's escape hatch (5.7) must always work. (8) A `delete` of a document that does not exist counts in the WriteSet (it is one transaction write) but is invisible to a document diff; the budget test makes the leaver hold a drafts doc so the diff oracle sees every write.
- **`deleteGame`.** Built in #36. The Engine row is registered and returns `deleteGame: true`; `extraReadPaths` adds `roomCodes/{prev.roomCode}` for that command; `planCommand` returns `{kind: "deleting"}` after planning phase 0: one `update` of `store.deleting {at, by}` and `store.updatedAt`, the conditional `roomCodes` delete, and the `deletions/{gameId}` job. It writes no ledger row, no events doc, no outbox row and no version bump, and it skips the size guard because the aggregate is not rewritten. The runner and the harness op are in 6.4 and 10.3.
- **Harness diagnostics.** The emulator-only `storeHarness` callable (`functions/src/harness/store.ts`, LLD 0 P9 as amended) wraps `execute` with emulator deps: the clock is the request's `now` (else the wall clock), the seed of attempt k is `seeds[k-1]` (else a fresh one), `faults.throwAt` throws at `afterWritesBuffered` (inside the callback, after the writes are buffered) or `afterCommit` (after the transaction resolved), and `faults.abortAttempts` throws an `ABORTED`-coded error on the listed attempts. It reports `{outcome, attempts, writes, seeds}`.
- **ST2, amended (review of #33).** Besides `attempts`, the callback sets one more diagnostic, `loadedVersion` (the aggregate version the latest attempt read), overwritten on every attempt and never read by the outcome, so a rerun is unaffected; it puts `version` on the error log line as 5.8 asks.
- **Logging.** After the transaction: `command.done` (accepted, or `outcome: "error"` with the `StoreError` kind as `reason` and the loaded `version` when one was read), `command.rejected`, `txn.retry` when `attempts > 1`, `store.size.warn` when the guard warned; ids, codes and counts only (P19).

## 6. Other write paths

### 6.1 `createGame` (room-code allocation)

createGame has no aggregate to lock and no `gameId` before it runs, so its ledger lives under the host: `hosts/{hostUid}/idem/{hash}` (same TTL group).

```ts
export async function createGame(db: Firestore, d: Deps, i: { hostId: Uid; hostName: string; settings?: Partial<Settings>; idemKey: string }) {
  const ledger = db.doc(`hosts/${i.hostId}/idem/${idemId({ kind: "user", uid: i.hostId }, i.idemKey)}`);
  for (let attempt = 0; attempt < 8; attempt++) {
    const gameId = db.collection("games").doc().id, code = newRoomCode(d), hostPlayerId = newPlayerId();   // fresh per attempt, nothing committed yet
    try {
      return await db.runTransaction(async (tx) => {
        const [lSnap, cSnap] = await tx.getAll(ledger, db.doc(`roomCodes/${code}`));
        if (lSnap.exists) return { gameId: lSnap.get("gameId"), roomCode: lSnap.get("roomCode"), replay: true };
        if (cSnap.exists) throw new CodeTaken();                         // not retried by the SDK; handled by the outer loop
        const now = d.clock(), seed = d.newSeed();
        const res = decide(null, { type: "createGame", gameId, roomCode: code, hostId: i.hostId, hostPlayerId, hostName: i.hostName, settings: i.settings }, { now, rng: makeRng(seed), mintId: d.mintId, actor: { kind: "user", uid: i.hostId }, drafts: {} });
        if (!res.ok) throw new Rejected(res.error);                      // CONTENT_REJECTED (host name), INVALID_ARGUMENT
        const a = res.value, w = new WriteSet(tx, { max: MAX_WRITES });
        w.create(gameRef(gameId), withStore(a.state, now));
        w.create(eventRef(gameId, 1), eventDoc(1, now, a, i, seed));
        for (const vw of fanOut(null, a.state, { now, storedRev: 0 })) w.merge(viewRef(gameId, vw.docId), viewFields(ViewDocSchema.parse(vw.doc)), VIEW_FIELDS);
        w.create(db.doc(`roomCodes/${code}`), { gameId, createdAt: now });
        w.create(ledger, { at: now, expiresAt: ttl(now, 7), gameId, roomCode: code, version: 1 });   // 6 writes in all: game, event, 2 views (host, spectator), roomCode, ledger
        return { gameId, roomCode: code, replay: false };
      });
    } catch (e) { if (e instanceof CodeTaken) continue; throw e; }
  }
  throw new StoreError("ROOM_CODES_EXHAUSTED");                           // resource-exhausted; at 160,000 codes this means thousands of live lobbies
}
```

- Collision handling: the read of `roomCodes/{code}` inside the transaction plus `create()` guarantees one live game per code (ST8) even under a race (the lock on the missing doc serializes two creators). Eight attempts at (live games / 160,000) collision probability each is effectively never exhausted; a metric `dc_roomcode_collision_total` tracks it.
- Release: FINISHED, ENDED and `deleteGame` delete `roomCodes/{code}` in their own transactions (5.2, 6.4). `Game.roomCode` keeps the old string for display; a reused code simply points at the newer game.
- `findByRoomCode(code)` is one `get` of `roomCodes/{code}`; it returns a `gameId` only for games that still hold the code, i.e. LOBBY, WRITING or PLAYING. Rate limiting is Identity's (A4).
- **As built (#34).** `functions/src/store/create.ts` holds the pure `planCreate` and the loop `executeCreate` (`createGame` returns its outcome). One attempt is one transaction: `getAll` of `hosts/{hostUid}/idem/{hash}` and `roomCodes/{code}`; a ledger hit replays **before** the code is judged (so a re-used key wins even when the code now belongs to a newer game); a present code raises the plain `CodeTaken`; otherwise `decide(null, createGame, …)` and the six writes. Per attempt, drawn before the transaction, `deps.newSeed()` supplies two seeds: the first derives both the room code (`roomCodeFromSeed`, rejection sampling over the 20 consonants, `RoomCodeSchema` on every output) and the host's `p_`+8 id (`playerIdFromSeed`, a domain-separated hash of the same seed); the second seeds `decide`. `now` is read inside the callback, so the committing attempt's clock is the recorded one; drawing both seeds outside it keeps a rerun of the callback identical (ST2) and keeps the collision scripting stable. The loop is bounded at `CREATE_ATTEMPTS = 8`; `roomcode.collision` (with `attempts`) is logged after a lost attempt, never inside the transaction. `CodeTaken` is not a `StoreError` and carries no numeric `code`, so the SDK never retries it as a transaction error; an `ALREADY_EXISTS` whose message names this attempt's `roomCodes/{code}` is treated as the same loss and retried — belt and braces, because the emulator turns the lost lock into a retry that sees the code (the #34 Phase 0 spike saw `CodeTaken` in 3 of 3 races). Eight losses throw `StoreError("ROOM_CODES_EXHAUSTED")` with nothing written. Each attempt's `runTransaction` passes `{ maxAttempts: MAX_ATTEMPTS }` (8), exactly as `runCommand` does, so the SDK's own retries absorb commit-time contention (ABORTED, a lost lock, a same-key race) inside a single attempt; the outer 8-attempt loop, and the `attempts` the harness reports, count room-code collisions only. The ledger is a `CreateLedgerDoc` (`at`, `expiresAt = at + 7 d`, `commandType: "createGame"`, `version: 1`, `gameId`, `roomCode`); the Store writes only `hosts/{uid}/idem/{hash}` and leaves the `hosts/{uid}` parent to Identity. Views come from `planViews` (`storedRev: 0`), so the host and spectator docs exist at creation. `findByRoomCode(db, code)` applies `RoomCodeSchema` first (case and whitespace normalize; a malformed code is `null` before any read), then one `get`, and returns `{gameId, createdAt}` with no time window (Identity owns the 72 h rule, LLD 4 §8.1). The emulator-only harness gains `createGame` and `findByRoomCode` ops for the suites; the real `createGame` and host-profile callables are #41 and the `findByRoomCode`/join/lobby callables are #42.

### 6.2 `join` and Identity (who does what)

| Step | Owner | Detail |
|---|---|---|
| Join recovery lookup | Identity | `keyHash = sha256(idempotencyKey)` (the raw key is never logged or stored); one `get` of `joinIdem/{keyHash}` **before** resolving the code, so a same-key retry finds its committed seat even after the code expired or was released. A hit returns the custom token and secret only while `seats/{playerId}.firstSignInAt == null`, else `NOT_FOUND` (K-C, LLD 4) |
| Rate limit, code to `gameId` | Identity + `findByRoomCode` | `rateLimits` counters (tech-stack 7) |
| Mint `playerId` (`p_`+8), seat uid `seatUid(gameId, playerId)`, secret and its hash | Identity | Deterministic from `(gameId, keyHash)` so a retry mints the same values (5.5); `runCommand` receives `idemKey = keyHash` (2.4). The Engine requires `actor.uid === seatUid(game.id, playerId)` (LLD 1 section 6) |
| Validate, name uniqueness, room full, moderation, add player, `PlayerJoined` | Engine via `runCommand` | `NAME_TAKEN`, `ROOM_FULL`, `CONTENT_REJECTED` come back as rejections; **nothing** is written, so no orphan seat doc |
| Persist the seat record `games/{g}/seats/{playerId} = {uid, secretHash, createdAt, epoch: 0, notBefore: 0, firstSignInAt: null, revokedAt: null}` (`secretHash` is nullable: null once the seat is revoked, LLD 4) and `joinIdem/{keyHash} = {gameId, playerId, uid, createdAt, expiresAt: +7d}` | Identity's pure `extraWrites`, committed by the Store | Same transaction as the aggregate: a player exists iff its secret hash and its `joinIdem` row exist (ST1) |
| Write the new viewer's `views/{uid}` and refresh every other view | Store (fan-out) | `viewersOf(next)` includes the new seat, so its doc exists before the response returns |
| Mint the Firebase custom token for `uid` | Identity, **after** commit | `createCustomToken(uid, { ep: epoch })`: one developer claim, `ep` (seat epoch), on seat custom tokens; no other custom claims (K-B). Auth users are created lazily at first sign-in; the Store never calls Auth. A lost response is repaired by retrying with the same key: `joinIdem` (or the ledger) replays and Identity mints another token for the same uid (`meta` echoes `playerId`), only while `firstSignInAt == null` |
| Rejoin and link reissue | Identity | Rewrites `seats/{playerId}` directly (no game command, no version bump, no view write, PJ10): reissue increments `epoch` and sets `notBefore = ceilToSecond(now)`, killing every token minted before; `principalOf`/`rejoin` set `firstSignInAt` once |
| Auth user disablement and `seats.revokedAt` on `PlayerLeft`/`PlayerRemoved` (deletion of the Auth user happens in the `deleteGame` cascade, 6.4) | Identity (`handleIdentityRow`), from `topic: "identity"` outbox rows (section 8) | Outbox, not the transaction, because Auth calls are side effects (ST2) |

### 6.3 `removeCard` versus append-only round docs (resolves LLD 2 open question 3)

Decision: **a single documented exception to S3.** A removed card's text must also leave the world-readable history, otherwise moderation is cosmetic. The host may remove only a card that has been shown to the table (played into a round's reveal, or in a resolved round or history; gameplay.md, LLD 1 `removeCard`), and the Engine refuses a removal that would drop totals below R_min/G_min (the host's escape hatch is `endGame`). In the `removeCard` transaction:

1. Step 1 reads, from `prev.history` (id-only), `roundsContaining(prev, cardId)`: rounds whose `greenCardId` or any `plays[].cardId` equals the id. Those `rounds/{n}` docs are fetched in the same `getAll` (reads before writes). The number is bounded by the rounds played (a card appears in more than one round only when the deck recycles): at most 91 in the heavy realistic case (5.7), so at most about 91 extra reads and writes, far under the 500 limit and under `MAX_WRITES = 200`.
2. After `decide` accepts, each such doc is rewritten by `redact(doc, cardId)`: the matching `green.text` or `plays[k].text` and `plays[k].pitch` become `null`, `redacted` becomes `true`; nothing else changes.
3. Only `redact` may update a round doc (ST13); `rounds` creation elsewhere uses `create()`.

A card that was never shown (still in a hand, a deck or a pile, or only in an unrevealed submission) cannot be named by `removeCard`, so no round doc is touched in that case; a refused removal writes nothing. No Engine change beyond LLD 1's precondition is needed. Which card ids the host can see is LLD 2's concern (resolved there as open question 4).

### 6.4 `deleteGame` cascade (S5)

`deleteGame` cannot be one transaction (thousands of documents, an external Auth call). The atomic point is **phase 0**, after which the game is gone for every purpose and the rest is resumable cleanup.

**Phase 0, inside `runCommand` (5.2).** `decide` authorizes (host only, any phase including ENDED) and returns `deleteGame: true`. The transaction sets `store.deleting`, deletes `roomCodes/{code}` **only if** that doc (read in step 1) still has `gameId == this gameId` (a FINISHED or ENDED game already released its code, which may now belong to a newer live game; ST8), and creates `deletions/{gameId}` holding `seatUids` (every `players[].uid` except `hostId`; the host's Auth account is theirs and is never deleted) so the cascade does not need the aggregate to survive. `seatUids` alone misses LOBBY leavers (their player records are deleted, LLD 1 7.2), so the `identity` stage also reads `seats/*`, which outlives the player record (C-SEATS). From the commit on, every command on the game is rejected `NOT_FOUND` (step 1 of 5.2); the callable returns success to the host immediately.

**Phase 1, the runner**, `onDocumentCreated("deletions/{gameId}")` exported as `deletionRunner` (LLD 0 `exports.json`, open question 14) with `retry: true`, `timeoutSeconds: 540`, plus an hourly redrive (`status == "running" and heartbeatAt < now - 15 min`, LLD 6's scheduler hosts it):

```ts
const STAGES: [string, (c: Ctx) => Promise<void>][] = [
  ["views",     c => c.db.recursiveDelete(c.game.collection("views"))],     // first: clients stop seeing the game
  ["drafts",    c => c.db.recursiveDelete(c.game.collection("drafts"))],
  ["identity",  async c => {                                                  // C-SEATS: union, so LOBBY leavers' disabled Auth users are purged too
                  const seatDocs = await c.game.collection("seats").get();        // `seats` is deleted only in the later `history` stage
                  const uids = [...new Set([...c.job.seatUids, ...seatDocs.docs.map(d => d.get("uid") as Uid)])].filter(u => u !== c.job.hostId);
                  await c.identity.purgeSeats({ gameId: c.gameId, uids });         // LLD 4: delete Auth users, revoke refresh tokens; unknown uid = success
                }],
  ["push",      c => deleteWhere(c.db.collection("pushSubs").where("gameId", "==", c.gameId))],
  ["joinIdem",  c => deleteWhere(c.db.collection("joinIdem").where("gameId", "==", c.gameId))],   // else TTL'd within 7 days anyway
  ["hostIdem",  c => deleteWhere(c.db.collectionGroup("idem").where("gameId", "==", c.gameId))],   // the host's createGame ledger names the game and its code
  ["history",   c => all([c.game.collection("rounds"), c.game.collection("events"), c.game.collection("outbox"),
                           c.game.collection("idem"), c.game.collection("seats"), c.game.collection("notifLog")].map(r => c.db.recursiveDelete(r)))],
  ["aggregate", c => c.game.delete()],                                       // last: the aggregate is the resume marker
];
export async function runDeletion(db: Firestore, deps: Deps, gameId: GameId) {
  const jobRef = db.doc(`deletions/${gameId}`);
  let job = (await jobRef.get()).data() as DeletionJob | undefined;
  if (!job || job.status === "done") return;
  for (const [name, run] of STAGES) {
    if (job.stagesDone.includes(name)) continue;
    await run(ctx(db, deps, gameId, job));                                    // idempotent: re-running a finished stage deletes nothing
    job = { ...job, stagesDone: [...job.stagesDone, name], heartbeatAt: deps.clock() };
    await jobRef.update({ stagesDone: job.stagesDone, heartbeatAt: job.heartbeatAt, attempts: FieldValue.increment(0) });
  }
  await jobRef.update({ status: "done", expiresAt: ttl(deps.clock(), 7) });
}
```

- **Batching.** `recursiveDelete` uses `BulkWriter` (rate-limited ramp-up, internal batches under the per-commit limits), so no stage builds a single oversized transaction. A game has at most a few thousand documents (section 12), so one run fits the 540 s budget; if it does not, the next retry resumes at the first unfinished stage and re-enumerates only what remains.
- **Failure halfway.** Stages commit progress after each stage. A crash leaves `status: "running"`: the platform retry and the hourly redrive re-run `runDeletion`; completed stages are skipped and a partially completed stage is idempotent. Meanwhile the game is un-commandable, its views are gone or being removed, and `rounds`/`events` may linger briefly; a job `running` for more than one hour raises an alert (log event `deletion.stuck`). Identity failures (Auth outage) stall at `identity` and retry; nothing later runs, so seat Auth users are never orphaned by an ordering bug.
- **Why this order.** Views first (the only client-readable game data besides `rounds`); Identity before `history` and the aggregate so the `seats` rows (read for the union above) and `seatUids` (copied to the job) are still present; `pushSubs` has no rule exposure; the aggregate last so an interrupted delete is always visible and resumable.
- **Not deleted:** `hosts/*/decks` (D2); `hosts/*/idem` rows that name another game (the `hostIdem` stage removes only rows whose `gameId` is this game); `rateLimits` (keyed by hashed code or IP, TTL'd); backups (section 12).
- **Replay of `deleteGame`.** Phase 0 writes no ledger row, and step 1 of 5.2 returns `rejected NOT_FOUND` for any command on a `deleting` game before the ledger is consulted. So a replay of the same key, a second `deleteGame` with a new key, and a `deleteGame` after the cascade finished all return `rejected NOT_FOUND` (never `replay: true`). The client (LLD 5/7) treats `NOT_FOUND` on `deleteGame` as success.

**As built (#36).** Phase 0 lives in `planCommand` (`functions/src/store/plan.ts`): `extraReadPaths` returns `roomCodes/{prev.roomCode}` for `deleteGame`; the planner checks `code["gameId"] === gameId` before the delete; the job comes from `newDeletionJob(gameId, game, now)` (`functions/src/store/delete.ts`) with `seatUids` = every `players[].uid` except the host. `runDeletion(db, deps, gameId)` (`delete.ts`) applies the eight `DELETION_STAGES` in the order above; `identity` reads `seats/*`, unions the uids through `identityUids(job, seatUids)` (host excluded) and calls the injected `IdentityPort.purgeSeats`; `push`, `joinIdem` and `hostIdem` page their registry queries through `deleteWhere` (400-row batches, because this Admin SDK's `recursiveDelete` does not take a `Query`); the other stages use `recursiveDelete`. `hostIdem` is the collection-group query on `idem.gameId`, so it removes the host's `createGame` ledger that names the game and its code; a same-key `createGame` after `done` therefore creates a new game rather than replaying the deleted one. It increments `attempts` once per invocation (not per stage; the pseudocode's `increment(0)` was a no-op), commits `stagesDone` and `heartbeatAt` after each stage, and on completion sets `status: "done"` and `expiresAt = now + 7 d`. `deps.faults.afterStage(stage, "work" | "commit")` is the emulator seam; `deps.log` defaults to the real `log` and the only line is `{event: "deletion.stuck", gameId}` for a running job whose heartbeat is older than one hour. A missing or `done` job is `{kind: "noop"}`, and a second run after `done` touches nothing. Deliberate deviations from the pseudocode, recorded here: the trigger export and the real `purgeSeats` are #43 (Q1, `exports.json` stays unchanged) and `attempts` counts invocations (above). The harness op `runDeletion` returns `{result, purged, logs}` with a recording fake port; the deployed `deletionRunner` and the real `purgeSeats` are #43, the `deleteGame` callable is #40 and the hourly redrive is M6.

### 6.5 `rebuildViews(gameId)`

An admin-only Store function that, in one transaction, reads the aggregate, runs `fanOut(null-as-all, game, {now, storedRev: 0})`, writes all view docs and sets `store.viewsRev = PROJECTOR_REV` without bumping `version` (after a deploy the rebuilt docs win on `(version, viewsRev)`, K-F; in the rollback case see 5.6). Active games need no script: `runCommand` rebuilds on the first accepted user command after a deploy whether or not it changes the aggregate (5.2, 5.6). Used after a projector deploy for idle games (an optional script over `where store.viewsRev < REV`) and for incident repair; PJ10 holds because `view.version` equals the unchanged aggregate version.

**As built (#35).** `rebuildViews(db, gameId, {now})` (`functions/src/store/rebuild.ts`) splits like `createGame`: the pure `planRebuild(gameId, doc, {now})` returns the outcome and its `DocWrite`s, and the shell runs it in one `runTransaction` with `maxAttempts: 8`. Like `planCommand`, it writes `gamePath(gameId)` and its views from the caller's id, not the stored `id` field. The result is typed: `{kind: "rebuilt", gameId, version, viewsRev, writes}` (the unchanged version and the count of documents written), or `{kind: "missing"}` / `{kind: "deleting"}` with zero writes. It is **unconditional**: it never skips at the current rev, because incident repair may need it (Q1), and it calls `planViews(gameId, null, game, {now, storedRev: 0})`, so fans out every `viewersOf` doc and can emit no `clearDraft`. It sets `store.viewsRev = PROJECTOR_REV` and `store.updatedAt = now`, never bumps `version`, and writes no `events` doc, no ledger row and no outbox row; the draft region is untouched. The aggregate is read inside the transaction, so the aggregate lock serialises it against the `deleteGame` commit and a `store.deleting` game is refused (Q2). It is additive only: it deletes nothing, so a `gone` tombstone (LLD 2 8.2) keeps its old rev. The optional sweep script is not built (Q3); the emulator-only `storeHarness` op `rebuildViews` is the only caller, so a deployed caller/script remains unowned.

## 7. Reminder queries: `listWaitingOn`

**Who maintains `reminderDueAt` (resolves LLD 1 open question 2 and the HLD T1 conflict).** The Engine, only. `settle` sets `waitingOn`, `episode`, `episodeGen`, `waitingSince`, `reminderDueAt` on every aggregate-changing command (LLD 1 4.2, X8), in WRITING, SUBMITTING and JUDGING (C-WRITING). The single definition is LLD 1 4.2's (K-E): in WRITING `waitingOn` = seated players with status `writing`; a late joiner in status `writing` is added to `waitingOn` in any phase (WRITING or PLAYING) without changing the episode or the `waitingSince` of the others; `episodeGen` increments each time an episode starts (including after unpause), so two successive episodes of the same kind are distinguishable; the Store writes the `Game` it is given and nothing else. Advancing `reminderDueAt` after a reminder is the Engine's `markReminded` system command, run through the ordinary `runCommand` (so it is serialized and retried like any command, bumps `version`, writes an `events/{version}` doc with `events: []`, and fans out nothing under skip-unchanged). Consequence for T1: the Scheduler never edits game fields itself, but it does trigger one Engine-decided state change; T1 should read "the Scheduler holds no game logic and writes only via `markReminded`" (open question 3).

```ts
export interface WaitingGame { gameId: GameId; episode: string; episodeGen: number; waitingOn: PlayerId[]; since: number; dueAt: number; version: number }
export interface WaitingPage { items: WaitingGame[]; next: { dueAt: number; gameId: GameId } | null }

export async function listWaitingOn(db: Firestore, o: { now: number; limit?: number; after?: WaitingPage["next"] }): Promise<WaitingPage> {
  const limit = o.limit ?? 100;
  let q = db.collection("games")
    .where("reminderDueAt", "<=", o.now)                       // null (not waiting, paused, finished) never matches a numeric bound
    .orderBy("reminderDueAt").orderBy(FieldPath.documentId())  // stable keyset order; served by the automatic single-field index
    .select("reminderDueAt", "episode", "episodeGen", "waitingOn", "waitingSince", "version")
    .limit(limit);
  if (o.after) q = q.startAfter(o.after.dueAt, o.after.gameId);
  const snap = await q.get();
  const items = snap.docs.map(s => ({ gameId: s.id, episode: s.get("episode"), episodeGen: s.get("episodeGen"), waitingOn: s.get("waitingOn"), since: s.get("waitingSince"), dueAt: s.get("reminderDueAt"), version: s.get("version") }));
  const last = snap.docs.at(-1);
  return { items, next: snap.size === limit && last ? { dueAt: last.get("reminderDueAt"), gameId: last.id } : null };
}
```

- No composite index and no `paused == false` / `phase in (...)` filters: `reminderDueAt` is non-null only while `episode` is non-null, i.e. in `WRITING` or `PLAYING` (SUBMITTING, JUDGING) and not paused (LLD 1 4.2, X8), so the single-field index is exact. This drops the composite tech-stack section 6 asked for (open question 2). The sweep still re-checks the game inside `markReminded` (`episode` and `episodeGen` equality and `now >= reminderDueAt`, LLD 1 7.1), so a stale page row, including one from an earlier episode of the same kind, can never cause a reminder.
- The sweep loops pages (`MAX_PAGES = 20`, 2000 games per run; the remainder is picked up next hour: the query is level-triggered, not edge-triggered).
- **Reminder delivery is transactional.** For each due game the sweep calls `runCommand({cmd: {type:"markReminded", episode, episodeGen}, actor: {kind:"system"}, idemKey: "remind:{episode}:{dueAt}"})` (`dueAt` already differs between generations, since it derives from that episode's `waitingSince`). When the Engine accepts it with `aggregateChanged: true` (episode and generation matched, and due), the Store also writes one outbox row in the same transaction as the new `reminderDueAt`. The row is built by `buildOutbox(prev, next, cmd, a, now)`, which sees `cmd.type === "markReminded"` and `a.aggregateChanged`: `event = {t:"Reminder", episode: prev.episode, episodeGen: prev.episodeGen, dueAt: prev.reminderDueAt, waitingOn: next.waitingOn}` (the episode and generation that were just reminded and the due time just consumed, matching the ledger key; LLD 6's liveness check compares `episodeGen`, not just the episode kind), `i = 0`, id `v{next.version}_0`, plus the usual `roster`, `judgeId`, `paused`, `round` and `waitingOn` context (section 8). The `markReminded` episode is the command; the `Reminder` row is its only side-effect record, so one committed `markReminded` yields exactly one row. A no-op `markReminded` (episode or `episodeGen` changed, or not yet due) writes nothing, not even a row. Either both commit or neither: no lost reminder after a crash between "sent" and "advanced", no double. LLD 6's trigger sends from the row and dedupes by `(rowId, uid)`. (LLD 6 accepted this design, open question 5.)
- Cost: one query per page (reads = documents returned) plus 2 reads and 4 writes per due game (aggregate, `events` doc, ledger, outbox row).

**As built (#35).** `listWaitingOn` (`functions/src/store/waiting.ts`) is built from the `waitingOn` registry entry via `registryQuery` (queries.ts), so the declared shape and the consumer cannot drift; `waitingPageQuery(db, {now, limit, after})` then adds `.select("reminderDueAt", "episode", "episodeGen", "waitingOn", "waitingSince", "version").limit(limit)` and, with a cursor, `.startAfter(dueAt, gameId)`. The order is keyset `(reminderDueAt, document id)`; the default limit is 100. The pure `pageOf(docs, limit)` returns items exactly `{gameId, episode, episodeGen, waitingOn, since, dueAt, version}` (`since` is the stored `waitingSince`) and makes `next` `{dueAt, gameId}` only when the page is full, so `next` is null only on a short page and a full final page yields one empty page then null. There is no extra filter: `reminderDueAt` is non-null only while an episode exists, so the single-field index is exact (Q4). The paging fixture is test-local: 250 due games written lean with the Admin SDK (249 of them) plus one `Table.lobby` game patched due, whose item is checked against its aggregate; the future and null sets are 50 each. The `viewsStale`/paging fixtures and their CI seeding remain #37. The Phase 0 emulator spike showed keyset paging with tied `reminderDueAt` values returns no duplicates or gaps, a cursor crosses a tie boundary exactly, and a full final page yields one empty page.

## 8. Outbox

- **Shape.** `OutboxRow` (2.3). Rows are written in the command transaction, one per qualifying domain event: `NOTIFY_EVENTS = {WritingStarted, RoundOpened, SubmissionsClosed, WinnerPicked, GameFinished, GameEnded, JudgeChanged, PausedChanged}` with `topic: "notify"` (LLD 1 11.1; C-WRITING; `GameEnded` notifies every seated player, K-D; a `PausedChanged` row is written for both directions: `paused: true` (inert, LLD 6 notifies nobody on it) and `paused: false`, the unpause notice; LLD 6's `planVersion` relies on the `paused: true` rows existing), `{PlayerLeft, PlayerRemoved}` with `topic: "identity"` (Auth user disablement and push cleanup, section 6.2), and the `Reminder` row (section 7). `buildOutbox(prev, next, cmd, a, now)` is pure: `cmd` and `a.aggregateChanged` tell it a `markReminded` happened (the Reminder row); events come from `a.events`. All other events live only in `events/{v}`. Row id is `v{version}_{i}`: unique, stable across retries, and the natural dedupe key part for N1 (`{rowId}_{uid}`).
- **Self-contained.** Each row snapshots the post-state `roster` (seated `playerId`, `uid`, `status`), `judgeId`, `paused`, `round?: {number, phase}` (open round; absent when none) and `waitingOn` (ids), because LLD 1 11.1 resolves recipients "from the event and the post-state" and the live aggregate may already have moved on when the trigger runs. LLD 6 therefore never does a racy live read of `games/{g}`: it decides `WritingStarted` (all active players, `waitingOn` = writers), `JudgeChanged` (new judge, `round` and `phase` to tell SUBMITTING from JUDGING), unpause (`PausedChanged` with `waitingOn` as recipients) and `Reminder` from the row alone. Rows hold ids only, never card text or names (N2).
- **Delivery.** `onDocumentCreated("games/{gameId}/outbox/{rowId}")` (LLD 6 for `notify` and `Reminder` rows; LLD 4 ignores them). `identity` rows have **two consumers**: LLD 4 (revocation and Auth disablement via `handleIdentityRow`) and LLD 6 (push cleanup via `clearSeatPush`); neither consumer's state gates the other. Triggers are at-least-once and unordered: consumers must be insensitive to order and duplicates. Ordering information is available (`version`, `i`); the Store promises only that rows of one command exist together (one commit) and that no row exists without its state change (S2).
- **Completion and redrive.** `processedAt` has one writer per topic: LLD 6 for `notify` rows (with `notifAttempts`, `poisonedAt`, `notifSkipped`), **LLD 4 alone for `identity` rows**. LLD 6 records its own progress on `identity` rows in `notifDoneAt` (never `processedAt`). LLD 6's hourly job calls LLD 4's exported `handleIdentityRow(db, gameId, rowId)` for leftover `identity` rows and its own handler for `notify` rows. The query is `collectionGroup("outbox").where("processedAt","==",null).where("at","<", now - 10 min)` (composite in section 4). Because LLD 4 may finish an `identity` row (setting `processedAt`) before LLD 6's push cleanup succeeds, the hourly job runs a second query for push-cleanup retry, independent of `processedAt`: `collectionGroup("outbox").where("topic","==","identity").where("notifDoneAt","==",null).where("at","<", now - 10 min)` (second outbox composite in section 4), calling `clearSeatPush` for each. `buildOutbox` writes `notifDoneAt: null` explicitly on every `identity` row so the equality filter matches.
- **As built (#33).** Rows are built only for an aggregate change; `i` is the event's index in `a.events` (non-qualifying events leave gaps in `i`); the Reminder row is `i = 0` and the planner fails `INVARIANT` if a `markReminded` ever also produced a qualifying event at index 0. Proved by U3 and `outbox.test.ts`.
- **Retention.** `expiresAt = at + 14 days` (TTL). Row counts: about 1 to 3 per round, so a 25-round game writes under 100 rows total.
- **Dedupe handoff to LLD 6.** The Store guarantees unique, stable row ids and that a retried transaction cannot create two rows for one event. LLD 6 owns `notifLog/{rowId}_{uid}` (created before sending, TTL 30 days) for N1.

## 9. Event log

- **Shape.** `EventDoc` (2.3) at `games/{id}/events/{version}`, written by `create()`. **Version rule (shared with LLD 1 4.1):** every accepted command that changes the aggregate, and every `markReminded` that changes it, gets exactly one event doc, so event versions are contiguous with aggregate `version` and there are no gaps; `events` may be `[]` (`markReminded`, count-only `saveDraft`). A `markReminded` no-op and a text-only `saveDraft` change nothing and write no event doc (and, per E3, no version).
- **Seed and actor.** `seed` and `actorPlayerId` are stored only for commands that mint no card ids: they let support replay shuffle order, and nothing else (card ids come from `ctx.mintId()`, a CSPRNG, and are not reproducible from any stored seed). For `finishWriting`, `importDeck` and `writeIn` the doc omits **both** fields, so no stored event can be combined with the final state to recover who authored a pooled card (E8, C-EV). A `writeIn` doc also records `commandType: "confirmSubmission"` and the same events as a hand play, so `commandType` never marks a write-in (K-A, LLD 1 section 11). The committing attempt's seed (5.5) is the one stored, where stored.
- **Purpose.** Support and debugging (what happened, in order; shuffle order is replayable from `seed` for non-minting commands), a source for future analytics, and a tripwire: `create()` on an existing `events/{version}` fails loudly if the version sequence ever desyncs. It has no runtime consumer and no client access; notifications read the outbox, clients read views.
- **Content.** Ids, counts and enum kinds only (LLD 1 section 11, N2); never text, names or pitches.
- **As built (#33).** `eventDoc` omits `seed` and `actorPlayerId` when `a.redactEnvelope` is set or the command is `writeIn`; `actorPlayerId` is the actor's pre-state seat, else the post-state seat (a `join`), and is omitted for the system actor and an unseated host (5.9). Proved by U4 and `event-log.test.ts` (finishWriting and startGame).
- **Retention.** Kept with the game and removed by the `history` deletion stage; not TTL'd (section 2.6).

## 10. Local development and test plan

### 10.1 Emulator seeding and fixtures

- `bun scripts/seed.ts --fixture <name>` (a repo script, not shipped) runs against the Firestore and Auth emulators. It refuses unless `GCLOUD_PROJECT` starts with `demo-` and `FIRESTORE_EMULATOR_HOST` is set (LLD 0 P1).
- Fixtures are **built, not stored**: each is a scripted scenario (LLD 1's `scriptedRng`, fixed `clock`, fixed ids such as `gameId = "gFixture00000000lob1"`) driven through the real `createGame` and `runCommand`, so every seeded document is one the production path would have written, views included. Catalogue: `lobby3`, `writing4` (mixed drafts, one finished), `submitting5` (two submitted), `judging6`, `paused3`, `finished6-votes`, `ended4`, `midsize10` (10 players, 91 rounds, 500 votes: the size fixture), `departed40` (50 joins), `viewsStale` (`store.viewsRev` lowered). **As built (#35):** the `viewsStale` shape is proved with a test-local patch (`functions/test-integration/store/views.test.ts` lowers `store.viewsRev` on the aggregate and every view doc); the named fixture and its CI seeding are #37.
- `firebase emulators:start --import ./.emulator-data --export-on-exit` is optional for developers; `.emulator-data/` is gitignored. Integration tests start from an empty emulator and call `clear()` between files.
- Emulator-only knobs mirror LLD 0 P9: `clock()` from an env var and `faults` hooks are honored only when `FUNCTIONS_EMULATOR === "true"`. **As built (#33):** until the real callables exist (#40-#43), the store suites reach `runCommand` and `load` through the emulator-only `storeHarness` callable, which takes a per-request `now`, per-attempt `seeds` and `faults` (5.9), and the actor; the env-var clock remains the rule for the real callables. The fixtures script and its catalogue are #37. As built (#34): `Table.lobby` creates fresh lobbies through the real `createGame`, so every suite that starts from a fresh lobby exercises the production creation path; `Table.seed` remains for states advanced in Bun (a `departed40`-shaped game, a long-history game for `removeCard`), which #37's fixtures replace. A seeded game is built in Bun with the real Engine and an in-memory driver (`functions/src/store/test-support.ts`) and written with the Admin SDK in the shape the Store writes (`functions/test-integration/store/support/seed.ts`). From the seed on, every command goes through the harness. As built (#35): the harness also carries `op: "rebuildViews"` (gameId, now) and `op: "listWaitingOn"` (now, optional limit and cursor), validated before any Firestore read. As built (#36): `op: "runDeletion"` (gameId, `now`, optional `faults.afterStage{stage, point}` and `captureLog`) runs `runDeletion` with a recording `IdentityPort` (it returns `{gameId, uids, requested, deleted}` and writes nothing) and returns `{result, purged, logs}`; the cascade fixture (`support/cascade.ts`) builds the 4-seat resolved-round state with a late joiner, a LOBBY leaver's seeded `seats/*` row, a non-LOBBY departure and seeded pushSubs/joinIdem/notifLog/hosts rows (their real writers are #41 for the host ledger, #42 for joinIdem/seats and M6 for pushSubs/notifLog).

### 10.2 Suites and where they run (LLD 0 CI)

| Suite | Location | Command (LLD 0) |
|---|---|---|
| Pure helpers: `idemId`, `WriteSet` (both merge orders), `buildOutbox(prev, next, cmd, a, now)`, `eventDoc`, `redact`, `roundsContaining`, `estimateBytes`/`guardSize`, `mapStoreError`, the planner `planCommand` (5.9; the 5.7 budget on 52 view docs and a 91-round `removeCard`), `roomCodeFromSeed`, `playerIdFromSeed` and `planCreate` (#34), `waitingPageQuery`/`pageOf` and `planRebuild`/`rebuildViews` (#35; `listWaitingOn`'s shell is proved by `I27` in 10.3, not by a unit test), `newDeletionJob`/`isStuck`/`identityUids`/`stuckLine` (#36), index-registry check | `functions/src/store/*.test.ts` | `bun test functions/src` |
| Rules | `rules-test/` | `bun run test:rules` |
| Store integration against the Node bundle | `functions/test-integration/store/*.test.ts` | `bun run test:integration` |
| Post-deploy index and rules smoke | `scripts/smoke.ts` | after each deploy |

### 10.3 Store integration tests

| Test | Setup and assertion | Covers | Status |
|---|---|---|---|
| **Contention** | 9 players `confirmSubmission` in parallel on `submitting5`-style game with 10 players; also 20 parallel mixed commands from 10 actors | All accepted or typed-rejected; final `version` = start + accepted count, no gaps or repeats; exactly one `events` doc per version (contiguous, no gaps); every view equals a full `project` rewrite (PJ11); `txn.retry` observed at least once across the run | Proved (#33, `contention.test.ts`): 9 parallel `confirmSubmission`s on a 10-player game, and 20 mixed commands from 10 actors in two waves of 10 in flight; versions, contiguous events and PJ11 hold. Why two waves: the Functions emulator starts a worker per concurrent call, and with 20 in flight on the 3.8 GiB, 2-CPU dev host they reached about 3 GB (21 Node processes, 21 MB free, measured) and the run passed the 300 s harness timeout. Each wave still has 10 transactions contending on one aggregate lock; what no longer races is wave 2's `closeSubmissions` and `passJudging` (and its last four confirms) against wave 1's first five confirms and its five `updateSettings`. Retry asserted under natural contention in each test (attempts > 1, up to 5 or 6 in the emulator; each wave retried on a 2-CPU host, not asserted); the forced ABORTED of the crash row proves the retry path separately |
| **Same-key race** | 8 concurrent requests, one idem key | `version` advances by exactly 1; all 8 return the same `version`; one ledger doc | Proved (#33, `idempotency.test.ts`) |
| **Idempotent replay** | Accept, then resend after the round went stale (host passed judging); resend after `expiresAt` passed but before TTL sweep | Replay returns success with the original `version` and the current view; no write (document `updateTime`s unchanged); stale `pickWinner` with a **new** key returns `STALE` | Proved (#33, `idempotency.test.ts`), including a ledger doc with `expiresAt` in the past |
| **Crash between steps** | `faults.fire("afterWritesBuffered")` throws inside the callback; kill after commit before the handler returns; rerun the callback after a forced `ABORTED` | Throw: aggregate, views, events, outbox, ledger all unchanged (ST1). Post-commit crash: same-key retry replays. Forced abort: the committed attempt's effects appear exactly once; where an event stores a seed it is the committing attempt's | Proved (#33, `crash.test.ts`) with the harness faults: throw after buffering, crash after commit then same-key replay, ABORTED on attempt 1 (stored seed is attempt 2's), ABORTED on all 8 (`CONTENTION`, nothing committed) |
| **Draft path** | 30 `saveDraft` text edits, then one count-changing save | Text edits: aggregate `version` and every other view doc `updateTime` unchanged, `draftSeq` +1 per save, ledger row each. Count change: `version` +1, `cardsLeft` visible in all views. `finishWriting` clears draft region and drafts doc; count-only saves write an `events` doc with `events: []` | Proved (#33, `drafts.test.ts`); PJ10's `draftSeq` +1 clause against the real Store. The disabled spectator doc has no view, so a count change rightly skips it |
| **Skip-unchanged and `viewsRev`** | `castVote`, `markReminded`; then `viewsStale` fixture with an aggregate-changing command; again `viewsStale` with a text-only `saveDraft` first | `markReminded` writes aggregate, `events` doc (`events: []`), ledger, outbox only; stale `viewsRev` rewrites every view once then skips; the text-only `saveDraft` also rebuilds every view and sets `store.viewsRev` with `version` unchanged, and each rebuilt doc carries the new envelope `viewsRev` (K-F) | Partial (#33, #35, `views.test.ts`): proved are the first-command rebuild (`I6`, `I25`) and the unconditional `rebuildViews` at the unchanged version with drafts byte-equal and no events or ledger row (`I23`-`I26`); the stale patch is test-local and the named `viewsStale` fixture remains #37; `castVote` remains M7 |
| **Write budget and size** | `departed40` and `midsize10` | Writes within section 5.7 totals; `estimateBytes(aggregate)` under 600 KiB; forced oversize fixture fails with `AGGREGATE_TOO_LARGE` and leaves state unchanged, while `endGame` on it succeeds | Partial (#33, `budget.test.ts`, planner P5): a `departed40`-shaped game built in Bun, write counts equal an independent document diff (55 writes at 52 stale views); an oversize aggregate fails `AGGREGATE_TOO_LARGE` and `endGame` succeeds (5.9). `midsize10` and the 2.5 budgets are #37 |
| **createGame** | Six documents through the harness and an independent Admin diff; seven scripted codes occupied then success on the eighth; eight occupied; replay (also with a past `expiresAt`, and after a newer game re-took the code); two parallel calls with one key and with one scripted code; a rejected name and an invalid settings patch | Accepted `{gameId, roomCode, replay:false}`; exactly the six documents; LOBBY v1 with the fresh `store` map and the host seated under the derived `p_` id; host view equals `makeProjector(load())` and the spectator doc is off; ledger `expiresAt = now + 7 d`; a join on the new game is accepted. 7 collisions → attempt 8, one game and one ledger row, no code twice; 8 collisions → `resource-exhausted`/`ROOM_CODES_EXHAUSTED` and an empty diff. Replay returns the same ids with every `updateTime` unchanged, also after expiry and after the code moved to a newer game; the parallel same-key pair leaves one game and one ledger row, and the parallel same-code pair leaves two games with distinct codes, each code pointing at its own live game. `Table.lobby` games carry `events/1`, the `roomCodes` doc and the host ledger | Proved (#34, `create.test.ts`), through the Node bundle; the emulator turning a lost code race into a retry that sees the code was the Phase 0 spike, and `CodeTaken` fires on the scripted collisions |
| **join** | Rejected `NAME_TAKEN`; accepted with `extraWrites` on a `createGame`-created game (#34); replay; replay after the room code was released | Rejected: no `seats` or `joinIdem` doc. Accepted: `seats/{pid}` (with `epoch: 0`, `firstSignInAt: null`), `joinIdem/{keyHash}` (with `expiresAt`) and `views/{uid}` exist after the call; no stored doc id, field or log line contains the raw `idempotencyKey` (sentinel scan); the `idem` doc id derives from `keyHash`. Replay: `meta.playerId` echoed; `joinIdem` resolves the seat after the code is gone | Partial (#33, `join.test.ts`): a test recipe for `extraWrites`; rejection writes nothing, accept commits in one commit, replay echoes `meta`. Identity's real writes, `keyHash` and the raw-key sentinel are #42; replay after code release is #34/#42 |
| **Room-code release** | Drive a game to FINISHED; separately `endGame`; let a newer `createGame` take the released code; then `deleteGame` the finished one | `roomCodes/{code}` deleted in that same commit; `findByRoomCode` returns null for a released code and the newer `gameId` after a re-take; `load(gameId)` still works; the later `deleteGame` leaves the new game's `roomCodes/{code}` (other `gameId`) untouched | Proved (#33, #34, #36, `room-code.test.ts`): FINISHED and `endGame` delete the code and `findByRoomCode` returns null for a released code, a re-take resolves to the newer game (#34), and I30 deletes the finished game with the code owned by the newer game: 2 writes and the newer mapping survives; deleting a LOBBY game removes its code and `findByRoomCode` returns null |
| **removeCard redaction** | Remove a played card and a green card of resolved rounds; a card recycled into several rounds (all of them redacted, still within `MAX_WRITES`); attempt a hand card and a removal below R_min/G_min | Matching `rounds/{n}` text and pitch are `null`, `redacted: true`, other fields byte-equal; the refused removals write nothing | Proved (#33, `remove-card.test.ts`); the recycled card across 91 rounds within `MAX_WRITES` is proved on the planner (P5) |
| **deleteGame** | A small cascade fixture (`support/cascade.ts`: 4 seats, one resolved round, a late joiner's draft, a LOBBY leaver, a non-LOBBY departure) plus the seeded side rows; phase 0; kill after each stage at both boundaries (faults) and resume; run the runner twice; issue commands during deletion | Phase 0: `deleting`, 3 writes (2 when the code belongs to another game), the deleting marker, no events/idem/version/views change. After `done`: `games/{id}` has no documents in any subcollection, no `roomCodes`, `pushSubs` or `joinIdem` rows, no `notifLog`; the job is `done` with `expiresAt = now + 7 d`; a fake Identity received exactly the non-host uids **including a LOBBY leaver's uid (present only in `seats/*`, C-SEATS)** and the departed non-LOBBY uid, host excluded; resumption after every stage reaches the same end state and `stagesRun` excludes completed stages; a second run is a no-op; commands during deletion return `NOT_FOUND`; replaying the original `deleteGame` key, during and after the cascade, returns `rejected NOT_FOUND` (not `replay: true`); the deleted game's `hosts/*/idem` ledger is gone while `hosts/*/decks` and the other game's ledger survive; a same-key `createGame` after `done` creates a new game, not the deleted id; a stale running job emits one `deletion.stuck` line with `gameId`; 451 seeded `pushSubs` rows exercise `deleteWhere`'s second page | Proved (#36, `delete.test.ts`) on the small fixture: I28-I35, including the 451-row pagination case. `midsize10`, its stage timing and write bounds are #37; the deployed trigger and the real `purgeSeats` are #43, the `deleteGame` callable is #40 and the hourly redrive is M6. A `store.deleting` game returning `rejected NOT_FOUND` was proved in #33 (`deleting.test.ts`) |
| **Reminders** | 250 games with `reminderDueAt` in the past, 50 in the future, 50 `null` | `listWaitingOn` pages with no duplicates or gaps, ignores null and future; `markReminded` writes one `events` doc, one `Reminder` outbox row (with `round`, `waitingOn`, `roster` context) and advances `reminderDueAt`; works for WRITING, SUBMITTING and JUDGING episodes; rerun with the same key replays; a game whose `episode` changed, or whose `episodeGen` advanced (pause then unpause, same kind), returns a no-op and writes nothing; the `Reminder` row carries `episodeGen`; a late joiner writing during PLAYING appears in `waitingOn` without changing `waitingSince` | Proved (#33, #35, `reminders.test.ts`): the `markReminded` half in all three episode kinds, replay, no-op on an episode or `episodeGen` change, the late joiner; #35 adds `listWaitingOn` paging over 250 due/50 future/50 null (default 100, ties broken by document id, five full pages then an empty page at limit 50, the real game's item equal to its aggregate). The paging fixture is test-local (lean Admin-written docs plus one real game); the `viewsStale`/paging fixtures and their CI seeding are #37 |
| **Outbox** | `startGame`, a full round, a pass-judging, pause then unpause, a `markReminded` | Rows exist for each qualifying event (`WritingStarted`, `RoundOpened`, `JudgeChanged`, unpause `PausedChanged`, ...) with stable `v{n}_{i}` ids, `id` equals the doc id, `roster`, `round` and `waitingOn` match the post state (WRITING row has no `round`; SUBMITTING and JUDGING rows carry it), a `paused: true` row for the pause-on event (inert), no card text (sentinel scan, P19); `PlayerRemoved` yields an `identity` row with `notifDoneAt: null`, and the push-cleanup redrive query selects it even after `processedAt` is set; `buildOutbox` gets `cmd` and builds the `Reminder` row only for an accepted aggregate-changing `markReminded` | Proved (#33, `outbox.test.ts`, U3), including the `identityCleanup` registry query |
| **WriteSet merge** | Unit and integration: `removePlayer` of a departed viewer with a draft, so fan-out `clearDraft` and a `draftChanges` delete hit one view doc; both call orders | One write per document; `draftSeq` advanced once (not twice) in the stored doc; a same-field conflict with different values throws `INVARIANT`. Also: a writer with `draftSeq = 7` does `leave` (self-eviction, no draft read): the stored `draftSeq` becomes 8, never 1 | Proved (#33, `merge.test.ts`, U2) |
| **E8 event log** | `finishWriting`, `importDeck`, `writeIn`, plus a shuffle command | Their `events/{version}` docs contain neither `seed` nor `actorPlayerId` (assert on the raw stored doc); no stored seed reproduces any minted card id; the shuffle command's doc has both. K-A: across every stored doc (events, outbox rows, `rounds/{n}`, ledger, views of viewers other than the author) no field marks a card or submission as a write-in (no `variant` or write-in flag; `powerUsage` appears only in its owner's view and in the server-only aggregate), so a write-in card is indistinguishable from a hand card | Partial (#33, `event-log.test.ts`, U4): `finishWriting` and a shuffle command; `importDeck` is M9; `writeIn` and K-A are M7 |
| **Aggregate-only load (S4)** | Delete every subcollection of a mid-game fixture, then `load` and run `decide` | The game continues from the aggregate alone | Proved (#33, `load.test.ts`) |

In the rows above, a rebuilt view doc's `version` means the **unchanged aggregate version**, not the doc's previous value: a disabled spectator doc can legitimately sit at an older envelope version until a rebuild moves it (skip-unchanged).

### 10.4 Rules tests

`rules-test/store.rules.test.ts` implements the table of section 3.3 from `rules-test/matrix.ts`, with the R2 case-count guard; the table-vs-section-2.1 name check is `scripts/rules-coverage.test.ts` (pure, in `bun run test`). Seeding uses `withSecurityRulesDisabled`; the `enabled` flip (R4) rewrites the same spectator doc true, false, true between assertions. Proven here: the content of `firestore.rules`. Not proven: that the deployed ruleset equals it (#17 owns deploy verification), and Firestore App Check enforcement (LLD 0 post-deploy smoke).

## 11. Invariants

### 11.1 HLD S1 to S5

| # | Mechanism here | Tests |
|---|---|---|
| **S1** Single writer per game | Aggregate lock inside `runTransaction`, SDK retry on `ABORTED`, assertion `next.version === prev.version + 1`, `create()` on `events/{version}` (5.5) | Contention, same-key race |
| **S2** State, events, ledger, outbox in one transaction | One `runTransaction` per command; every write goes through `WriteSet` inside it (5.2); views, round docs, drafts and room code join the same commit (ST1, ST5) | Crash between steps; all-or-nothing assertions |
| **S3** Round history append-only | Round docs written by `create()` at `pickWinner` only; rules deny client writes; the single mutation is `redact` (6.3, ST13) | Rules rows 3, redaction test, a scan that no code path calls `set`/`update` on `rounds` except `redact` |
| **S4** Loadable from stored state alone | `GameDoc` holds all `decide` inputs except the actor's draft; no in-memory cache anywhere (stateless functions) | Aggregate-only load test |
| **S5** Persist until host deletes | No TTL on aggregate, rounds, views, events; `deleteGame` is the only deletion path and cascades (6.4, ST9, ST11) | deleteGame test; a lint-style test that TTL fields exist only on the six collection groups of 2.1 |

### 11.2 New Store invariants (ST)

| # | Invariant | Mechanism and tests |
|---|---|---|
| **ST1** | One command is one atomic commit: aggregate, drafts, round docs, events, outbox, ledger, view docs, room-code changes and Identity's `extraWrites` all commit together or not at all. | Single `runTransaction`; crash tests |
| **ST2** | The transaction callback is re-executable: it performs no external side effect and mutates no state outside `attempts` and the diagnostic `loadedVersion` (5.9: overwritten every attempt, never read by the outcome); the committing attempt's `now` (and, where stored, seed) are the recorded ones; ids come from `ctx.mintId()`. | Lint rule on `functions/src/store/` (no `fetch`, Auth, FCM, logger-with-metric, `Math.random`); forced-abort test |
| **ST3** | A given `(actor, idemKey)` is applied at most once; replay returns the original `version`, applies nothing, and survives concurrency; only accepted commands are recorded. | Ledger doc created in the commit; replay and same-key race tests |
| **ST4** | Aggregate `version` is contiguous (+1 per aggregate-changing command); exactly one `events` doc per committed version (`events` may be `[]`), so event versions equal aggregate versions with no gaps; versions never decrease. | Assertion before write; `create()`; contention test |
| **ST5** | Every committed aggregate version has all its viewers' docs written in the same commit (`viewersOf(next)` complete, PJ11/PJ12); a view doc that fails the strict schema aborts the command (PJ2). | Fan-out in `runCommand`; contention and `viewsStale` tests; `rebuildViews` writes every viewer's doc at the unchanged version (#35, `U11`-`U13`, `I23`) |
| **ST6** | Aggregate size and writes per transaction are bounded: size guard at 900 KiB (non-growing commands exempt), `MAX_WRITES = 200`, both fail without committing. | Size and budget tests |
| **ST7** | Server-only data is unreachable by clients: only rows of section 3.3 are readable, none writable, and every collection in section 2.1 has a denial test. | Rules matrix; name-coverage check |
| **ST8** | A room code maps to at most one game, and only games in LOBBY, WRITING or PLAYING hold one (released at FINISHED, ENDED, delete). | `create()` plus the in-transaction read; an `ALREADY_EXISTS` on the `roomCodes` path is the same lost race; the ledger-first 8-attempt loop replays a re-used key even when the code moved on (#34); `deleteGame` deletes the code only if `roomCodes/{code}.gameId` is this game (read in step 1); `create.test.ts` and `room-code.test.ts` I30 (#36) |
| **ST9** | Once `deleteGame` commits, no command on the game is accepted; the cascade is ordered, idempotent and resumable, and when `done` leaves nothing referencing the game (only `hosts/*/decks` and rows belonging to other games remain). | `delete.test.ts` I28-I35 (#36): fault injection at both boundaries of every stage, a second run, commands during and after; the deleted game's `hosts/*/idem` ledger is gone and a same-key `createGame` after `done` creates a new game |
| **ST10** | Outbox rows exist exactly for the qualifying events of committed commands, carry no card text, are self-contained (`roster`, `judgeId`, `paused`, `round?`, `waitingOn`), and have stable unique ids equal to the doc id; `processedAt` on `identity` rows has a single writer (LLD 4). | Outbox test; sentinel scan |
| **ST11** | Only operational scaffolding is TTL'd, exactly the six groups of section 2.1; nothing S5 protects expires. | Collection-group TTL listing test |
| **ST12** | Scheduler fields (`reminderDueAt`, `waitingOn`, `episode`, `waitingSince`) are written only as part of a `Game` returned by `decide`; the Store and the Scheduler never write them directly. | Code scan; reminder tests; Engine X8 |
| **ST13** | A round doc is created once and never changed except by `redact` in a `removeCard` transaction, which blanks card text and pitch and sets `redacted`. | Redaction test; `create()` semantics |
| **ST14** | `WriteSet` emits one write per document and its merge result is independent of call order; `draftSeq` advances once per command per view doc and never decreases: an absolute value is written only from a drafts doc read in step 1, every other clear uses `increment(1)` (5.2a, 5.6). | `WriteSet` unit tests, both orders; merge integration test |
| **ST15** | The event log cannot reveal card authorship: `EventDoc`s for `finishWriting`, `importDeck` and `writeIn` carry neither `seed` nor `actorPlayerId`, a `writeIn` doc records `commandType: "confirmSubmission"` (K-A), and minted ids are not derivable from any stored seed (E8, C-EV). | E8 event-log test |
| **ST16** | The `deleteGame` `identity` stage purges the union of `job.seatUids` and every uid in `seats/*`, so LOBBY leavers' Auth users are never orphaned. | `delete.test.ts` I32 (#36) with a LOBBY leaver and the host's own seat row |

## 12. Backup, export and cost

**Backup and export.**
- Prod: enable Firestore **point-in-time recovery** (7-day window) and a **daily scheduled backup with 14-day retention** (`gcloud firestore backups schedules create --recurrence=daily --retention=14d`). Staging: none (disposable). Backups are restores, not exports; `gcloud firestore export` to a bucket is run manually before risky migrations.
- Because S5 is about live data, a deleted game remains in backups until retention expires (at most 14 days). This is acceptable for a friends-and-family game; state it in the host-facing delete confirmation if it matters (open question 11).
- Per-game export for support is the emulator-style fixture builder run in reverse: read aggregate, rounds and events with the Admin SDK. Not a product feature.

**Cost notes** (list-price estimates, nam5; recheck against current pricing). Typical counts for a 6-player game; "listener reads" are one billed read per changed view document per connected viewer.

| Command | Reads | Writes | Notes |
|---|---|---|---|
| `confirmSubmission` | 2 | 10 | aggregate, events, ledger, 7 views (6 seats + spectator) |
| last `confirmSubmission` | 2 | 11 | plus 1 outbox row |
| `saveDraft`, text only | 3 | 3 | drafts, own view draft region, ledger |
| `saveDraft`, count change | 3 | 11 | aggregate, events (`[]`), ledger, drafts, 7 views (the actor's draft region merges into its view doc) |
| `finishWriting` | 3 | 11 | draft delete, aggregate, events, ledger, 7 views |
| `pickWinner` | 2 | 13 | aggregate, events, round, ledger, 2 outbox, 7 views |
| `markReminded` | 2 | 4 | aggregate, events (`[]`), ledger, outbox; views skipped |
| `createGame` | 2 | 6 | game, events, 2 views (host, spectator), `roomCodes`, ledger |
| ledger hit (replay) | 2 | 0 | |
| `deleteGame` phase 0, then cascade | 2 | 3 (aggregate update, room-code delete, `deletions` job), then about 1,100 deletes | 7 views, 25 rounds, about 500 events, about 500 ledger rows (expired ones already TTL'd) |

A typical 600-command game costs about 6,000 writes, about 1,200 command reads, about 4,000 listener reads, and about 1,100 deletes at the end: on the order of one to two US cents, plus under 1 MB of storage. At 100 concurrent games the daily cost is dominated by the hourly sweep's index scan, which is negligible. Skip-unchanged (LLD 2 8.2) is the only fan-out reduction relied on.

## Open questions / conflicts

1. **Additions to tech-stack section 5's collection list. Resolved (issue #32).** tech-stack section 5 now lists the section 2.1 set path for path, its stale TTL sentence is gone, and `roomCodes` is noted as released at FINISHED/ENDED/delete; `scripts/rules-coverage.test.ts` (C3) fails if the two lists differ again. The original note: New: `deletions/{gameId}`, `joinIdem/{keyHash}` (K-C, sixth TTL group), `hosts/{hostUid}/idem/{hash}`, `games/{id}/seats/{playerId}`, `games/{id}/notifLog/*`; `views/{uid}` and `rounds/{n}` now follow LLD 2's envelopes; `roomCodes` is released at FINISHED/ENDED, not only at delete; the host reads their own `hosts/*/decks` through rules (the tech-stack says only "written only by functions"). Needs a tech-stack edit.
2. **tech-stack section 6 asks for a composite index on `(phase, paused, reminderDueAt)`.** It is unnecessary: `reminderDueAt` is non-null only when an episode exists, i.e. WRITING or PLAYING and not paused (LLD 1 4.2, C-WRITING), so the automatic single-field index answers the query exactly (section 7). Also the sweep calls `markReminded` through the command pipeline.
3. **HLD T1 versus reminder maintenance.** HLD T1 says the Scheduler is read-only with respect to game state; the reminder clock must advance somewhere. Resolved here as LLD 1's `markReminded` system command through `runCommand`. T1 should be reworded to "no game logic, and writes only through `markReminded`". Needs HLD and LLD 6 sign-off.
4. **HLD 3.5 interface (`load`, `commit(expectedVersion...)`, `listWaitingOn(olderThan)`).** Replaced by `runCommand`, `createGame`, `findByRoomCode`, `listWaitingOn(page)`, `listGamesByHost`, `rebuildViews`; a transaction cannot span a separate `load` and `commit`. S1's "compare-and-set on version" is realized by the Admin SDK's pessimistic locking plus an explicit version assertion (5.5). A host's game list (`where hostId == uid orderBy createdAt desc`, index in section 4) is added because HLD section 5 has no way for a returning host to find their games; LLD 5 must expose it.
5. **Reminder as an outbox row.** **Resolved by LLD 6** (outbox row accepted; the sweep only calls `markReminded`). LLD 1 says `markReminded` emits no domain event; this LLD writes a `Reminder` outbox row in the same transaction (section 7), built by `buildOutbox(prev, next, cmd, a, now)`, so the advance and the send intent are atomic.
6. **TTL configuration. Resolved (issue #15, decision #5).** The six groups (`joinIdem` added by K-C) are listed once, in section 2.1, and LLD 0 configures all of them. This LLD's `firestore.indexes.json` `fieldOverrides` (section 4) is what enables them: the pinned `firebase-tools` 15.37.0 accepts `"ttl": true`, `firebase deploy --only firestore` applies it, and the #15 mutation check (disable a group with `gcloud`, redeploy the file, watch it return) shows the file, not a console or `gcloud` step, is authoritative. The `gcloud` fallback is deleted. The composite indexes and the remaining field exemptions followed in #32 (section 4).
7. **`viewsRev` placement.** Resolved: it is `store.viewsRev` inside the `store` map so the Engine's top-level namespace stays clean. LLD 2 uses the same name `store.viewsRev`; its older phrasing "next to the Game fields" is superseded (this LLD, section 2.2, is authoritative).
8. **Engine caps needed to bound the aggregate.** **Resolved by LLD 1 (C-CAPS):** `MAX_TOTAL_JOINS = 50` (monotonic `totalJoins`, `join` rejects `ROOM_FULL` detail `join_cap`) and `MAX_VOTES = 1500` (`castVote` rejects `VARIANT_UNAVAILABLE` detail `vote_cap`), both exported from `packages/contracts`. Section 2.5's adversarial bound assumes both; the Store's size guard remains the backstop and fails closed for growing commands.
9. **Event ids have gaps.** **Resolved (LLD 1 4.1 and section 9 here): no gaps.** Every accepted command that changes the aggregate, including `markReminded` and count-only `saveDraft`, writes exactly one `events/{version}` doc (`events: []` when it emitted nothing), so event versions are contiguous with aggregate `version`. Commands that change nothing (text-only `saveDraft`, no-op `markReminded`) write no event doc and no version.
10. **Idempotent replay returns the current view.** The ledger stores the original `version` but not the original view (up to 64 KiB, stale by definition). On replay `result.version` can be below `result.view.version`; LLD 5 must document it and LLD 7 must order by `view.version` (LLD 2 8.4 already says so).
11. **Backups outlive `deleteGame`.** S5 says deletion removes everything; scheduled backups and PITR keep deleted games for up to 14 days. Accepted; decide whether the delete UI says so.
12. **`createGame` inputs.** LLD 1 15 asks LLD 3 to confirm that the app supplies `gameId`, `roomCode`, `hostPlayerId`: confirmed (sections 6.1). The ledger for it is `hosts/{hostUid}/idem`, so LLD 5 must pass `hostId` (from the authenticated host principal) and a client `idemKey` for `createGame` too.
13. **World-readable rounds with spectators disabled.** Decision recorded in 3.2 (accept). HLD F4 and the tech-stack sentence about rounds are relaxed accordingly; the tightening is one rule line.
14. **Draft region plus `draftSeq` is Store-owned.** Implemented as LLD 2 8.4 specifies. If LLD 5 prefers a `getDraft` callable instead, delete the draft-region merges and keep `drafts/{pid}` as is.
15. **Pessimistic locking and throughput.** Admin SDK transactions lock the aggregate for the whole callback (tens of ms). With at most 10 actors per game that is fine; if `command` ever grows heavier (large `decide` or fan-out), the lock hold time grows with it. The 5 ms fan-out budget in LLD 2 10 is the relevant control.
16. **`removeCard` reach.** Resolved (user decision U3, LLD 1 and 2): only cards shown to the table can be removed, and removal below R_min/G_min is refused (`endGame` is the escape hatch). Redaction (6.3) assumes the removal already succeeded in the Engine; its write bound is the rounds played, not 2 (5.7).
17. **Event log and E8 (C-EV).** `seed` and `actorPlayerId` are omitted from `EventDoc` for `finishWriting`, `importDeck` and `writeIn`; card ids come from `ctx.mintId()` (CSPRNG). `Deps` gains `mintId`. LLD 1 must pass `mintId` in `ctx` and reword "reproduces every shuffle, card id" to shuffle order only.
18. **LOBBY leavers and orphan Auth users (C-SEATS).** Resolved here for the cascade: the `identity` stage purges `job.seatUids` union `seats/*` (6.4). The pre-cascade window (a custom token minted at join and redeemed after removal) is LLD 4's.
19. **Outbox context and consumers (C-OUTBOX, C-IDHANDOFF, C-WRITING).** `OutboxRow` now carries `id`, `round`, `waitingOn` and LLD 6's bookkeeping fields; `buildOutbox` takes `cmd`. LLD 6 must read those instead of a live `games/{g}` read in `planVersion`; LLD 4 owns `processedAt` on `identity` rows, LLD 6 uses `notifDoneAt` there.
20. **`deleteGame` replay.** Corrected: a replay returns `rejected NOT_FOUND`, never `replay: true` (6.4). LLD 5 must state that `NOT_FOUND` on `deleteGame` is success.
21. **Round-2 review fixes (K-B, K-C, K-E, K-F, R2, R4). RESOLVED (final cross-file sweep).** Decided here: `deleteGame` releases the room code only while `roomCodes/{code}.gameId` is this game (6.4); self-evicting `leave` and `removePlayer` clear `draftSeq` by `increment(1)` instead of reading the evicted draft (chosen over an extra step-1 read; 5.2a, 5.6); views are rebuilt whenever `store.viewsRev` is behind, also for `aggregateChanged: false` user commands, except a no-op system `markReminded`, which stays zero-write (LLD 2 8.2 now says the same); the view envelope carries the single field `viewsRev` (LLD 2 renamed `rev`; `VIEW_FIELDS` and LLD 5's `ViewDoc` have no `rev`); `joinIdem/{keyHash}` is the sixth TTL group and is also purged by the cascade; `seats` gains `firstSignInAt` and uses `epoch` as the `ep` claim. Confirmed across files: `markReminded{episode, episodeGen}` with the Engine comparing both (LLD 1 7.4), the sweep passing both and `planReminder` comparing `episodeGen` (LLD 6); the ledger key `remind:{episode}:{dueAt}` is unchanged.

## Interfaces to other LLDs

| LLD | This LLD provides | This LLD expects |
|---|---|---|
| 0 Platform | `firestore.rules`, `firestore.indexes.json` (indexes, exemptions, TTL), `rules-test/` matrix, Store integration suites for `bun run test:integration`, log events `command.done`/`command.rejected`/`txn.retry` with `attempts` and `latencyMs`, `deletion.stuck`, `store.size.warn` | Emulator harness against the Node bundle (P9); `fn-runtime` Firestore role; TTL policies for exactly the six collection groups of 2.1 (incl. `joinIdem`); deploy order rules, then indexes, then functions (P16); P10 name-coverage check: built in #32 (`scripts/rules-coverage.test.ts` plus the matrix case-count guard, 3.3); emulator-only gating of the `storeHarness` knobs: `faults`, `now` and `seeds` arrive per request on that callable, gated on `FUNCTIONS_EMULATOR` (5.9, 10.1, LLD 0 P9); the env-var clock is the real callables' (#40-#43) |
| 1 Engine | The only caller of `decide`; passes `expectedVersion` untouched; supplies `ctx` (`now`, `makeRng(seed)`, `actor`, `drafts` limited to the actor's); persists `state`, `events`, `draftChanges`, `roundRecords`, `seed` (stored only for non-minting commands); supplies `ctx.mintId`; handles `deleteGame` (6.4) and `aggregateChanged: false` (5.6); adopts `markReminded` (7) | Everything in LLD 1 section 10 and Interfaces table; adopted additions: total-joins and vote caps (open question 8); event-doc-per-version rule (section 9); keep `Game` plain JSON (X2); `markReminded` kept; scheduler fields maintained in `settle` (X8) |
| 2 Projector | Calls `fanOut(prev, next, {now, storedRev})`, strict-parses every `ViewDoc` (PJ2), writes with `mergeFields` lists of 8.4, maintains `draftSeq` and `viewsRev` (store field and view-envelope field; views rebuilt whenever the stored `viewsRev` is behind, even for `aggregateChanged: false`, K-F), tombstones and `clearDraft`, creates `rounds/{n}` from `toRoundDoc`, redacts round docs on `removeCard` (`redacted`), rules per 11.8 there | `fanOut` (which already strict-parses and size-caps every doc, LLD 2 PJ2), `viewersOf`, `viewerFor`, `makeProjector`, `toRoundDoc`, `draftRegion`, `VIEW_REGION_FIELDS`, `DRAFT_REGION_FIELDS` (the `mergeFields` lists, to import rather than redeclare), `PROJECTOR_REV`, `ViewDocSchema`, `RoundDocSchema` (strict); the `redacted` field on `RoundDoc` |
| 4 Identity | `findByRoomCode` (one `get`, `{gameId, createdAt}`, no time window — Identity applies the 72 h rule to `createdAt`); `runCommand` with `meta` and pure `extraWrites` so the seat record commits atomically with `join`; `topic: "identity"` outbox rows for `PlayerLeft`/`PlayerRemoved`; `deletions` job, `seatUids` and the `seats/*` union for `purgeSeats`; the `games/{g}/seats/*` reservation | Mint `playerId`, secret and hash deterministically from `(gameId, idemKey)` before the call; mint custom tokens only after commit; implement `purgeSeats(gameId, uids)` (idempotent, tolerates missing users, revokes refresh tokens); own `seats` fields (`uid`, `secretHash` nullable, `epoch` (mirrored as the `ep` claim, K-B), `notBefore` (strict `auth_time > notBefore`), `firstSignInAt`, `revokedAt`); hash the join key (`keyHash`) before calling `runCommand` and write `joinIdem/{keyHash}` in `extraWrites` (K-C); export `handleIdentityRow`, be the only writer of `processedAt` on `identity` rows and `hosts/{uid}`; confirm the host's Auth account is never deleted by the cascade |
| 5 Command API & contracts | `CommandOutcome` and `StoreError` kinds (5.1, 5.8), the replay semantics (5.4), `createGame` and `listGamesByHost`, `rebuildViews` (LLD 5 2.6's breaking-view repair path), the error mapping table | Pass `gameId`, `actor`, `idemKey` (and `hostId` for `createGame`); never interpret `expectedVersion`; map `StoreError` to `HttpsError` codes in 5.8; expose the host game list; document that on replay `result.version <= result.view.version` |
| 6 Notifications & Scheduler | Outbox rows (`topic: "notify"`, `Reminder`), self-contained `roster`, `round`, `waitingOn`, `id`, stable `v{n}_{i}` ids, 14-day retention, `listWaitingOn` pages, `markReminded` path, the redrive indexes (incl. the `identity`/`notifDoneAt == null` push-cleanup redrive, section 8), `deletions` stuck-job sweep hook; `episodeGen` in `listWaitingOn` items and `Reminder` rows (K-E); the built `WaitingGame` item is exactly `{gameId, episode, episodeGen, waitingOn, since, dueAt, version}` and the cursor is `{dueAt, gameId}` (as built #35); `WritingStarted`, `JudgeChanged`, `GameEnded` and unpause rows with context; `notifDoneAt: null` on every identity row at creation | Triggers on `outbox`, filtering by `topic`; set `processedAt` on `notify` rows only (own fields `notifAttempts`, `poisonedAt`, `notifSkipped`, `notifDoneAt`); drop live reads in favor of the row context; `clearSeatPush` for `identity` rows; own `notifLog` (TTL 30 days) and `pushSubs` (with `gameId`, `uid`); loop `listWaitingOn` pages and call `runCommand(markReminded)` with key `remind:{episode}:{dueAt}`; accept or veto the reminder-as-outbox-row design (open question 5); decide the sweep cadence |
| 7 Web Client | The readable documents and who may read them (3.1, 3.3): `views/{ownUid}`, `views/spectator`, `rounds` ordered by `round`; `permission-denied` on the spectator doc means unavailable; a missing own view doc after deletion means the game is gone | Single-document listeners only (no `list` on views); App Check initialized before listeners (LLD 0 open question 4); order view region by `(version, viewsRev)` lexicographically (K-F) and draft region by `draftSeq`; serialize `saveDraft` calls; treat `NOT_FOUND` on `deleteGame` as success |
