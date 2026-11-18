# Deep Cuts: Execution Plan

Status: draft v0.1. Turns the [HLD](./high-level-design.md) build order (section 9) and LLDs 0 to 7 into milestones and steps. Each step is sized to be one PR. Each one names the LLD sections it implements and how we know it's done. In this plan, "done" means the step's tests are merged into CI and pass, not that the step was reviewed.

## Principles

- **Riskiest seam first.** The Bun-to-Node functions bundle, IAM custom tokens and App Check get proven on staging before any game code exists (LLD 0 section 11).
- **Pure core before I/O.** The full ruleset and the anonymity guarantee run under `bun test` before Firebase is involved (HLD section 9, steps 1 and 2).
- **A playable game early.** M5 ends with a real game among friends on staging, with no push notifications and no variants. Everything after M5 adds to a working product.
- **Variants arrive behind their flags.** Engine settings carry the variant flags from M1, but each variant is rejected with `VARIANT_UNAVAILABLE` until M7 implements it from end to end. Moderation ships with the Engine (LLD 1 section 12). M7 adds only the wordlist content.
- **Every new collection arrives with its rules denial test** (P10), and every new export arrives with its `exports.json` entry (P7). These checks are part of each step's done criteria, not separate steps.

## Milestone overview

| # | Milestone | LLDs | Depends on | Exit demo |
|---|---|---|---|---|
| M0 | Platform walking skeleton | 0 | none | `ping` deployed to staging by CI through WIF; smoke test passes; custom-token sign-in works |
| M1 | Contracts + Engine core | 5 (section 2), 1 | M0 (repo, CI) | A scripted 3-player game reaches a win in `bun test`; E1 to E18 and X1 to X10 property tests are green |
| M2 | View Projector | 2 | M1 | Forbidden-values oracle, non-interference test and mutants are green; view fixtures are exported to contracts |
| M3 | Game Store | 3 | M2 | `runCommand` against the emulator drives a full game; rules denial matrix complete; `deleteGame` cascade works |
| M4 | API + Identity | 5, 4 | M3 | Integration suite plays a game over callables with real seat tokens, rejoin and reissue, against the Node bundle |
| M5 | Web client: first playable | 7 | M4 | Friends play a full game on staging from phones |
| M6 | Notifications + Scheduler | 6, 7 (section 8) | M5 | Push and the daily reminder reach real Android, desktop and installed-iOS devices (LLD 6 section 10.4 checklist) |
| M7 | Variants, spectators, People's Choice, moderation content | 1, 2, 5, 7 | M5 (M6 not required) | Each variant playable end to end; awards and podium shown at game end |
| M8 | Production launch | 0 | M6, M7 | Prod deployed from a tag behind approval; readiness checklist (LLD 0 section 10) signed off |
| M9 | Deck Library (later phase) | 1 (section 13), 3, 5 | M8 | Save a deck after a game and import it into the next |

M6 and M7 are independent and can run in parallel after M5.

---

## M0. Platform walking skeleton

Goal: prove the toolchain and cloud seams with throwaway `ping` and `diag` callables before any real code exists. This milestone follows LLD 0 section 11.

| Step | Work | Refs | Done when |
|---|---|---|---|
| 0.1 | Create the staging Firebase project. Blaze plan, budget alerts, Firestore Native at `nam5`, six TTL groups, API enablement, Identity Platform upgrade (Email link + Anonymous, auto-cleanup), App Check with reCAPTCHA Enterprise, `fn-runtime` and `ci-deployer` service accounts including the token-creator self-grant, WIF pool, secrets and params | LLD 0 sections 2 and 11 steps 1 to 7; LLD 4 section 13 | Checklist in LLD 0 section 2 ticked; Identity Platform pricing confirmed (LLD 4 open question 12) |
| 0.2 | Scaffold the Bun workspace: `apps/web`, `functions`, `packages/engine`, `packages/contracts`; tsconfigs; lint blocks for engine isolation (P5) and the store, notify and sweep blocks (P21) | LLD 0 sections 3 and 5 | `bun run lint` and `bun run typecheck` pass on the empty packages |
| 0.3 | Functions bundling. `build.ts` generates `dist/package.json` and `package-lock.json`, runs `npm install` in `dist`, writes the `.install-ok` stamp and copies `.env.<projectId>`. Also `check-bundle` and the `exports.json` check (P6, P7) | LLD 0 section 4 | `functions/dist` matches LLD 0 section 11 step 9 |
| 0.4 | A minimal `defineCallable` (region, App Check, service account, error logging), plus `ping` and `diag` | LLD 0 section 11 step 8; LLD 5 section 4.2 (minimal form) | A `ping` integration test under the Functions emulator asserts Node 22 (P9) |
| 0.5 | Test harness wiring: `bun test packages`, `test:web` (happy-dom, separate process), `test:rules`, `test:integration`, `test:e2e` placeholder, `FC_SEED` | LLD 0 section 6; LLD 7 open question 10 | Each command runs green with one trivial test |
| 0.6 | Web scaffold. Vite, React, Tailwind 4 and the `.env.<mode>` files; App Check init with the debug token for preview builds; `check-web-size.ts`; Hosting headers including `Referrer-Policy: no-referrer` | LLD 7 sections 2 and 3.1; LLD 0 section 7; LLD 7 open question 12 | `vite build --mode staging` works; size check passes |
| 0.7 | First manual staging deploy: rules (deny-all), indexes, `wait-indexes.ts`, functions, hosting; smoke script; `diag` custom-token sign-in; remove `diag` | LLD 0 section 11 steps 11 to 17 | Smoke passes, and a call without an App Check token is rejected |
| 0.8 | CI workflows: `verify`, `emulator`, `preview`, `deploy-staging`, tag deploy and `workflow_dispatch` rollback (prod jobs stubbed until M8); secret scan; log sentinels | LLD 0 section 8 | LLD 0 section 11 step 19: a PR gets a preview URL, and a merge deploys staging with no keys |
| 0.9 | Observability: structured logger, `ops-apply.ts` dashboard and alert policies | LLD 0 section 9 | `ping` log line visible with `event` set; alerts exist |

**Decide in M0:**
- Whether the pinned `firebase-tools` accepts `"ttl": true` in `fieldOverrides` (LLD 0 open question 8, LLD 3 open question 6).
- Which runtime options are supported: `cpu: 1` at 256MiB, `concurrency: 80`, `minInstances` param (LLD 5 open question 14).
- Whether the pinned `firebase-functions` supports `beforeEmailSent` (LLD 5 open question 17).

## M1. Contracts + Engine core

Goal: implement the whole ruleset except the variants, as pure code with property tests. No Firebase.

| Step | Work | Refs | Done when |
|---|---|---|---|
| 1.1 | `@dc/contracts` base: ids, caps (`MAX_TOTAL_JOINS`, `MAX_VOTES`, `TEXT_LIMITS`, wire maxima), `ErrorCode` and details, `CommandEnvelope` and payload schemas (strict and loose; loose enums parse as `z.string()`), version constants | LLD 5 sections 2.1 to 2.4 and 2.6 | Contract tests (LLD 5 section 10.1) green |
| 1.2 | Engine domain model, `Rng` and `mintId` ports, `decide` skeleton with the fixed guard order, `actorRole`, `settle`, test support harness (`scriptedRng`, builders, `legalCommands` generator) | LLD 1 sections 2, 3, 5, 6, 8.2 and 15.1 | X1 to X5 and G1 green on the commands implemented so far |
| 1.3 | Lobby and setup: `createGame`, `updateSettings`, `join` (`totalJoins` cap), `leave`, `removePlayer` in LOBBY, playability formulas and `writeCounts` | LLD 1 sections 7, 8.5 and 9.1 to 9.3 | E1, E7, X9 unit and property tests |
| 1.4 | Writing: `startGame`, `saveDraft` (`aggregateChanged`), `finishWriting` with anonymous pooling, `beginPlay`, first judge, initial deal | LLD 1 sections 8.4, 8.7 and 9.5 | E3, E5, E6, E8 |
| 1.5 | Rounds: open, `confirmSubmission`, `closeSubmissions`, `revealOrder`, `pickWinner`, top-up and red reshuffle, rotation, `FINISHED` | LLD 1 sections 8.3, 8.4 and 8.8 | E9 to E15, X6; scripted 3-player game to a win |
| 1.6 | Stalls and membership mid-game: `passJudging` (including the void case and `judgeReassigned`), pause and resume (null judge), late join and `writing` in PLAYING, mid-game leave and remove with the score pile returning to the green deck, `endGame` | LLD 1 sections 8.1, 8.5 and 9.4 | E12, E17, E18, X7 and the stalled-judge scenarios |
| 1.7 | Waiting fields and reminders: episode, `episodeGen`, `waitingOn`, `reminderDueAt`, `markReminded` | LLD 1 sections 4.2 and 7.4 | X8 |
| 1.8 | Moderation module (mechanism, with a placeholder list), wired into the six entry points; `removeCard` limited to cards shown to the table, with the minimums guard | LLD 1 sections 8.6 and 12 | M1 to M4, X10 |
| 1.9 | Domain events and `EventDoc` content (no seed or actor on `finishWriting`, `importDeck` or `writeIn`); selectors for the Projector | LLD 1 sections 11 and 14 | E9 event scan; events per command match section 7.2 |

## M2. View Projector

| Step | Work | Refs | Done when |
|---|---|---|---|
| 2.1 | `GameView`, `ViewDoc` and `RoundDoc` strict and loose schemas in contracts | LLD 5 section 2.5; LLD 2 section 4 | Schema tests green |
| 2.2 | Viewers (`viewerFor`, `viewersOf`), `project`, `YouTurn`, departed views, redaction tables per phase | LLD 2 sections 3 to 5 | Golden snapshots per phase and viewer (LLD 2 section 11.5) |
| 2.3 | `fanOut` with skip-unchanged and the `viewsRev` guard, size cap (PJ14), `toRoundDoc` | LLD 2 sections 7 and 8 | PJ1, PJ2, size tests |
| 2.4 | Anonymity test suite: forbidden-values oracle, non-interference test, canaries and mutants (including M-writein), type-level guards | LLD 2 sections 11.2 to 11.7 | Every mutant is killed; the invariant matrix passes |
| 2.5 | Export view fixtures from the goldens to `packages/contracts/fixtures/views/*.json` for the web client | LLD 7 open question 11 | Fixtures generated in CI and checked for drift |

## M3. Game Store

| Step | Work | Refs | Done when |
|---|---|---|---|
| 3.1 | `firestore.rules` (views rule with the `ep` check for seat uids, world-readable rounds), `firestore.indexes.json`, field exemptions, TTL overrides | LLD 3 sections 3 and 4 | Denial matrix (LLD 3 section 3.3) complete; P10 collection-coverage check passes |
| 3.2 | The `command` transaction: load, idempotency ledger, staleness, `decide`, `WriteSet` merge, views and round docs, events, `buildOutbox`, draft region and `draftSeq` | LLD 3 sections 5.1 to 5.8, 8 and 9 | Store integration tests (LLD 3 section 10.3), including retries and the write-count budget |
| 3.3 | `createGame` with room-code allocation, plus `findByRoomCode` | LLD 3 section 6.1 | Collision and expiry tests |
| 3.4 | `listWaitingOn` reminder query, `rebuildViews`, `viewsRev` upgrade path | LLD 3 sections 6.5 and 7 | `viewsStale` fixture rebuilds |
| 3.5 | `deleteGame` cascade: `deletions/{gameId}` job, `deletionRunner` stages, room-code release with an ownership check | LLD 3 section 6.4 | Cascade test leaves no game data; the `deletion.stuck` alert is wired |
| 3.6 | Emulator fixtures, built by script: `lobby3` to `departed40`, `midsize10` size fixture | LLD 3 section 10.1 | Fixtures seed in CI; size budgets (section 2.5) hold on `midsize10` |

## M4. API + Identity

| Step | Work | Refs | Done when |
|---|---|---|---|
| 4.1 | Full `defineCallable` pipeline: version gate (`CLIENT_OUTDATED`), App Check, principal resolution, zod parse, rate limit, error mapping with no leakage, observability fields | LLD 5 sections 4, 5 and 9; LLD 4 section 2.2 | Registry tests (LLD 5 section 10.3) |
| 4.2 | Rate limiter: buckets, IP derivation (`TRUSTED_HOPS`), refunds | LLD 5 section 7 | Limiter tests (section 7.4) |
| 4.3 | `command` callable: `expectedVersion`, `STALE`, idempotency key scope, `applyCommandResult` response shape | LLD 5 section 6 | Integration plays a scripted game over HTTP |
| 4.4 | Host identity: email-link flow (client side), `hostProfile`, `createGame` callable, `listGamesByHost`, `signOutEverywhere`, `beforeEmailSent` if supported | LLD 4 section 3; LLD 5 section 8.1 | Integration tests (LLD 4 section 12.2, host rows) |
| 4.5 | Player join: `lobbyInfo`, `joinGame` with `joinIdem` replay (only while `firstSignInAt` is null), seat custom tokens with `ep`, `assertSeatLive` | LLD 4 sections 4 and 8 | Join, replay and lost-response tests |
| 4.6 | `rejoin`, `reissueRejoinLink` (bumps the epoch, `notBefore`, `clearSeatPush`), leave and remove revocation through `identityOutbox` and `handleIdentityRow`, the identity stage of `deleteGame`, `spectate` | LLD 4 sections 5 to 7 | Rules tests for stale-epoch view reads (LLD 4 section 12.3); revocation tests |
| 4.7 | Client/server compatibility test and the real smoke script (`lobbyInfo` path) | LLD 5 sections 10.4 and 10.5 | Smoke passes on staging after `deploy-staging` |

**Decide before the first contract change lands on `main` (4.3):** whether preview channels may keep pointing at staging functions (LLD 0 open question 1, LLD 5 open question 15).

## M5. Web client: first playable

| Step | Work | Refs | Done when |
|---|---|---|---|
| 5.1 | App shell: routes and deep links, boot sequence and the `#k=` fragment, per-game Firebase apps, session resolution, revoked-seat probe, Blocked/Update screens | LLD 7 sections 2 to 3 and 8.5 | Component tests for session resolution |
| 5.2 | Data layer: view and round listeners, version rule, missing or late snapshots, connection chip | LLD 7 section 4 | Version-rule unit tests using the contract fixtures |
| 5.3 | Command layer: retries, idempotency keys in `sessionStorage`, `STALE` handling, typed error copy | LLD 7 sections 5 and 9.4 | Command-layer unit tests |
| 5.4 | Home, Host sign-in and create, Join (invite), Lobby, Me | LLD 7 sections 7.2 and 7.3 | e2e: host creates, 3 players join by code and link |
| 5.5 | Writing and Ready, with draft sync (`saveDraft`, `draftSeq`, in-flight echo) and the late-joiner banner | LLD 7 section 6.3 | e2e: two-device draft resume |
| 5.6 | Round screens: Hand, Submitted, Judge waiting, Judging (judge and non-judge), Round result, Sit out, Paused, Over | LLD 7 sections 7.2 to 7.4 | e2e: full game to a win |
| 5.7 | Host console (remove player or card, close, pass judging, end, reissue, delete), History, Departed, Gone, `clearGameLocal` | LLD 7 sections 7.2 and 7.5 | e2e: stalled judge, removal, delete |
| 5.8 | Accessibility pass, design tokens, performance budgets, offline and multi-tab behavior | LLD 7 sections 6.4, 9 and 10 | axe checks in e2e; size budget held |
| 5.9 | **Staging playtest** with friends over a few days; triage the findings | none | Findings filed as issues; blockers fixed |

## M6. Notifications + Scheduler

| Step | Work | Refs | Done when |
|---|---|---|---|
| 6.1 | `registerPush` and `unregisterPush`, the `pushSubs` model, cleanup hand-offs | LLD 6 section 2 | Rules and integration tests |
| 6.2 | `notifyOutbox` fan-out: event-to-recipient map (all trigger rows, including `owe_card` and `game_ended`), `planVersion`, payload, copy | LLD 6 section 3 | Unit tests (section 10.1); anonymity tests (section 10.3) |
| 6.3 | Delivery: dedupe claim, `PushSender` port, retry, dead-token handling, poison rows and redrive (including the identity-row redrive) | LLD 6 section 4 | Emulator integration (section 10.2) |
| 6.4 | `reminderSweep` (hourly) calling `markReminded`, the 24 h gap enforced at delivery, and the `housekeeping` export | LLD 6 section 5 | Sweep tests; the `reminder.sweep.done` alert is wired |
| 6.5 | Client: `/sw.js` (`injectManifest`), permission status machine, install onboarding, "not reaching you" fallback | LLD 7 section 8; LLD 6 section 6 | Component tests; SW update flow |
| 6.6 | Manual device checklist on staging: Android Chrome, desktop, iOS installed PWA; verify the Web Push `Topic` header and the raw payload shape | LLD 6 section 10.4; LLD 6 open question 10; LLD 7 open question 2 | Checklist passes on each device |

## M7. Variants, spectators, People's Choice, moderation content

| Step | Work | Refs | Done when |
|---|---|---|---|
| 7.1 | Pitch it: Engine, view, Hand UI | LLD 1 section 7; LLD 2 section 5 | E16 (pitch); e2e |
| 7.2 | Write-in: once per game, recirculates unmarked; EventDoc records `confirmSubmission` | LLD 1 open question 18 | E16; M-writein mutant killed; e2e |
| 7.3 | Redraw | LLD 1 section 7 | E16, X6 with heavy redraw |
| 7.4 | People's Choice: `castVote` (votes on the final round allowed), `vote_cap`, awards, podium, History vote buttons | LLD 1 section 8.8 and open question 4 | E16 votes; e2e podium |
| 7.5 | Spectators: spectator view doc, `spectate`, Board screen, spectator voting with local `myVotes` | LLD 2 open question 5; LLD 4 section 7; LLD 7 Board | Rules tests for `views/spectator`; e2e |
| 7.6 | Profanity wordlist content and policy, on and off modes | LLD 1 open question 11 | Wordlist reviewed; M1 table test uses the real list |

## M8. Production launch

| Step | Work | Refs | Done when |
|---|---|---|---|
| 8.1 | Create the prod project, repeating 0.1 (no debug App Check token in any web build) | LLD 0 sections 2 and 11 | Checklist ticked for prod |
| 8.2 | Turn on the prod CI jobs: `check-tag`, `deploy-prod` behind `production` approval; test a rollback by dispatching an older tag | LLD 0 section 8 | Tag `v1.0.0` deployed; rollback rehearsed |
| 8.3 | Backups, PITR, export and cost review; alert thresholds | LLD 3 section 12; LLD 0 section 9 | Restore drill on staging |
| 8.4 | Readiness sign-off: LLD 0 section 10 rollup, device and accessibility matrix, host-account admin runbook | LLD 0 section 10; LLD 7 section 11.3; LLD 4 open question 9 | All items checked |

## M9. Deck Library (later phase)

Promote `saveDeck`, `listDecks`, `deleteDeck` and `importDeck` out of `RESERVED_CALLABLES`. The `importDeck` command reads `hosts/{uid}/decks` on the server. Add the lobby UI for combining a saved deck with new cards. Refs: HLD section 3.11, LLD 1 section 13, LLD 3 `DeckDoc`, LLD 5 section 3.1.

## Carried-over open questions

These items from the LLDs' open-question sections don't block a milestone. Revisit them after the M5 playtest:

- The host can't retake a seat after leaving (LLD 4 open question 7, LLD 7 open question 9). This could become a `takeSeat` command.
- No quiet hours and no per-player reminder cap across games (LLD 6 open questions 8 and 9).
- One FCM token per seat per game, so a second device replaces the first (LLD 5 open question 13).
- On iOS, Safari and the installed PWA keep separate storage (LLD 4 open question 10, LLD 7 open question 4).
- Hot counter documents under a burst of joins from a shared IP address (LLD 5 open question 16).
