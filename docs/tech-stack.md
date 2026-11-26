# Deep Cuts: Technology Stack

Status: draft v0.2 (amended after LLD review). Maps the components in [high-level-design.md](./high-level-design.md) onto Firebase and picks the supporting tools. The HLD stays technology-neutral; this document is where Firebase-specific decisions live.

## 1. Summary

| Layer | Choice |
|---|---|
| Language | TypeScript everywhere. Cloud Functions run on **Node 22**; Bun is a dev-time tool only |
| Client | React + Vite + TypeScript, installable PWA (`vite-plugin-pwa`), Tailwind CSS |
| Hosting | Firebase Hosting (SPA, preview channels per PR) |
| API | Cloud Functions for Firebase (2nd gen), callable functions behind one `defineCallable` wrapper (LLD 5) |
| Database | Cloud Firestore (Native mode) |
| Auth | Firebase Authentication (upgraded to Identity Platform, LLD 4 section 13): email-link for hosts; custom tokens for player seats; anonymous for spectators |
| Realtime | Firestore `onSnapshot` on per-viewer view documents |
| Push | Firebase Cloud Messaging (Web Push) |
| Scheduling | Cloud Scheduler via scheduled Cloud Functions |
| Abuse protection | Firebase App Check + Firestore-backed counters; `beforeEmailSent` for host sign-in emails |
| Repo | **Bun** workspace monorepo (package manager, scripts and unit-test runner) |
| Tests | `bun test`, fast-check, Firebase Emulator Suite, Playwright |
| CI/CD | GitHub Actions deploying to Firebase |

Firebase plan: **Blaze** (pay as you go) is required for Cloud Functions. At this game's scale (many small games, a handful of commands per player per day) expect costs near zero; set a budget alert anyway.

## 2. The central decision: how Firestore meets the anonymity requirement

Firestore security rules grant or deny whole documents; they cannot hide individual fields. Hands, submission owners and card authorship are exactly the secrets the HLD protects (V2 to V5, E8, E9). So:

1. **The game aggregate is never readable by clients.** `games/{gameId}` and its private subcollections deny all client reads and writes. Only Cloud Functions (Admin SDK) touch them.
2. **Clients read only projected documents.** On every accepted command, the same transaction that commits the new state also writes one **view document per viewer**, produced by the View Projector (V1). A client sees exactly the document the Projector made for them.
3. **Clients never write Firestore directly.** Every mutation is a callable function, so the Engine, Moderation and idempotency can't be bypassed.

Consequence for the HLD: the **Change Feed component dissolves into Firestore listeners.** A client's `onSnapshot` on its own view document is both the query and the realtime channel. This deliberately revises invariant F1 ("the feed carries no data"): the feed channel now does carry data, but only a document the Projector already redacted for that exact viewer, protected by a rule that checks `request.auth.uid`. F4 is revised too (spectator and round-doc reads are capability-by-game-id) and C2 now reads "listens to its view doc and the rounds collection". F2/F3 (lossy, not required for correctness) still hold: a missed snapshot is fixed by the next one, and `version` lets clients discard stale ones. The full supersession list is LLD 2 section 9. If we ever leave Firestore, the HLD's hint-only feed returns.

## 3. Component mapping

| HLD component | Firebase realization |
|---|---|
| Web Client (PWA) | React app on Firebase Hosting. A single service worker, `/sw.js` (`vite-plugin-pwa` `injectManifest`), handles the offline shell and FCM background messages; there is no separate `/firebase-messaging-sw.js`. |
| API Layer | One `command(envelope)` callable plus `createGame`, `deleteGame`, `joinGame`, `lobbyInfo`, `rejoin`, `spectate`, `registerPush`, `unregisterPush`, `reissueRejoinLink`, `signOutEverywhere`, `listGamesByHost` and `hostProfile` (LLD 5 section 3), all defined through `defineCallable` (`functions/src/api/callable.ts`). App Check is enforced by the framework and the wrapper resolves the Firebase Auth token to a `Principal` before our handler runs, giving us A1. |
| Identity & Sessions | Firebase Auth. See section 4. The `identityOutbox` trigger revokes departed seats; `beforeEmailSent` is the optional email guard. |
| Game Engine | Pure TypeScript package (`packages/engine`), imported by the `command` function. No Firebase imports. |
| Game Store | Firestore transactions via the Admin SDK (`runCommand`). See section 5. The `deleteGame` cascade runs in the `deletionRunner` trigger. |
| View Projector | Pure TypeScript package (`packages/engine`, `project`), invoked inside the command transaction. |
| Change Feed | Firestore snapshot listeners on view docs (section 2). |
| Notification Service | `notifyOutbox`, a Firestore-triggered function on the outbox collection, sending through FCM Admin. |
| Scheduler | `reminderSweep`, an `onSchedule` function (Cloud Scheduler), hourly; `housekeeping` redrives stuck outbox rows and deletions. |
| Moderation | In-process wordlist library inside the Engine's validation step; no outbound calls (M4). |
| Deck Library | Firestore `hosts/{hostUid}/decks/{deckId}`, written only by functions. |

## 4. Identity design on Firebase

Every principal is a Firebase Auth user, so Firestore rules and callables share one identity.

| Principal | Firebase mechanism | Notes |
|---|---|---|
| **Host** | Email-link (passwordless) sign-in | Firebase sends the link itself, so **no email provider is needed in v1** (N5). Optionally brand the sender domain later. The Auth `uid` is the `hostId`. |
| **Player seat** | **Custom token**, `uid = seat:{gameId}:{playerId}` | `joinGame` mints it. The player's **rejoin link** carries a long-lived secret in the URL fragment (`/g/{gameId}#k=...`, so it never reaches server logs). A new device calls `rejoin(secret)`, which verifies the hash and mints a fresh custom token for the same uid. Seat custom tokens carry one developer claim, `ep` (seat epoch); there are no other custom claims. |
| **Host's own seat** | The host's email-link `uid` | The host plays too (Q1), so their player record stores `uid = hostUid`. Commands resolve `request.auth.uid` to a playerId through the game's player list, so host powers and the host's seat share one identity. |
| **Spectator** | Anonymous Auth | Their `uid` only dedupes People's Choice votes. |

Mapping to HLD invariants:
- I1: a seat's uid embeds `(gameId, playerId)`, and `command` rejects any uid not in that game's player list.
- I2/Q3: the stored secret is a hash; the host can **reissue** a player's link, which replaces the hash and increments the seat's `epoch`, so it kills the old link and every custom token minted before the reissue (`assertSeatLive` refuses an `ep` claim that is not the current epoch, LLD 4). Removing a player disables and tombstones the seat's Auth user and revokes its refresh tokens; the Auth user is deleted at the `deleteGame` cascade (a deleted user could be silently recreated by a still-valid custom token).
- I3: Firebase single-use email links.
- I4: display-name uniqueness is enforced by the Engine on `join`.

**Room codes and links.** The shareable link uses the Firestore auto-ID of the game (20 random characters, unguessable). The 4-letter code lives in `roomCodes/{code} -> gameId`, readable only through `lobbyInfo` / `joinGame` callables so it can be rate-limited (R2).

**Required setup notes:** minting custom tokens needs the Functions service account to hold the `iam.serviceAccountTokenCreator` role. Anonymous-account cleanup and App Check enforcement on the Auth endpoints need the project upgraded to Identity Platform (LLD 4 section 13; also the prerequisite for `beforeEmailSent`).

## 5. Firestore data model

```
games/{gameId}                      // Game aggregate plus a server-only `store` map (viewsRev, deleting). ALL client access denied
games/{gameId}/drafts/{playerId}    // private drafts; the ONLY place authorship exists (E8). Denied to clients.
games/{gameId}/rounds/{n}           // resolved RoundDocs, append-only (S3) except `removeCard` redaction. Written only at resolution. Read: any signed-in user
games/{gameId}/views/{uid}          // `ViewDoc` envelope {schema, viewsRev, enabled, version, view, draftSeq, draft}: a view region and the player's own draft region. Read: auth.uid == {uid} (seat uids also need token `ep` == the seat's `epoch`)
games/{gameId}/views/spectator      // projected spectator view. Read: any signed-in user, if `enabled`
games/{gameId}/events/{version}     // domain event log, one doc per version, no gaps (ids and kinds only; seed and actor omitted for card-minting commands)
games/{gameId}/outbox/{rowId}       // transactional outbox, id `v{version}_{i}`; triggers Notifications and Identity. Denied to clients.
games/{gameId}/idem/{hash}          // idempotency ledger (E4)
games/{gameId}/seats/{playerId}     // rejoin-secret hash, epoch, notBefore, revokedAt, firstSignInAt (LLD 4). Denied to clients.
games/{gameId}/notifLog/{rowId}_{uid}   // notification dedupe record (N1). Denied to clients.
roomCodes/{code}                    // -> gameId; released at FINISHED/ENDED/delete. Denied to clients.
joinIdem/{keyHash}                  // join replay index, keyHash = sha256(idempotencyKey) -> {gameId, playerId, uid, createdAt, expiresAt}; lets a same-key retry recover a seat after the code expired (LLD 4). Denied to clients.
deletions/{gameId}                  // deleteGame cascade job. Denied to clients.
hosts/{hostUid}                     // host profile
hosts/{hostUid}/decks/{deckId}      // saved decks (D1, D2); read by that host only, written only by functions
hosts/{hostUid}/idem/{hash}         // createGame ledger. Denied to clients.
pushSubs/{uid}_{gameId}             // FCM tokens for a seat: a `devices` map of up to 5. Denied to clients; written by callable.
rateLimits/{kind}_{key}             // abuse counters. Denied to clients.
```

**TTL** (Firestore TTL policies on field `expiresAt`, exactly six collection groups; LLD 3 section 2.1): `idem` (both `games/*/idem`, 7 days, and `hosts/*/idem`), `outbox` (14 days), `notifLog` (30 days), `rateLimits` (two windows), `deletions` (7 days after `done`) and `joinIdem` (7 days). Nothing that defines a game expires (S5). The pinned firebase-tools applies them from `fieldOverrides` in `firestore.indexes.json` (proven in #15). `roomCodes` does not expire: a code is released when its game reaches FINISHED or ENDED, or is deleted (LLD 3 sections 2.1 and 6.4).

The list above is the LLD 3 section 2.1 collection map, path for path (`scripts/rules-coverage.test.ts` fails if they differ, and if the rules denial matrix misses one; #32).

**Why this shape**
- *Rounds are world-readable to any signed-in user who knows the game id.* Only resolved rounds are ever written there, and players and spectators see the same resolved history (V5, V7), so correctness holds by construction. Unguessable game ids give the same "anyone with the link" access the gameplay doc specifies for spectators and finished games (Q10).
- *History lives in a subcollection*, not the aggregate, to stay far under Firestore's 1 MiB document limit however long a game runs.
- *Aggregate stays in one document* so a command is one read plus one write for state.

**Commands as transactions (S1/S2).** `command` runs `db.runTransaction`:
1. Read `games/{id}` and the idempotency doc.
2. If the key exists, return the stored result (E4).
3. Run `decide(state, cmd, {now, rng})`.
4. In the same transaction, write: new state with `version + 1`, any `rounds/{n}`, `events/{v}`, `outbox/*`, the idempotency doc, and **every affected `views/*` doc** (all players, the spectator doc, an unseated host, and tombstones for departed players).

Firestore retries a transaction on contention, which gives per-game serialization without a lock service. A game's write rate is far below the ~1 write/second/document guideline, and a command stays well under the 500-write transaction limit (about 74 writes worst case; a `removeCard` that redacts many round docs about 146; the Store enforces 200, LLD 3 section 5.7).

`rng` for shuffles comes from a per-command seed stored in the event, so shuffle order is reproducible for debugging. For commands that mint card ids (`finishWriting`, `importDeck`, `writeIn`) neither seed nor actor is stored, and card ids come from a CSPRNG `mintId` port, so no event can be combined with the final state to recover authorship (E8).

**Rules, in outline**
```
// signedIn() is request.auth != null
match /games/{gameId} {
  allow read, write: if false;                                  // aggregate, drafts, events, outbox, idem, seats, notifLog
  match /rounds/{n}      { allow get, list: if signedIn(); allow write: if false; }
  match /views/{uid}     { allow get: if signedIn() && request.auth.uid == uid && uid != 'spectator'
                           && (!uid.matches('^seat:.*') || request.auth.token.ep == get(.../seats/$(playerIdOf(uid))).data.epoch);   // seat epoch claim (K-B)
                           allow list, write: if false; }
  match /views/spectator { allow get: if signedIn() && resource.data.enabled == true; allow list, write: if false; }
}
match /hosts/{hostUid} {
  allow read, write: if false;                                  // profile and the createGame ledger
  match /decks/{deckId}  { allow get, list: if signedIn() && request.auth.uid == hostUid; allow write: if false; }
}
match /{document=**} { allow read, write: if false; }           // roomCodes, joinIdem, pushSubs, rateLimits, deletions, anything unlisted
```
(Final rules text: LLD 3 section 3.1. The only `get()` is the seat-epoch check on seat view reads, one extra document read per seat read or listener attach.)
Rules are covered by `@firebase/rules-unit-testing` tests (the LLD 3 section 3.3 denial matrix) that attempt every forbidden read (another player's view, the aggregate, drafts, seats, outbox) and expect denial.

## 6. Notifications and scheduling

- **Push:** FCM web push via the Firebase JS SDK and the single `/sw.js` service worker. A client registers its token through a callable (`registerPush`), which stores it in `pushSubs/{uid}_{gameId}` (a `devices` map, up to 5 tokens). Notifications cover the WRITING phase as well as turns and judging (U1; LLD 6 section 3.2), round results, and game end: a finished game and a host-ended game (`GameEnded`, kind `game_ended`, "The host ended the game.") notify every seated player, including late joiners still writing.
- **Outbox to FCM:** `notifyOutbox`, triggered by `onDocumentCreated('games/{gameId}/outbox/{rowId}')`, fans out per the HLD trigger table. Triggers are at-least-once, so the function creates a `notifLog/{rowId}_{uid}` doc before sending (N1). Payloads are ids and generic copy only (N2).
- **Failure isolation (N4):** this function runs outside the command transaction; a push failure can never fail a command. Tokens that return `registration-token-not-registered` (or an equivalent unregistered-token error) are removed; `invalid-argument` never prunes a token, it is counted and alerted on (LLD 6 section 4.4).
- **Daily reminders:** the hourly `reminderSweep` queries games with `reminderDueAt <= now` (a denormalized top-level field the Engine maintains on the aggregate; automatic single-field index, no composite index and no `phase`/`paused` filters, because the field is non-null only while the game is waiting on someone and unpaused). For each due game it calls the Engine's `markReminded` system command through `runCommand`, which advances `reminderDueAt` and writes a `Reminder` outbox row in one transaction; the row is delivered like any other notification. Reminders cover every phase in which the game waits on someone: WRITING, SUBMITTING and JUDGING. A replayed idempotency key writes nothing, which makes the sweep idempotent (T2).
- **iOS:** web push requires iOS 16.4+ and the PWA installed to the home screen. The client onboarding must prompt for install (R3).

## 7. Abuse protection (A4, R2)

Firebase has no built-in rate limiter, so:
- **App Check** (reCAPTCHA Enterprise on web) on all callables to keep out scripted traffic that isn't our app.
- **Counters in Firestore** (`rateLimits/{kind}_{key}` with a window and count, written inside the callable) for `lobbyInfo`/`joinGame` per room code and per IP hash, and for the other callables per uid (bucket table: LLD 5 section 7.3). Lockout on repeated failures.
- Host sign-in emails are sent by the client SDK straight to Firebase Auth, so no callable of ours sees them. A per-email counter therefore exists only inside the optional `beforeEmailSent` blocking function (needs Identity Platform and SDK support, to verify at scaffold time); otherwise Firebase Auth's own throttling and App Check on the Auth endpoints are the control (LLD 5 section 8.1).

## 8. Repository and tooling

```
dc/
  apps/web/            React PWA
  functions/           Cloud Functions entry points (thin: `defineCallable` wrapper, rate limit, transaction, call engine); `exports.json` lists every deployed function
  packages/engine/     pure domain core + Projector + Moderation (no I/O, no Firebase imports)
  packages/contracts/  command/view/error types and zod schemas shared by web and functions
  firebase.json, firestore.rules, firestore.indexes.json
  docs/
```

- **Package manager and scripts:** Bun workspaces (`workspaces` in the root `package.json`, internal deps as `workspace:*`, one `bun.lock`). **Build:** Vite for web (runs fine under Bun); `bun build --target=node` for functions.
- **Bun is a dev tool, not a runtime.** Cloud Functions for Firebase run Node, not Bun. So `packages/engine`, `packages/contracts` and `functions/` must use only standard Web/Node APIs; no `Bun.*` globals or `bun:*` imports in anything that ships to Functions (lint-enforced; `bun:test` is allowed in test files only).
- **Deploying functions from a workspace.** The Firebase CLI uploads the functions directory and installs its dependencies in the cloud, which can't resolve `workspace:*` packages and doesn't read `bun.lock`. So the functions build script bundles `functions/`, `engine` and `contracts` into one Node-target file in `functions/dist`, and generates a minimal `package.json` there that lists only the external runtime deps (`firebase-admin`, `firebase-functions`) at pinned versions. `firebase.json` points `source` at that directory.
- **Contracts:** zod schemas in `packages/contracts` generate the types for the command envelope, `GameView` and error codes, so the client and server can't drift. Every callable goes through `defineCallable` (the only module that imports `onCall`); the web client is one bundle with a single `/sw.js` worker.
- **Engine isolation rule:** `packages/engine` may not import `firebase-*`, `node:*` I/O or read the clock; a lint rule enforces this (T3, section 3.4 of the HLD).

**Testing**
| Level | Tool | Covers |
|---|---|---|
| Engine unit and property | `bun test`, fast-check | Every rule in gameplay.md; E1 to E18; V2 to V5 over random games and every viewer role |
| Security rules | Firebase Emulator + `@firebase/rules-unit-testing` | Section 5 denials |
| Function integration | Emulator Suite (Firestore, Auth, Functions) | Transactions, idempotency, outbox, custom-token rejoin |
| Web unit | `bun test` with happy-dom (separate process from engine/functions tests) | Client components and stores |
| End to end | Playwright against emulators | Join, write, play a round, return after reload |

**Environments:** local Emulator Suite for development; two Firebase projects, `deepcuts-staging` and `deepcuts-prod`. Hosting preview channels for each PR.

**CI/CD:** GitHub Actions on every PR installs Bun (`oven-sh/setup-bun`), then runs lint, typecheck, `bun test`, and the emulator suites, then deploys a Hosting preview channel. Merge to `main` deploys staging; a tagged release deploys production.

## 9. Observability

Cloud Logging with structured logs keyed by `gameId` and `version`; no card text, display names, tokens or emails in logs (HLD section 4.5). Cloud Error Reporting for function failures. A log-based metric for transaction retry rate and a dashboard for command latency by rejection reason. Budget alerts on the Blaze plan.

## 10. Risks and trade-offs

| Risk | Notes and mitigation |
|---|---|
| **Per-viewer view fan-out write cost** | Up to ~11 view writes per command. At this scale it's negligible, and it buys simple rules and free realtime. Skip unchanged views if it ever matters. |
| **Cold starts on `command`** | First tap after idle can take 1 to 2 s. Acceptable for async play; set `minInstances: 1` on `command` only if it feels bad (small fixed cost). |
| **Rules cannot redact fields** | The design never relies on them to: secrets live only in documents clients can't read, and projected docs are the only readable game state. Rules tests guard this. |
| **No built-in rate limiting** | Section 7. Revisit if abuse appears. |
| **Bun-built functions deployed to a Node runtime** | Bun's resolver and lockfile aren't understood by Firebase's cloud build. Mitigated by bundling and a generated `package.json` (section 8), a Node-API-only lint rule, and running the emulator integration tests against the Node bundle in CI, not just `bun test`. |
| **Vendor lock-in** | The Engine, Projector and contracts have no Firebase dependency; only `functions/` and the Hosting/Auth/FCM glue would be rewritten. |
| **Custom-token IAM and Auth user growth** | One Auth user per seat; disabled (or tombstoned) at removal and deleted by the `deleteGame` cascade (S5), including users of players who left the lobby. Up to 50 dormant users per game until deletion. |
| **Email deliverability of Firebase's sign-in links** | Default sender can land in spam. Mitigate with a custom domain and sender in Firebase Auth templates before launch. |
| **Firestore index/limit surprises** | Aggregate stays below 1 MiB (history is in subcollection; joins and votes are capped); the reminder query uses only the automatic single-field index. |

## 11. Decisions

Confirmed in PR review:

- **Bun workspace monorepo** (instead of pnpm), with the Node-runtime and bundling constraints in section 8.
- **React + Vite + Tailwind** for the client.
- **Firestore** over Realtime Database.
- **Callable functions** over a custom REST API.
- **Firebase's built-in email-link sign-in** instead of a separate email provider.
- **Firestore region `nam5`** (US multi-region). This can't be changed after project creation.
- **Two Firebase projects**, staging and prod.

## 12. Next steps

1. Create the Firebase projects, enable Auth providers (email link, anonymous) and upgrade to Identity Platform, then enable Firestore, Functions, Hosting, App Check and the FCM APIs, and configure the six TTL groups (LLD 0).
2. Scaffold the Bun monorepo and CI, including the functions bundling step, and verify a deploy to staging early since it is the riskiest tooling seam.
3. Build `packages/engine` with its property tests first, as in the HLD build order, before touching Firebase.
