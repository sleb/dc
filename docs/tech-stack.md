# Deep Cuts: Technology Stack

Status: draft v0.1. Maps the components in [high-level-design.md](./high-level-design.md) onto Firebase and picks the supporting tools. The HLD stays technology-neutral; this document is where Firebase-specific decisions live.

## 1. Summary

| Layer | Choice |
|---|---|
| Language | TypeScript everywhere. Cloud Functions run on **Node 22**; Bun is a dev-time tool only |
| Client | React + Vite + TypeScript, installable PWA (`vite-plugin-pwa`), Tailwind CSS |
| Hosting | Firebase Hosting (SPA, preview channels per PR) |
| API | Cloud Functions for Firebase (2nd gen), callable functions |
| Database | Cloud Firestore (Native mode) |
| Auth | Firebase Authentication: email-link for hosts; custom tokens for player seats; anonymous for spectators |
| Realtime | Firestore `onSnapshot` on per-viewer view documents |
| Push | Firebase Cloud Messaging (Web Push) |
| Scheduling | Cloud Scheduler via scheduled Cloud Functions |
| Abuse protection | Firebase App Check + Firestore-backed counters |
| Repo | **Bun** workspace monorepo (package manager, scripts and unit-test runner) |
| Tests | `bun test`, fast-check, Firebase Emulator Suite, Playwright |
| CI/CD | GitHub Actions deploying to Firebase |

Firebase plan: **Blaze** (pay as you go) is required for Cloud Functions. At this game's scale (many small games, a handful of commands per player per day) expect costs near zero; set a budget alert anyway.

## 2. The central decision: how Firestore meets the anonymity requirement

Firestore security rules grant or deny whole documents; they cannot hide individual fields. Hands, submission owners and card authorship are exactly the secrets the HLD protects (V2 to V5, E8, E9). So:

1. **The game aggregate is never readable by clients.** `games/{gameId}` and its private subcollections deny all client reads and writes. Only Cloud Functions (Admin SDK) touch them.
2. **Clients read only projected documents.** On every accepted command, the same transaction that commits the new state also writes one **view document per viewer**, produced by the View Projector (V1). A client sees exactly the document the Projector made for them.
3. **Clients never write Firestore directly.** Every mutation is a callable function, so the Engine, Moderation and idempotency can't be bypassed.

Consequence for the HLD: the **Change Feed component dissolves into Firestore listeners.** A client's `onSnapshot` on its own view document is both the query and the realtime channel. This deliberately revises invariant F1 ("the feed carries no data"): the feed channel now does carry data, but only a document the Projector already redacted for that exact viewer, protected by a rule that checks `request.auth.uid`. F2/F3 (lossy, not required for correctness) still hold: a missed snapshot is fixed by the next one, and `version` lets clients discard stale ones. If we ever leave Firestore, the HLD's hint-only feed returns.

## 3. Component mapping

| HLD component | Firebase realization |
|---|---|
| Web Client (PWA) | React app on Firebase Hosting. Service worker handles push and offline shell. |
| API Layer | One callable function, `command(envelope)`, plus a few small callables (`joinGame`, `lobbyInfo`, `rejoin`, `spectate`). Callables verify the Firebase Auth token and App Check token before our code runs, giving us A1. |
| Identity & Sessions | Firebase Auth. See section 4. |
| Game Engine | Pure TypeScript package (`packages/engine`), imported by the `command` function. No Firebase imports. |
| Game Store | Firestore transactions via the Admin SDK. See section 5. |
| View Projector | Pure TypeScript package (`packages/engine`, `project`), invoked inside the command transaction. |
| Change Feed | Firestore snapshot listeners on view docs (section 2). |
| Notification Service | Firestore-triggered function on the outbox collection, sending through FCM Admin. |
| Scheduler | `onSchedule` function (Cloud Scheduler), hourly. |
| Moderation | In-process wordlist library inside the Engine's validation step; no outbound calls (M4). |
| Deck Library | Firestore `hosts/{hostUid}/decks/{deckId}`, written only by functions. |

## 4. Identity design on Firebase

Every principal is a Firebase Auth user, so Firestore rules and callables share one identity.

| Principal | Firebase mechanism | Notes |
|---|---|---|
| **Host** | Email-link (passwordless) sign-in | Firebase sends the link itself, so **no email provider is needed in v1** (N5). Optionally brand the sender domain later. The Auth `uid` is the `hostId`. |
| **Player seat** | **Custom token**, `uid = seat:{gameId}:{playerId}` | `joinGame` mints it. The player's **rejoin link** carries a long-lived secret in the URL fragment (`/g/{gameId}#k=...`, so it never reaches server logs). A new device calls `rejoin(secret)`, which verifies the hash and mints a fresh custom token for the same uid. |
| **Host's own seat** | The host's email-link `uid` | The host plays too (Q1), so their player record stores `uid = hostUid`. Commands resolve `request.auth.uid` to a playerId through the game's player list, so host powers and the host's seat share one identity. |
| **Spectator** | Anonymous Auth | Their `uid` only dedupes People's Choice votes. |

Mapping to HLD invariants:
- I1: a seat's uid embeds `(gameId, playerId)`, and `command` rejects any uid not in that game's player list.
- I2/Q3: the stored secret is a hash; the host can **reissue** a player's link, which replaces the hash and so kills the old link. Removing a player or deleting a game deletes the seat's Auth user and revokes its refresh tokens.
- I3: Firebase single-use email links.
- I4: display-name uniqueness is enforced by the Engine on `join`.

**Room codes and links.** The shareable link uses the Firestore auto-ID of the game (20 random characters, unguessable). The 4-letter code lives in `roomCodes/{code} -> gameId`, readable only through `lobbyInfo` / `joinGame` callables so it can be rate-limited (R2).

**Required setup note:** minting custom tokens needs the Functions service account to hold the `iam.serviceAccountTokenCreator` role.

## 5. Firestore data model

```
games/{gameId}                      // Game aggregate: settings, phase, version, players[], pools, current round
                                    // ALL client access denied
games/{gameId}/drafts/{playerId}    // private drafts; the ONLY place authorship exists (E8). Denied to clients.
games/{gameId}/rounds/{n}           // resolved RoundRecords, append-only (S3). Written only at resolution.
games/{gameId}/views/{uid}          // projected GameView for one player. Read: auth.uid == {uid}
games/{gameId}/views/spectator      // projected spectator view. Read: any signed-in user, if `enabled`
games/{gameId}/events/{version}     // domain event log (ids and kinds only)
games/{gameId}/outbox/{eventId}     // transactional outbox; triggers Notifications. Denied to clients.
games/{gameId}/idem/{key}           // idempotency ledger (E4); Firestore TTL policy deletes after 7 days
roomCodes/{code}                    // -> gameId. Denied to clients.
hosts/{hostUid}                     // host profile
hosts/{hostUid}/decks/{deckId}      // saved decks (D1, D2)
pushSubs/{uid}_{gameId}             // FCM tokens for a seat. Denied to clients; written by callable.
```

**Why this shape**
- *Rounds are world-readable to any signed-in user who knows the game id.* Only resolved rounds are ever written there, and players and spectators see the same resolved history (V5, V7), so correctness holds by construction. Unguessable game ids give the same "anyone with the link" access the gameplay doc specifies for spectators and finished games (Q10).
- *History lives in a subcollection*, not the aggregate, to stay far under Firestore's 1 MiB document limit however long a game runs.
- *Aggregate stays in one document* so a command is one read plus one write for state.

**Commands as transactions (S1/S2).** `command` runs `db.runTransaction`:
1. Read `games/{id}` and the idempotency doc.
2. If the key exists, return the stored result (E4).
3. Run `decide(state, cmd, {now, rng})`.
4. In the same transaction, write: new state with `version + 1`, any `rounds/{n}`, `events/{v}`, `outbox/*`, the idempotency doc, and **every affected `views/*` doc** (all players plus spectator).

Firestore retries a transaction on contention, which gives per-game serialization without a lock service. A game's write rate is far below the ~1 write/second/document guideline, and a command stays well under the 500-write transaction limit (at most 10 views plus a few docs).

`rng` for shuffles comes from a per-command seed stored in the event, so a command is reproducible for debugging.

**Rules, in outline**
```
match /games/{gameId} {
  allow read, write: if false;                                  // aggregate, drafts, outbox, events, idem
  match /rounds/{n}      { allow read: if request.auth != null; allow write: if false; }
  match /views/{uid}     { allow read: if request.auth != null && request.auth.uid == uid; allow write: if false; }
  match /views/spectator { allow read: if request.auth != null && resource.data.enabled == true; allow write: if false; }
}
match /{document=**} { allow read, write: if false; }
```
Rules are covered by `@firebase/rules-unit-testing` tests that attempt every forbidden read (another player's view, the aggregate, drafts) and expect denial.

## 6. Notifications and scheduling

- **Push:** FCM web push via the Firebase JS SDK and a service worker. A client registers its token through a callable (`registerPush`), which stores it in `pushSubs`.
- **Outbox to FCM:** a function triggered by `onDocumentCreated('games/{gameId}/outbox/{eventId}')` fans out per the HLD trigger table. Triggers are at-least-once, so the function writes a dedupe doc keyed `{eventId}_{uid}` before sending (N1). Payloads are ids and generic copy only (N2).
- **Failure isolation (N4):** this function runs outside the command transaction; a push failure can never fail a command. Tokens that return `registration-token-not-registered` are deleted.
- **Daily reminders:** an hourly `onSchedule` function queries games with `phase in (SUBMITTING, JUDGING)`, `paused == false` and `reminderDueAt <= now` (a denormalized top-level field the Engine maintains on the aggregate, with a composite index). It notifies the players being waited on and advances `reminderDueAt` by 24 h, which makes the sweep idempotent (T2).
- **iOS:** web push requires iOS 16.4+ and the PWA installed to the home screen. The client onboarding must prompt for install (R3).

## 7. Abuse protection (A4, R2)

Firebase has no built-in rate limiter, so:
- **App Check** (reCAPTCHA Enterprise on web) on all callables to keep out scripted traffic that isn't our app.
- **Counters in Firestore** (`rateLimits/{kind}_{key}` with a window and count, written inside the callable) for `lobbyInfo`/`joinGame` per room code and per IP hash, and for host sign-in requests per email. Lockout on repeated failures.
- Firebase Auth's own throttling covers email-link requests at the infrastructure level.

## 8. Repository and tooling

```
dc/
  apps/web/            React PWA
  functions/           Cloud Functions entry points (thin: auth, rate limit, transaction, call engine)
  packages/engine/     pure domain core + Projector + Moderation (no I/O, no Firebase imports)
  packages/contracts/  command/view/error types and zod schemas shared by web and functions
  firebase.json, firestore.rules, firestore.indexes.json
  docs/
```

- **Package manager and scripts:** Bun workspaces (`workspaces` in the root `package.json`, internal deps as `workspace:*`, one `bun.lock`). **Build:** Vite for web (runs fine under Bun); `bun build --target=node` for functions.
- **Bun is a dev tool, not a runtime.** Cloud Functions for Firebase run Node, not Bun. So `packages/engine`, `packages/contracts` and `functions/` must use only standard Web/Node APIs; no `Bun.*` globals or `bun:*` imports in anything that ships to Functions (lint-enforced; `bun:test` is allowed in test files only).
- **Deploying functions from a workspace.** The Firebase CLI uploads the functions directory and installs its dependencies in the cloud, which can't resolve `workspace:*` packages and doesn't read `bun.lock`. So the functions build script bundles `functions/`, `engine` and `contracts` into one Node-target file in `functions/dist`, and generates a minimal `package.json` there that lists only the external runtime deps (`firebase-admin`, `firebase-functions`) at pinned versions. `firebase.json` points `source` at that directory.
- **Contracts:** zod schemas in `packages/contracts` generate the types for the command envelope, `GameView` and error codes, so the client and server can't drift.
- **Engine isolation rule:** `packages/engine` may not import `firebase-*`, `node:*` I/O or read the clock; a lint rule enforces this (T3, section 3.4 of the HLD).

**Testing**
| Level | Tool | Covers |
|---|---|---|
| Engine unit and property | `bun test`, fast-check | Every rule in gameplay.md; E1 to E18; V2 to V5 over random games and every viewer role |
| Security rules | Firebase Emulator + `@firebase/rules-unit-testing` | Section 5 denials |
| Function integration | Emulator Suite (Firestore, Auth, Functions) | Transactions, idempotency, outbox, custom-token rejoin |
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
| **Custom-token IAM and Auth user growth** | One Auth user per seat; deleted with the game. Pruned by `deleteGame` (S5). |
| **Email deliverability of Firebase's sign-in links** | Default sender can land in spam. Mitigate with a custom domain and sender in Firebase Auth templates before launch. |
| **Firestore index/limit surprises** | Aggregate stays below 1 MiB (history is in subcollection); reminder query has a declared composite index. |

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

1. Create the Firebase projects, enable Auth providers (email link, anonymous), Firestore, Functions, Hosting and App Check.
2. Scaffold the Bun monorepo and CI, including the functions bundling step, and verify a deploy to staging early since it is the riskiest tooling seam.
3. Build `packages/engine` with its property tests first, as in the HLD build order, before touching Firebase.
