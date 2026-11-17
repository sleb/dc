# Deep Cuts: LLD 6, Notifications & Scheduler (FCM, reminder sweep)

Status: draft v0.1. Companion to [gameplay.md](../gameplay.md), [high-level-design.md](../high-level-design.md) (HLD), [tech-stack.md](../tech-stack.md), [00-platform-build-deploy.md](./00-platform-build-deploy.md) (LLD 0), [01-game-engine.md](./01-game-engine.md) (LLD 1), [02-view-projector.md](./02-view-projector.md) (LLD 2), [03-game-store.md](./03-game-store.md) (LLD 3), [04-identity-sessions.md](./04-identity-sessions.md) (LLD 4) and [05-command-api-contracts.md](./05-command-api-contracts.md) (LLD 5). This LLD specifies the push device model and `registerPush`/`unregisterPush` behavior, the outbox-triggered fan-out, recipient resolution and copy, dedupe, retry and pruning, the reminder sweep and its reconciliation with HLD T1, notification preferences and the permission fallback, observability and tests. It builds on the names of LLDs 0 to 5 unchanged; conflicts are recorded at the end, not silently fixed. HLD invariants N1 to N5 and T1 to T3 are kept (N1, N3, N4, T1 receive amended wording, section 9); new invariants are labeled **NT1 onward**. "Must" statements are testable. Code lives in `functions/src/notify/` (Admin SDK, Node 22); it imports `@dc/engine` types and `@dc/contracts` only.

## 1. Decisions at a glance

Items earlier LLDs pushed to this one, and their resolutions.

| Question (origin) | Resolution | Rationale |
|---|---|---|
| `pushSubs` device model (LLD 5 conflict 13) | Keep doc id `pushSubs/{uid}_{gameId}`; the doc holds a `devices` map keyed by `deviceId`, at most 5 devices | LLD 3's cascade (`where gameId ==`) and rules rows 13 stay valid; a fan-out reads one doc per recipient |
| Same token on several seats | A token belongs to at most one seat per game; registering it for seat B removes it from seat A's doc of that game. Across games the same token is normal | A shared phone notifies whoever registered last |
| Reminder as outbox row vs direct send (LLD 3 conflict 5) | **Outbox row accepted.** The sweep only calls `markReminded`; the `Reminder` row is delivered by the same fan-out | Advance and send intent are atomic; reminders inherit dedupe, retry, pruning and metrics |
| `markReminded` vs HLD T1 (LLD 1 oq 2, LLD 3 conflict 3) | Accepted; T1 reworded (section 9) | The write is serialized with player commands |
| Composite index for the sweep (tech-stack 6, LLD 3 conflict 2) | None. Single-field `reminderDueAt` index (LLD 3 section 7) | `reminderDueAt` is non-null only while a wait episode exists: WRITING, SUBMITTING or JUDGING, unpaused (LLD 1 X8) |
| `JudgeChanged` trigger (LLD 1 oq 5) | Notified, merged per outbox version (section 3.3). The new judge always gets a push; the old judge gets one only if they now owe a card | The judge change creates a new obligation |
| Principle (user decision U1) | A player gets a push whenever they **become** newly waited-on, and a daily reminder for as long as they stay waited-on, in every phase where the game waits on someone: WRITING (unfinished writers), SUBMITTING (non-judge, not submitted), JUDGING (the judge) | gameplay.md: nobody should have to poll the app to learn it is their turn. Transitions: `WritingStarted`, `RoundOpened`, `SubmissionsClosed`, `JudgeChanged`, unpause (section 3.2) |
| Pause, unpause, late join, removal, game end | Pausing is silent (HLD). **Unpause notifies the players the game is waiting on.** A late joiner (WRITING or PLAYING) is already in the app: no push, but while in status `writing` they are in `waitingOn` and so in the reminders. Removal sends nothing. **A host-ended game (`GameEnded`) notifies every seated player**, even while paused (section 3.2) | A paused game has nobody waited on; on resume they are again. Nobody should learn the game is over only by polling |
| Outbox delivery, ordering, retention (LLD 3 section 8) | At-least-once, unordered; per-recipient claim doc; superseded and stale rows skipped; redrive hourly | Section 4 |
| Dedupe handoff and doc key (LLD 3) | `games/{g}/notifLog/{rowId}_{uid}`, created in a transaction before any send | N1 |
| TTL configuration (LLD 3 conflict 6) | `notifLog` 30 days via `expiresAt` (declared by LLD 3); this LLD adds no TTL collection | Outlives the 14-day outbox |
| Payload type | Data-only messages with server-owned copy; web push `TTL`, `Urgency`, `Topic` headers | The service worker must always show a notification (iOS); copy lives in one place |
| Quiet hours | None in v1 | No time zone known; reminders fall 24 h after a notice the player already received |
| Mute / opt-out | None stored server-side; the device list is the preference | gameplay.md has no mute |
| Languages | English only | gameplay.md and the client are English |
| Email | None (N5); seam only (section 8) | |

Module layout:

```
functions/src/notify/
  copy.ts          COPY table, NotifKind                      (section 3.5)
  plan.ts          planVersion, planReminder (pure)           (section 3.3)
  message.ts       buildMessage, topicFor (pure)              (section 3.4)
  sender.ts        PushSender port, FcmSender, FakeSender     (section 4.5)
  subs.ts          registerSub, unregisterSub, pruneToken, clearSeatPush   (section 2)
  deliver.ts       claim, send, finalize                      (section 4)
  handler.ts       notifyOutbox trigger, handleNotifyRow      (section 3.1)
  sweep.ts         reminderSweep                              (section 5)
  housekeeping.ts  outbox and deletion redrive                (section 4.6)
```

## 2. Push architecture and device model

### 2.1 Contract with the client (detail in LLD 7)

| Item | Contract |
|---|---|
| Transport | FCM web push through the Firebase JS SDK (`getToken`) and the single service worker at `/sw.js` (LLD 7: vite-plugin-pwa `injectManifest`, no-cache headers per LLD 0 section 4), which also handles the raw FCM push; there is no separate `/firebase-messaging-sw.js`. The page passes that registration to `getToken` as `serviceWorkerRegistration` |
| VAPID | One Web Push certificate key pair per Firebase project, generated in the console (Project settings, Cloud Messaging). The private key stays inside Firebase; we never hold it. The public key is `VITE_FCM_VAPID_KEY` in `apps/web/env/*.env` (public config, LLD 0 section 7), distinct for staging and prod. Rotation is avoided: a rotated key orphans every token, so each client would re-register on its next open (section 2.3) and old tokens would be pruned on first send |
| Permission | Requested only from a user gesture, never on page load. The client calls `getToken` only after `Notification.permission === "granted"` |
| Registration | After a token is obtained, the client calls `registerPush({v, gameId, fcmToken, deviceId})` (LLD 5 3.1). `deviceId` is a random 128-bit id (22 chars base64url) generated once per browser install and kept in IndexedDB; a token obtained on that install is its current token |
| Message handling | The service worker must call `showNotification` for **every** push, on every platform (iOS revokes permission after repeated pushes that show nothing). It may close the notification at once if a visible window for the same game exists; it must not skip showing it |
| Click | `notificationclick` focuses an existing window or opens `new URL(data.url, self.location.origin)`, where `data.url` is `/g/{gameId}` (no secret; the seat session lives in app storage, LLD 4) |
| Replace | `showNotification(title, {body, tag: data.tag, renotify: true, data})`: a newer notice for the same game replaces the older one and still alerts |
| Unknown version | If `data.v !== "1"` the worker shows a generic fallback ("Something happened in your game") and opens `/` |

The server never sends a `notification` block, only `data` (section 3.4).

### 2.2 Data shape

```ts
// pushSubs/{uid}_{gameId}   server-only (LLD 3 rows 13); uid = seat uid, or hostId for the host's seat
interface PushSubDoc {
  uid: Uid; gameId: GameId; playerId: PlayerId;           // gameId, uid required by LLD 3's cascade
  devices: Record<string /* deviceId */, PushDevice>;     // 1..5 entries; an empty doc is deleted
  lastNotifiedVersion: number;                            // highest outbox version a send was claimed for (NT4)
  lastReminderAt: number | null;                          // last reminder claim (NT9)
  updatedAt: number;
}
interface PushDevice { token: string; createdAt: number; lastSeenAt: number }
```

- `deviceId` matches `^[A-Za-z0-9_-]{8,40}$` (it is a Firestore map key); `fcmToken` matches `^[A-Za-z0-9_:\-]{50,4096}$`. **This LLD is the source of these constraints; LLD 5's `registerPush` zod schema copies them exactly** (`fcmToken` required, `deviceId` optional, same regexes on `unregisterPush.fcmToken`), and LLD 5 lists `NOT_AUTHORIZED` for unseated principals (open question 5, resolved). If `deviceId` is omitted, the server uses `t_` plus the first 20 chars of `base64url(sha256(token))`, so each token is its own device.
- Scoping is **per seat per game**: the client registers once per game it has a seat in. A phone playing three games has three docs holding one token each. Pruning one doc does not prune the others; each is cleaned when its own send fails.
- Cap: at most 5 devices per seat; registering a sixth evicts the one with the oldest `lastSeenAt` (rationale: a stolen link plus abuse cannot grow a doc without bound).

### 2.3 `registerPush` / `unregisterPush`

Both are callables wrapped by LLD 5's `defineCallable` (principals seat, host; bucket `push_uid`, 20/h). The wrapper has already authenticated the principal and run `assertSeatLive` (LLD 4 ID3). This LLD owns the body.

```ts
export async function registerSub(db: Firestore, now: number, p: { uid: Uid; gameId: GameId; token: string; deviceId: string }) {
  await db.runTransaction(async (tx) => {
    const gSnap = await tx.get(db.doc(`games/${p.gameId}`).select("players", "store.deleting"));       // one read; ids and statuses only
    if (!gSnap.exists || gSnap.get("store.deleting")) throw reject("NOT_FOUND");
    const players = gSnap.get("players") as Pick<Player, "id" | "uid" | "status">[];
    const me = players.find((x) => x.uid === p.uid && SEATED.has(x.status));
    if (!me) throw reject("NOT_AUTHORIZED");                               // spectators, left or removed players, a host who left their seat
    const refs = players.filter((x) => SEATED.has(x.status)).map((x) => db.doc(`pushSubs/${x.uid}_${p.gameId}`));
    const snaps = await tx.getAll(...refs);                                // at most 10 reads; the token-dedupe scan
    for (const s of snaps) {
      if (!s.exists || s.id === `${p.uid}_${p.gameId}`) continue;
      const devs = s.get("devices") as Record<string, PushDevice>;
      const keep = Object.fromEntries(Object.entries(devs).filter(([, d]) => d.token !== p.token));
      if (Object.keys(keep).length !== Object.keys(devs).length)
        Object.keys(keep).length ? tx.update(s.ref, { devices: keep, updatedAt: now }) : tx.delete(s.ref);
    }
    const mine = snaps.find((s) => s.id === `${p.uid}_${p.gameId}`);
    const devices = { ...((mine?.get("devices") as Record<string, PushDevice>) ?? {}) };
    devices[p.deviceId] = { token: p.token, createdAt: devices[p.deviceId]?.createdAt ?? now, lastSeenAt: now };
    for (const [id] of Object.entries(devices).sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt).slice(0, Math.max(0, Object.keys(devices).length - 5))) delete devices[id];
    tx.set(db.doc(`pushSubs/${p.uid}_${p.gameId}`), { uid: p.uid, gameId: p.gameId, playerId: me.id, devices,
      lastNotifiedVersion: mine?.get("lastNotifiedVersion") ?? 0, lastReminderAt: mine?.get("lastReminderAt") ?? null, updatedAt: now });
  });
}
```

- A device that already holds a different token under the same `deviceId` is overwritten: this is **token rotation**. The client must re-register when `getToken` returns a token different from the last one it registered, and at least every 7 days it opens the game (this refreshes `lastSeenAt`; nothing prunes by age, because an absent player is exactly who needs the next push).
- `unregisterPush({gameId, fcmToken})` removes the device whose token matches (no-op if absent), deletes the doc when empty, and always returns `{ok:true}` (naturally idempotent). The client calls it when the user turns notifications off for this device, and **before** "Leave this device" signs out (LLD 4 section 6).
- Registration performs no FCM call (no dry-run): a junk token costs one failed send and is then pruned (section 4.4).
- Seat reissue: LLD 4's `reissueRejoinLink` must call `clearSeatPush(db, gameId, uid)` (deletes the doc) so a stolen link's device stops receiving that seat's notices (open question 6, resolved by C-IDHANDOFF: LLD 4 calls it after the reissue transaction commits; this module exports it from `subs.ts`).

### 2.4 Cleanup hand-offs

| Trigger | Action | Owner |
|---|---|---|
| `PlayerLeft` / `PlayerRemoved` identity outbox row | Delete `pushSubs/{seatUid(gameId, playerId)}_{gameId}`; the host's own seat doc (uid is `hostId`, not derivable from the row) is left inert, since fan-out only targets seated players | `notifyOutbox` also handles `topic: "identity"` rows for this one idempotent delete and records it in its own field `notifDoneAt`. It never writes `processedAt` on them: only LLD 4 does (`handleIdentityRow`, C-IDHANDOFF; open question 6) |
| `deleteGame` | Stage `push` deletes `pushSubs where gameId ==`; stage `history` deletes `notifLog` (LLD 3 6.4) | LLD 3; this LLD adds nothing. Fan-outs in flight at delete time find no devices; a stray `notifLog` doc written after the `history` stage carries only ids and expires by TTL in 30 days |
| Dead token on send | Remove that device only (section 4.4) | this LLD |
| Reissue | `clearSeatPush` | LLD 4 calls this LLD |

## 3. Fan-out

### 3.1 Trigger and flow

```ts
export const notifyOutbox = onDocumentCreated(
  { document: "games/{gameId}/outbox/{rowId}", retry: true, timeoutSeconds: 60, memory: "256MiB", maxInstances: 20, serviceAccount: FN_RUNTIME },
  (ev) => handleNotifyRow(deps, ev.params.gameId, ev.params.rowId));
```

```mermaid
sequenceDiagram
    participant S as Store (command txn)
    participant O as outbox row
    participant N as notifyOutbox
    participant D as Firestore (pushSubs, notifLog)
    participant F as FCM
    participant SW as Service worker
    S->>O: create rows v12_0.. in the command commit (S2)
    O-->>N: onDocumentCreated (at-least-once, unordered)
    N->>O: read fresh row, notifAttempts++
    N->>O: query rows of the same version
    N->>N: planVersion(rows) -> recipients and kinds
    loop each recipient (parallel, isolated)
        N->>D: txn: read pushSubs and notifLog; create notifLog(pending); lastNotifiedVersion
        N->>F: sendEach(one data message per device)
        F-->>N: per-device result
        N->>D: finalize notifLog; prune dead tokens
    end
    N->>O: processedAt = now, notifDoneAt = now (or throw to retry)
    F-->>SW: push (data-only)
    SW->>SW: showNotification(tag g-{gameId})
```

`handleNotifyRow(deps, gameId, rowId)` is shared by the trigger and the housekeeping redrive. For `notify` rows it ignores rows with `processedAt != null`; this consumer is the only writer of `processedAt` on them. For `identity` rows it runs the push cleanup (2.4) and sets only `notifDoneAt`. A row older than `MAX_AGE_MS` (24 h; reminders 6 h) is marked processed with `notifSkipped: true` (the reason `stale` is logged) and sends nothing (NT6). Consumer bookkeeping uses LLD 3's `OutboxRow` fields `id`, `notifAttempts`, `poisonedAt`, `notifSkipped`, `notifDoneAt`.

### 3.2 Event to recipient map

Source: LLD 1 section 11.1 and LLD 3's `NOTIFY_EVENTS` (`RoundOpened`, `SubmissionsClosed`, `WinnerPicked`, `GameFinished`, `GameEnded`, `JudgeChanged`, `WritingStarted`, `PausedChanged`). Everything planning needs is on the row, captured at commit time (C-OUTBOX): `roster` (the row's post-state snapshot, seated players with status), `judgeId`, `paused`, `round?: { number, phase }` (post-state; absent in WRITING) and `waitingOn: PlayerId[]` (ids only, post-state). `planVersion` therefore does no Firestore read. Only `Reminder` rows still consult a masked live read of `games/{g}` (`episode`, `episodeGen`, `waitingOn`), because a player may have acted between the sweep and the fan-out (5.3). Every row with `paused: true` produces nothing (NT2), except `GameEnded` (the host may end a paused game); an unpause row has `paused: false`.

| Event (outbox row) | Recipients | Kind | Decision |
|---|---|---|---|
| `WritingStarted` | roster players with status `writing` (the active players of the phase; `ready` players owe nothing) | `write` | Notified (U1): "write your cards" |
| `RoundOpened` | `event.expected` that are `active` in the roster | `turn` | Notified (HLD) |
| `SubmissionsClosed` (any reason) | `event.judgeId` if `active` | `judge` | Notified (HLD) |
| `WinnerPicked` | all seated roster players (`active`, `ready`, `writing`), including late joiners still writing | `result` | Notified (HLD, K-D) |
| `GameFinished` | all seated roster players (`active`, `ready`, `writing`), including late joiners still writing | `game_over` | Notified (HLD, K-D) |
| `GameEnded` (host ended the game) | all seated roster players (`active`, `ready`, `writing`; not departed), also from a `paused: true` row | `game_ended` | Notified (K-D) |
| `JudgeChanged`, new judge `to` | `to` if `active` and `row.judgeId == to` | `judge_now` when `row.round.phase == "JUDGING"` (all cards in), else `judge_assigned` (phase `SUBMITTING`: "you are now judging", cards still coming) | Notified (U1). No one else is told that judging moved, except the old judge below |
| `JudgeChanged`, old judge `from` | `from`, only if `reason == "passed"`, `row.round.phase == "SUBMITTING"` and `from` is in `row.waitingOn` | `owe_card` | Notified: a newly waited-on transition (they became an ordinary player who owes a card; open question 18). `left`/`removed` judges are departed and never notified; `resumed` (`from: null`, LLD 1 8.3) is treated like `left`: only the new judge `to` is notified |
| `PausedChanged{paused:false}` | `row.waitingOn` members that are roster `active` or `writing` | `resumed` | Notified (U1): "game resumed, it is your turn". Resolves open question 14 |
| `PausedChanged{paused:true}` | none | | HLD: no notice while paused (row has `paused: true`) |
| `Reminder` | `event.waitingOn` that are roster `active` or `writing` **and** in live `waitingOn` while live `episode == event.episode` and live `episodeGen == event.episodeGen` | `reminder_write` (any player in status `writing`: WRITING, or a late joiner during PLAYING), `reminder_play` (non-judge), `reminder_judge` (the judge) | Notified (HLD amended, U1) |
| `RoundVoided` | none | | Followed by `RoundOpened` |
| `PlayerJoined`, `PlayerFinishedWriting`, `PlayerActivated`, `HandRedrawn`, `SubmissionConfirmed`, `VoteCast`, `SettingsUpdated`, `CardRemoved`, `PlayStarted` | none | | Not in `NOTIFY_EVENTS`. A late joiner (WRITING or PLAYING) is already in the app (no push); while in status `writing` they are added to `waitingOn` without changing the episode or anyone's `waitingSince` (LLD 1 4.2), so reminders include them. A late joiner in PLAYING is activated at the next `RoundOpened` after finishing writing and appears in its `expected`, so they get `turn` there; a paused-recovery activation sits out the round and gets nothing |
| `PlayerLeft`, `PlayerRemoved`, `GameCreated`, `GameDeleted`, `DeckImported` | none (the two removal events only trigger cleanup, 2.4) | | Nobody newly waits on anything |

Every "newly waited-on" transition in the engine maps to one row above: writing start, round open, close of submissions, judge change (both parties), and resume. A player who becomes waited-on any other way (a late join in any phase) is already looking at the app.

Spectators and unseated hosts never have `pushSubs` (registration rejects them) and are never recipients (NT3).

### 3.3 One push per recipient per version (`planVersion`)

One command can emit several qualifying rows (`WinnerPicked` then `RoundOpened`; `JudgeChanged` then `RoundOpened` in the void case; `PlayerActivated` events sit between them, so row ids are not contiguous). A recipient must not get two pushes for one commit: with a per-game `tag`, the second would replace the first, and the result notice would be erased the instant the turn notice arrived. So planning is done once per **version** over all of its rows, and each row delivers only the plans it won.

```ts
export type NotifKind = "write" | "turn" | "turn_after_result" | "judge" | "judge_now" | "judge_assigned" | "owe_card" | "resumed" | "result" | "game_over"
                      | "game_ended" | "reminder_write" | "reminder_play" | "reminder_judge";
export interface Plan { uid: Uid; playerId: PlayerId; kind: NotifKind; round: number | null; rowId: string }   // rowId = the winning row; dedupe key is `${rowId}_${uid}`
export interface Live { episode: string | null; episodeGen: number; waitingOn: PlayerId[] }   // masked read, Reminder rows only (5.3)
type By = Partial<Record<"write"|"turn"|"result"|"judge"|"judge_now"|"judge_assigned"|"owe_card"|"resumed"|"game_over"|"game_ended", string>>;

export function planVersion(rows: OutboxRow[] /* same gameId and version, topic notify, no Reminder; no live read */): Plan[] {
  const cands = new Map<Uid, { pid: PlayerId; round: number | null; by: By }>();
  const add = (r: OutboxRow, pid: PlayerId, k: keyof By, round: number | null) => {
    const m = r.roster.find((x) => x.playerId === pid);
    if (!m || (r.paused && k !== "game_ended")) return;                   // departed or paused: no recipient (NT2); a host may end a paused game
    const c = cands.get(m.uid) ?? { pid, round, by: {} }; c.by[k] ??= r.id; cands.set(m.uid, c);
  };
  for (const r of rows) {
    const e = r.event, active = r.roster.filter((x) => x.status === "active");
    switch (e.t) {
      case "WritingStarted":    r.roster.filter((x) => x.status === "writing").forEach((x) => add(r, x.playerId, "write", null)); break;
      case "PausedChanged":     if (!e.paused) r.waitingOn.filter((p) => r.roster.some((x) => x.playerId === p && (x.status === "active" || x.status === "writing"))).forEach((p) => add(r, p, "resumed", r.round?.number ?? null)); break;
      case "RoundOpened":       e.expected.filter((p) => active.some((a) => a.playerId === p)).forEach((p) => add(r, p, "turn", e.round)); break;
      case "SubmissionsClosed": if (active.some((a) => a.playerId === e.judgeId)) add(r, e.judgeId, "judge", e.round); break;
      case "WinnerPicked":      r.roster.forEach((x) => add(r, x.playerId, "result", e.round)); break;   // all seated, incl. late joiners still writing (K-D)
      case "GameFinished":      r.roster.forEach((x) => add(r, x.playerId, "game_over", null)); break;
      case "GameEnded":         r.roster.forEach((x) => add(r, x.playerId, "game_ended", null)); break;  // roster = seated players only (K-D)
      case "JudgeChanged":                                                 // all inputs are on the row: no live read
        if (r.judgeId === e.to && r.round?.number === e.round) add(r, e.to, r.round.phase === "JUDGING" ? "judge_now" : "judge_assigned", e.round);
        if (e.reason === "passed" && r.round?.number === e.round && r.round.phase === "SUBMITTING" && r.waitingOn.includes(e.from)) add(r, e.from, "owe_card", e.round);
        break;
    }
  }
  return [...cands].map(([uid, c]) => {
    const b = c.by;                                                        // precedence, highest first
    const [kind, rowId] = b.game_ended ? ["game_ended", b.game_ended] : b.game_over ? ["game_over", b.game_over] : b.turn && b.result ? ["turn_after_result", b.turn]
      : b.judge ? ["judge", b.judge] : b.judge_now ? ["judge_now", b.judge_now] : b.judge_assigned ? ["judge_assigned", b.judge_assigned]
      : b.turn ? ["turn", b.turn] : b.write ? ["write", b.write] : b.owe_card ? ["owe_card", b.owe_card] : b.resumed ? ["resumed", b.resumed] : ["result", b.result!];
    return { uid, playerId: c.pid, kind: kind as NotifKind, round: c.round, rowId };
  });
}
```

Consequences, all covered by tests: a non-judge player in a resolved round gets one `turn_after_result` push; the new judge and any late joiner still writing get `result`; at game end everyone seated (writers included) gets `game_over` only; a host-ended game sends `game_ended` to everyone seated, paused or not; a void-pass sends `turn` and no `owe_card`; a pass during SUBMITTING sends the new judge `judge_assigned` and the old judge `owe_card`, and a pass during JUDGING sends the new judge `judge_now`; an unpause sends `resumed` to exactly the waited-on players; `WritingStarted` sends `write` to writers only. `planReminder(row, live)` is the separate pure function for `Reminder` rows (section 5.3).

The handler loads sibling rows with `outbox.where("version", "==", v)` (at most 6 documents; `version` has the automatic single-field index). It loads `live` (one masked read) only for `Reminder` rows.

### 3.4 Payload

```ts
export interface PushMessage { token: string; data: Record<string, string>; webpush: { headers: { TTL: string; Urgency: "high" | "normal"; Topic: string } } }

export function buildMessage(p: Plan, gameId: GameId, token: string): PushMessage {
  const c = COPY[p.kind];
  return {
    token,
    data: { v: "1", kind: p.kind, gameId, ...(p.round ? { round: String(p.round) } : {}),
            title: c.title, body: c.body, tag: `g-${gameId}`, url: `/g/${gameId}` },
    webpush: { headers: { TTL: String(c.ttlSec), Urgency: c.urgency, Topic: topicFor(gameId) } },
  };
}
export const topicFor = (gameId: GameId) => base64url(sha256(`dc-topic:${gameId}`)).slice(0, 22);   // Web Push Topic: at most 32 URL-safe chars
```

| Property | Value | Rationale |
|---|---|---|
| Message type | **Data-only** (`data`, no `notification`) | One code path in the worker for all platforms; click handling and `renotify` are ours; copy is server-owned so a stale cached client still shows current text |
| Allowed `data` keys | exactly `v, kind, gameId, round?, title, body, tag, url` (NT1) | A closed set the anonymity test can enforce |
| Replacement | `tag = g-{gameId}` (visible, per game) and `Topic` (undelivered, at the push service) | A phone offline for a day receives only the latest state of each game, which is what matters |
| `TTL` | write, turn, judge, resumed, result, game over, game ended: 72 h; reminders: 12 h | A turn notice is still useful after a weekend away; a reminder older than half a day is noise |
| `Urgency` | `high` for `turn`, `turn_after_result`, `judge`, `judge_now`, `judge_assigned`, `owe_card`, `resumed`; `normal` for the rest (`write`, `result`, `game_over`, `game_ended`, reminders) | High urgency is what gets Android out of Doze for the "your turn" notices; results and reminders can wait |
| Deep link | relative `/g/{gameId}`, no fragment | Never carries the rejoin secret (LLD 4 ID4) |

Never in a payload, log or `notifLog`: card text or ids, display names, `playerId` of any other player, uids, `roomCode`, tokens, the winner or judge identity, scores. The same holds for the outbox rows that feed it (C-EV, NT13): a row carries ids of roster members, phase, round number and `waitingOn` ids, and **no `seed`, `actorPlayerId`, `commandType` or card id**. Events that mint or author cards (`PlayerFinishedWriting`, `DeckImported`, write-ins) are not in `NOTIFY_EVENTS` and never reach an outbox row, so nothing a consumer stores or logs can reveal authorship of a pooled card. `waitingOn` in WRITING (and, for late joiners, in PLAYING) lists who has not finished writing, which every player's view already shows.

### 3.5 Copy (English only)

Generic strings, no names (rationale: lock-screen exposure, the profanity-off mode, and N2 by construction). Keyed by `kind` in `copy.ts`; adding a locale later needs a per-device `lang` on `PushDevice` and a second table.

| `kind` | Title | Body |
|---|---|---|
| `write` | Time to write | The game has started. Write your cards. |
| `turn` | Your turn | A new green card is up. Pick a red card to play. |
| `turn_after_result` | Your turn | The last round has a winner and a new green card is up. Pick a card to play. |
| `judge` | Time to judge | All the cards are in. Pick your favorite. |
| `judge_now` | Time to judge | Judging was passed to you and all the cards are in. |
| `judge_assigned` | You're judging | Judging was passed to you. The cards are still coming in. |
| `owe_card` | Your turn | Judging moved on, so this round is waiting for your card. |
| `resumed` | Game resumed | The game is going again and it's waiting on you. |
| `result` | Round result | The round has a winner. Open the game to see who played what. |
| `game_over` | Game over | The game has a winner. Open it to see the final result. |
| `game_ended` | Game ended | The host ended the game. |
| `reminder_write` | Reminder | The game is waiting for you to finish writing your cards. |
| `reminder_play` | Reminder | A round is still waiting for your card. |
| `reminder_judge` | Reminder | Your friends are waiting for you to pick a winner. |

Copy never mentions the judge or winner by name, so a push never reveals who played what before the result.

## 4. Delivery, dedupe, retry, pruning

### 4.1 Dedupe record (N1)

```ts
// games/{gameId}/notifLog/{rowId}_{uid}   server-only, TTL 30 days (`expiresAt`, LLD 3 2.6); ids only
interface NotifLogDoc {
  gameId: GameId; rowId: string; uid: Uid; playerId: PlayerId; kind: NotifKind;
  status: "pending" | "retry" | "done";
  devices: Record<string /* deviceId */, "ok" | "dead" | "retry" | "lost">;
  attempts: number; claimedAt: number; updatedAt: number; expiresAt: Timestamp;
}
```

`eventId` in the tech-stack text is the outbox `rowId` (`v{version}_{i}`), stable across retried commit transactions (LLD 3 section 8). The doc id keeps the `{eventId}_{uid}` form decided in tech-stack section 6.

### 4.2 Claim before send

One transaction per recipient, run before any FCM call:

```ts
type Claim = { send: Record<string, string /* deviceId -> token */>; log: NotifLogDoc } | { skip: "no_devices" | "superseded" | "min_gap" | "dedupe_done" | "dedupe_inflight" };

async function claim(db: Firestore, now: number, row: OutboxRow, p: Plan): Promise<Claim> {
  return db.runTransaction(async (tx) => {
    const subRef = db.doc(`pushSubs/${p.uid}_${row.gameId}`), logRef = db.doc(`games/${row.gameId}/notifLog/${p.rowId}_${p.uid}`);
    const [sub, log] = await Promise.all([tx.get(subRef), tx.get(logRef)]);
    const devs = (sub.get("devices") ?? {}) as Record<string, PushDevice>;
    if (Object.keys(devs).length === 0) return { skip: "no_devices" };
    const superseded = (sub.get("lastNotifiedVersion") ?? 0) > row.version;   // a newer notice already went out (NT4)
    if (log.exists) {                                                      // duplicate or retried trigger
      const l = log.data() as NotifLogDoc;
      if (l.status === "done") return { skip: "dedupe_done" };
      if (l.status === "pending" && now - l.claimedAt < STALE_CLAIM_MS) return { skip: "dedupe_inflight" };   // another invocation is sending; NOT done (4.3)
      if (superseded) { tx.update(logRef, { status: "done", updatedAt: now }); return { skip: "superseded" }; }   // retries are superseded too
      const todo = Object.entries(devs).filter(([id]) => l.devices[id] !== "ok" && l.devices[id] !== "dead");
      tx.update(logRef, { status: "pending", claimedAt: now, attempts: l.attempts + 1 });
      return { send: Object.fromEntries(todo.map(([id, d]) => [id, d.token])), log: l };
    }
    if (superseded) return { skip: "superseded" };
    const reminder = p.kind.startsWith("reminder");                       // gap from the previous reminder claim of this (player, game), at delivery time
    if (reminder && sub.get("lastReminderAt") !== null && now - sub.get("lastReminderAt") < REMINDER_MIN_GAP_MS) return { skip: "min_gap" };
    const doc: NotifLogDoc = { gameId: row.gameId, rowId: p.rowId, uid: p.uid, playerId: p.playerId, kind: p.kind, status: "pending", devices: {},
                               attempts: 1, claimedAt: now, updatedAt: now, expiresAt: ttl(now, 30) };
    tx.create(logRef, doc);
    tx.update(subRef, { lastNotifiedVersion: Math.max(row.version, sub.get("lastNotifiedVersion") ?? 0), ...(reminder ? { lastReminderAt: now } : {}), updatedAt: now });
    return { send: Object.fromEntries(Object.entries(devs).map(([id, d]) => [id, d.token])), log: doc };
  });
}
```

- **Creation precedes send.** If the process dies after the claim and before the send, the claim is `pending`; after `STALE_CLAIM_MS` (120 s) the next attempt resends the devices not yet marked `ok`/`dead`. In the narrow window where FCM accepted the message but the log was not updated, that resend duplicates a message, but the same `tag` and `Topic` make the browser show one notification. N1 is therefore stated as at most one **visible** notification per `(row, recipient)` (section 9).
- **In-flight claims are not done.** `dedupe_inflight` means another invocation of the same row holds a fresh claim (only the row that won a plan delivers it, 3.3, so the claim is always this row's). It never marks the row processed: the row stays eligible until that claim is finalized (`done`/`retry`) or recovered. Recovery rule: a `pending` claim older than `STALE_CLAIM_MS` is taken over by the next invocation; the hourly redrive (4.6, rows older than 10 min, well past 120 s) guarantees that next invocation if the owner died.
- **Supersession applies to retries.** The `lastNotifiedVersion` check (NT4) runs for an existing `retry` or stale `pending` log as well as for a new claim; a superseded retry is finalized `done` without sending.
- **No devices, no log.** A recipient without devices creates no `notifLog` doc and no write.
- **Reminder gap at delivery.** `REMINDER_MIN_GAP_MS = 24 h` is checked against `lastReminderAt`, the claim time of the previous reminder for this `(player, game)`, using the delivery-time `now`; so a delayed `Reminder` row (platform retry, redrive) cannot land within 24 h of the previous reminder (N3). A row skipped this way is not resent; the next reminder follows the Engine's clock. Normal cadence is about 25 h between claims (5.4), so the check bites only on delays or bugs.

### 4.3 Send, retry and partial failures

```ts
export async function deliver(d: Deps, row: OutboxRow, p: Plan): Promise<"done" | "retry" | "inflight"> {
  const c = await claim(d.db, d.clock(), row, p);
  if ("skip" in c) { log.info({ event: "notify.dedupe", reason: c.skip, gameId: row.gameId, kind: p.kind }); return c.skip === "dedupe_inflight" ? "inflight" : "done"; }
  const badArg: string[] = [];
  let pending = c.send; const result: NotifLogDoc["devices"] = { ...c.log.devices };
  for (let attempt = 0; attempt <= BACKOFF_MS.length && Object.keys(pending).length; attempt++) {    // BACKOFF_MS = [1000, 4000]; jittered
    if (attempt) await d.sleep(BACKOFF_MS[attempt - 1]! * (0.75 + Math.random() * 0.5));
    const ids = Object.keys(pending);
    const res = await d.sender.sendEach(ids.map((id) => buildMessage(p, row.gameId, pending[id]!)));
    const next: Record<string, string> = {};
    res.forEach((r, i) => {
      const id = ids[i]!;
      if (r.ok) { result[id] = "ok"; log.info({ event: "push.result", result: "sent", kind: p.kind }); }
      else if (r.code === "not-registered" || r.code === "invalid-token") { result[id] = "dead"; }
      else if (r.code === "invalid-argument") { result[id] = "lost"; badArg.push(id); }           // never pruned; counted and alerted (4.4)
      else if (r.code === "transient" || r.code === "quota") { result[id] = "retry"; next[id] = pending[id]!; }
      else { result[id] = "lost"; log.error({ event: "push.result", result: "failed", code: r.code }); }   // auth/unknown: operator problem, not retryable per device
    });
    pending = next;
  }
  reportInvalidArgument(row, p, badArg, Object.keys(c.send).length);       // 4.4: logs only, prunes nothing
  await pruneDead(d, row.gameId, p.uid, result, c.send);                   // only `dead` devices
  const retry = Object.values(result).includes("retry");
  await d.db.doc(`games/${row.gameId}/notifLog/${p.rowId}_${p.uid}`).update({ devices: result, status: retry ? "retry" : "done", updatedAt: d.clock() });
  return retry ? "retry" : "done";
}
```

- Devices are sent independently, so one recipient's three devices can end `ok`, `dead`, `retry`. Only the `retry` devices are resent on the next attempt; `ok` devices are never resent (NT5).
- `handleNotifyRow` runs all recipients with `Promise.allSettled`, so one recipient's failure never blocks another's (N4). If any recipient returned `retry` or rejected with an infrastructure error, it throws after all have settled, and the platform retries the trigger with exponential backoff (10 s to 10 min). The retried invocation finds finished recipients `done` (dedupe hit) and resumes only the rest.
- The row is marked `processedAt` (and `notifDoneAt`) only when every recipient is `done`. If some recipient is `inflight` (and none is `retry`), the invocation returns without throwing and without marking the row: the invocation holding the claim marks the row when it finishes, and if it died, the hourly redrive re-runs the row after the claim has gone stale (4.2). An `inflight` result therefore never burns platform retries or poison attempts by itself.

### 4.4 Dead tokens and `invalid-argument`

| FCM / Admin error code | Class | Action |
|---|---|---|
| `messaging/registration-token-not-registered`, `messaging/invalid-registration-token` | `not-registered`, `invalid-token` | Device `dead`; the token is removed from the doc in a transaction that checks the stored token still equals the failed one (a concurrent rotation is not undone); the doc is deleted if no devices remain. Log `push.result` `pruned` |
| `messaging/invalid-argument` | ambiguous: bad token **or** a malformed payload | **Never pruned**, even when it is the recipient's only device. The device is `lost` for this `(row, recipient)` (not resent) and stays registered. `reportInvalidArgument` logs `push.result` with `result=invalid_argument` per device (counted by `dc_push_invalid_argument_total`, alerted in 7.3); if **every** attempted token (at least 2) of the invocation returned it, it also logs `notify.payload_invalid` at error severity (Error Reporting), since a payload bug is the likely cause. A token that is truly dead is pruned later when FCM reports it `registration-token-not-registered` |
| `messaging/internal-error`, `server-unavailable`, `unavailable`, `message-rate-exceeded`, `device-message-rate-exceeded`, quota | `transient`, `quota` | In-process backoff, then platform retry |
| `messaging/third-party-auth-error`, `messaging/sender-id-mismatch`, anything else | `auth`, `unknown` | Device `lost` (no retry); error logged; the failed-share alert (LLD 0) catches a systemic cause such as a wrong VAPID or sender id |

`sender-id-mismatch` means the token belongs to another Firebase project (for example a staging token sent to prod). It is treated as `invalid-token` and pruned if it appears on a single token, and as a systemic error if it appears on all. Pruning happens only for `registration-token-not-registered`, `invalid-registration-token` and this single-token `sender-id-mismatch` case; no other code ever removes a device.

### 4.5 The `PushSender` port

```ts
export type PushErrorCode = "not-registered" | "invalid-token" | "invalid-argument" | "transient" | "quota" | "auth" | "unknown";
export type PushResult = { ok: true } | { ok: false; code: PushErrorCode };
export interface PushSender { sendEach(msgs: PushMessage[]): Promise<PushResult[]> }   // order-preserving; never throws for per-message errors
```

`FcmSender` wraps `getMessaging().sendEach` (HTTP v1, batches of at most 500) and maps `messaging/*` codes per the table above. `FakeSender` is selected only when `FUNCTIONS_EMULATOR === "true"` and `PUSH_SENDER=fake` (same gate as LLD 0's emulator-only clock): it appends every message to `testPushLog/{auto}` and reads scripted outcomes from `testPushScript/{token}` (`{outcomes: PushErrorCode|"ok"[]}`, consumed in order), so an integration test running outside the Functions process can both observe sends and inject failures. Those two collections exist only in the emulator; the production rules deny everything unlisted.

### 4.6 Poison rows and redrive

- `handleNotifyRow` increments `notifAttempts` on the outbox row (transactionally, on the fresh row) at the start of each invocation. At `notifAttempts > MAX_ATTEMPTS` (5) the row is marked `processedAt = now, poisonedAt = now`, `notify.poison` is logged at error severity (alert, section 7.3), and the invocation returns success so the platform stops retrying. Recipients already `done` were notified; the rest are lost. This bounds the cost of any bug triggered by one row (NT7).
- `notifAttempts`, `poisonedAt`, `notifSkipped` and `notifDoneAt` are optional `OutboxRow` fields declared by LLD 3 (C-OUTBOX, open question 4, resolved). `id` on the row is the document id, so handlers need not carry it separately.
- `housekeeping` (hourly, minute 37) runs three independent steps, each in its own try/catch so a failure in one never blocks the others:
  1. **Outbox redrive.** `collectionGroup("outbox").where("processedAt","==",null).where("at","<", now - 10 min).orderBy("at").limit(200)` (index in LLD 3 section 4). Rows are dispatched by `topic`: `notify` to `handleNotifyRow`; `identity` to LLD 4's exported `handleIdentityRow(db, gameId, rowId)` (revocation work, writes `processedAt`; C-IDHANDOFF) followed by this module's idempotent push cleanup (2.4), which sets `notifDoneAt` only. A second query, independent of `processedAt`, selects identity rows whose push cleanup is still owed: `collectionGroup("outbox").where("topic","==","identity").where("notifDoneAt","==",null).where("at","<", now - 10 min).orderBy("at").limit(200)` (index declared in LLD 3 section 4; LLD 3 writes `notifDoneAt: null` at row creation so the equality matches). Each such row gets only the push cleanup, so a cleanup that failed after LLD 4 already set `processedAt` is still retried. Stale rows (section 3.1) are expired, not sent.
  2. **Deletion redrive.** `deletions where status == "running" and heartbeatAt < now - 15 min` calls LLD 3's `runDeletion` (LLD 3 6.4).
  3. Optional tombstone sweep for LLD 4 (conflict 3): not built in v1.

## 5. Scheduler

### 5.1 Design and reconciliation with HLD T1

`reminderDueAt` is written **only by the Engine**, inside `decide`/`settle`, as part of a returned `Game` (LLD 1 4.2, X8; LLD 3 ST12). It is set to `waitingSince + 24 h` when a wait episode starts and to `null` when no episode exists (paused, FINISHED, ENDED, LOBBY). Since U1 an episode also exists in WRITING (C-WRITING): `waitingOn` in WRITING is the seated players with status `writing`, and `waitingSince` the writing start (LLD 1 4.2, the single definition). A late joiner in status `writing` is added to `waitingOn` in any phase (WRITING or PLAYING) without changing the episode or the `waitingSince` of others. Each episode carries a generation number `episodeGen`, incremented every time an episode starts (including after an unpause), so two successive episodes of the same kind (for example WRITING before and after a pause) are distinguishable; reminder rows and the sweep compare `episodeGen`, not only the episode kind. After a reminder the Scheduler asks the Engine to advance it by running the system command `markReminded` through the Store's `runCommand`, which writes the new `reminderDueAt` and, in the same transaction, one `Reminder` outbox row. This is LLD 3 section 7 unchanged. Final design, in one line each:

| Concern | Who | How |
|---|---|---|
| Start and reset of the 24 h clock | Engine `settle` | New episode (and `episodeGen + 1`) on writing start, round open, close, judge change, void, un-pause (not on a submission or a finished writer; a late joiner in status `writing`, in any phase, is added to `waitingOn` of the running episode) |
| Find due games | Store `listWaitingOn` | `reminderDueAt <= now`, keyset pages of 100, single-field index; each item carries `episode` and `episodeGen` |
| Advance the clock and record the intent | Engine `markReminded` via `runCommand`, `idemKey = remind:{episode}:{dueAt}` | One CAS transaction; `episode`, `episodeGen` and `now >= reminderDueAt` are rechecked inside |
| Send | `notifyOutbox` on the `Reminder` row | Same path as turn notices |

The Scheduler therefore never edits a game field itself, but it does cause one Engine-decided state change (a `version` bump with no event and no view write). T1 is reworded accordingly (section 9).

### 5.2 Cadence and function

```ts
export const reminderSweep = onSchedule(
  { schedule: SWEEP_CRON /* param REMINDER_SWEEP_CRON, default "7 * * * *" */, timeZone: "Etc/UTC", timeoutSeconds: 300, retryCount: 0, memory: "256MiB", serviceAccount: FN_RUNTIME },
  () => runSweep(deps));

export async function runSweep(d: Deps): Promise<SweepStats> {
  const t0 = d.clock(), now = t0, st = { pages: 0, listed: 0, sent: 0, replayed: 0, noop: 0, failed: 0 };
  let after: WaitingPage["next"] = null;
  do {
    const page = await listWaitingOn(d.db, { now, limit: 100, after });
    st.pages++; st.listed += page.items.length;
    await pool(10, page.items, async (g) => {
      if (d.clock() - t0 > SWEEP_BUDGET_MS) return;                      // 240 s; the remainder is next hour's work (level-triggered)
      try {
        const o = await d.runCommand({ gameId: g.gameId, cmd: { type: "markReminded", episode: g.episode, episodeGen: g.episodeGen }, actor: { kind: "system" }, idemKey: `remind:${g.episode}:${g.dueAt}` });
        if (o.kind !== "accepted") st.noop++; else if (o.replay) st.replayed++; else if (o.version > g.version) st.sent++; else st.noop++;
      } catch (e) { st.failed++; log.error({ event: "reminder.sweep.game_failed", gameId: g.gameId }); }
    });
    after = page.next;
  } while (after && st.pages < MAX_PAGES && d.clock() - t0 < SWEEP_BUDGET_MS);   // MAX_PAGES = 20: 2000 games per run
  log.info({ event: "reminder.sweep.done", ...st, latencyMs: d.clock() - t0 });
  return st;
}
```

- Hourly, at minute 7 (off the top of the hour, when other schedulers cluster), UTC. The cadence has no time-zone semantics: reminders are "24 h after the episode began", not "daily at 9 am". LLD 0's "no `reminder.sweep.done` for 3 h" alert stays valid.
- `now` is read once from the injected `deps.clock()` (the same emulator-only override as LLD 0 section 6), so time-travel tests drive the sweep (T3). The Engine receives its own `ctx.now` from the Store's clock inside `runCommand`; both read the same injected clock in tests.
- `sent` is an upper bound (a game that changed between listing and the command can count as sent while the Engine no-oped it); the exact reminder volume comes from `notify.row.done` with `kind` reminder (section 7.2).

### 5.3 Who is waited on, and reminder recipients

| Phase | `waitingOn` (Engine) | Reminded |
|---|---|---|
| WRITING | seated players with status `writing`, including late joiners (added without resetting `waitingSince`) | Yes: `reminder_write` (open question 1, resolved) |
| PLAYING, SUBMITTING | expected non-judge players without a submission, plus any late joiner still in status `writing` | Yes: `reminder_play`; `reminder_write` for the late joiner |
| PLAYING, JUDGING | the judge, plus any late joiner still in status `writing` | Yes: `reminder_judge`; `reminder_write` for the late joiner |
| paused, FINISHED, ENDED, LOBBY | irrelevant | No (`episode == null`); on unpause a `resumed` push goes to the waited-on players and a new episode starts |

```ts
export function planReminder(row: OutboxRow & { event: { t: "Reminder" } }, live: Live | null): Plan[] {
  if (row.paused || !live || live.episode !== row.event.episode || live.episodeGen !== row.event.episodeGen) return [];   // moved on: nothing is owed any more (NT10)
  const kindOf = (pid: PlayerId, status: string): NotifKind => !row.round || status === "writing" ? "reminder_write"
    : pid === row.judgeId && row.round.phase === "JUDGING" ? "reminder_judge" : "reminder_play";
  return row.event.waitingOn
    .filter((pid) => live.waitingOn.includes(pid))
    .flatMap((pid) => { const m = row.roster.find((x) => x.playerId === pid && (x.status === "active" || x.status === "writing")); return m
      ? [{ uid: m.uid, playerId: pid, kind: kindOf(pid, m.status), round: null, rowId: row.id }] : []; });
}
```

A player who submitted (or finished writing) between the sweep and the fan-out is dropped by the live `waitingOn` intersection, so reminders go only to players the game is currently waiting on (N3). This is the one remaining live read; the `round` and `waitingOn` on the row fix the kind and the candidate set at commit time.

### 5.4 Once per 24 h (N3), quiet hours, drift

- **Structural guarantee.** Within one episode, successive `Reminder` rows are at least 24 h apart because `markReminded` sets `reminderDueAt = now + 24 h` and the sweep acts only when `now >= reminderDueAt`. A new episode restarts the clock at `waitingSince + 24 h`, so a reminder in a new episode cannot fire within 24 h of the notice that started it (every episode start has a push: `write`, `turn`, `judge`, `judge_now`/`judge_assigned`, `owe_card`, `resumed`). A late joiner (WRITING or PLAYING) is the exception: they are reminded when the running episode next falls due, possibly sooner than 24 h after joining, and then every 24 h (open question 17). Across an episode change, a stale due row is rejected inside `markReminded` (episode or `episodeGen` mismatch), and a `Reminder` row whose `episodeGen` no longer matches the live one sends nothing (NT10). The scope of "per player" is per `(player, game)`: a player in three games may get three reminders in one hour (open question 9).
- **Drift.** Because `markReminded` uses `now`, not the old due time, a reminder repeats about every 24 h plus up to 1 h of sweep lag (average 24.5 h). Acceptable. After an outage or a skipped sweep, a game gets **one** reminder when sweeps resume, never a catch-up burst (the due time is simply in the past once).
- **Quiet hours: none in v1.** The server does not know a player's time zone, a reminder lands 24 h after a notice the player already received at that hour, and OS Do Not Disturb applies. A future version can record `tzOffsetMin` per `PushDevice` and have `deliver` defer; it needs an LLD 5 contract change (open question 8).
- Delivery-time guard: `lastReminderAt` on `pushSubs` and `REMINDER_MIN_GAP_MS` (24 h) in `claim` (4.2), measured from the previous reminder claim, so a delayed row cannot break N3.

### 5.5 Idempotency, scale and cost

- **Sweep twice (T2).** A replayed key (`remind:{episode}:{dueAt}`) hits the idempotency ledger and writes nothing; after the first commit `reminderDueAt` is in the future, so the second sweep does not list the game. Two concurrent sweeps contend on the aggregate transaction; the loser re-reads, sees the advanced `reminderDueAt` (or the ledger doc) and no-ops. Net: one `Reminder` row, one push per recipient (N1, N3).
- **Batching and timeout.** 100 games per page, 10 in flight, 20 pages, a 240 s budget inside a 300 s function. At about 100 ms per `markReminded` and 10 in flight, 2000 games take about 20 s. Whatever is left is picked up next hour (the query is level-triggered).
- **Scale model.** Assume 1,000 games waiting more than a day at once (far above a friends-and-family app). Daily: about 1,000 `Reminder` rows. Sweep reads: 24 empty-or-small list queries plus 1,000 listed documents, plus about 2 reads and 3 writes per `markReminded`. Fan-out per reminder: 1 live read, 1 pushSubs read per recipient (about 4), 1 claim transaction and 1 finalize write per recipient. Approximately 12,000 reads and 14,000 writes per day, under one US cent per day at Firestore list prices, and inside the free daily quota. An idle system costs 24 reads per day. Cloud Scheduler jobs: two (`reminderSweep`, `housekeeping`), within or near the free tier. FCM is free.

## 6. Preferences, permission state and fallback

**Preferences (minimal v1, decided).** gameplay.md defines no mute or opt-out, so there is none server-side: no global switch, no per-game mute. The registered device list **is** the preference. Turning notifications off on a device is `unregisterPush` for each game it holds; turning them on is the same registration flow. A local "off for this game" flag in the client stops it re-registering on open. A mute can be added later as one `muted` flag on `PushSubDoc` checked in `claim` (no contract change beyond a new callable).

**What the server knows versus the client (C4).**

| Fact | Known to server? | Source of truth |
|---|---|---|
| Browser permission state (`granted`, `denied`, `default`) | No | Client `Notification.permission` |
| Whether a token exists | Yes (devices registered) | |
| Whether a token still works | Only after a send fails | FCM errors prune it (4.4) |
| iOS install state | No | Client (`navigator.standalone` or `display-mode: standalone`) |
| Whether a notification was actually displayed or read | No | Service worker |

If the user later denies permission, the browser unsubscribes and FCM reports the token as not registered on the next send, which prunes it. The client should also call `unregisterPush` when it observes `denied` on open.

**iOS requirement (R3).** Web push on iOS and iPadOS needs 16.4 or later, the site installed to the Home Screen, and permission requested from a gesture inside the installed app. In a plain Safari tab `PushManager` is unavailable, so no token ever exists and the server simply sees a seat with zero devices. The server can do nothing else: it cannot detect, prompt or substitute (email is out, N5). The client onboarding (LLD 7) owns the install prompt; the server stays correct either way (C4: the app still shows "your turn" on open).

**"Notifications not reaching you" fallback (client-local, no new server API).** The server cannot signal this: pushes are fire-and-forget, `pushSubs` is unreadable by clients, and views carry no push data (LLD 2 Interfaces). The contract for LLD 7:

1. The service worker records `{gameId, round, kind, at}` in IndexedDB for every push it displays (`receipts`).
2. The page derives a status: `unsupported`, `ios_needs_install`, `permission_denied`, `permission_default`, `registration_failed` (last `registerPush` errored), `registered`.
3. For the first five, show a persistent "Turn on notifications" or "Notifications are off" banner with the specific fix.
4. For `registered`: when the app is opened and the viewer is newly waited on (their `waitingOn` flipped to true since the last open) but no receipt exists for that game with `at` after the device's `lastSeenAt` for it, count a "missed notice". This is evaluated only at the first server snapshot of a page load; transitions seen live while the app is open never count (reconciled with LLD 7 section 8, which interpreted the earlier "within the preceding 15 minutes": a turn that began two days ago has no receipt in the 15 minutes before an open, so a fixed window would always misfire). After 2 consecutive missed notices, show "Turn alerts don't seem to be reaching this device. Check notification settings or re-enable them", with a button that runs `unregisterPush`, `deleteToken`, `getToken`, `registerPush`.

This is a heuristic with false positives (the user opened the app before the notice arrived), which is why it needs two consecutive misses and only ever shows a hint. An optional server-side `testPush` callable is recorded as open question 7.

## 7. Data access, logging, metrics

### 7.1 Collections touched

| Collection | Reads | Writes | Rules |
|---|---|---|---|
| `games/{g}/outbox/*` | trigger snapshot; fresh row; sibling query by `version`; redrive collection-group query | `processedAt`, `notifDoneAt`, `notifAttempts`, `poisonedAt`, `notifSkipped` on `notify` rows; only `notifDoneAt` on `identity` rows (`processedAt` there is LLD 4's) | server-only (LLD 3 row 12) |
| `games/{g}` | masked live read (`Reminder` rows only); `registerPush` membership read | none (all state changes go through `runCommand`) | server-only (row 1) |
| `pushSubs/{uid}_{g}` | claim, fan-out | `registerPush`, `unregisterPush`, claim fields, prune, identity cleanup, `clearSeatPush` | server-only (row 13); LLD 3's cascade deletes by `gameId` |
| `games/{g}/notifLog/*` | claim | claim, finalize | server-only (row 12), TTL 30 days |
| `deletions/*` | housekeeping redrive | via `runDeletion` | server-only |
| `testPushLog`, `testPushScript` | emulator only | emulator only | denied by the final rule |

No new collection, rule or index is introduced beyond LLD 3's. The only outbox query beyond LLD 3's declared ones is `where version == v`, which uses the automatic single-field index (add it to `queries.ts` so the index-registry test in LLD 3 section 4 covers it).

### 7.2 Logs (LLD 0 section 9 conventions)

Events: `notify.row.done`, `notify.dedupe`, `notify.payload_invalid`, `notify.poison`, `push.result`, `reminder.sweep.done`, `reminder.sweep.game_failed`, `outbox.redrive`, `push.register`, `push.unregister`. All use the typed logger; the field set gains `rowId`, `kind`, `recipients`, `devices`, `eventToFcmMs` (open question 7).

| Event | Fields |
|---|---|
| `push.result` (one line per device attempt) | `gameId`, `kind`, `result` in `sent`, `failed`, `pruned`, `invalid_argument` |
| `notify.row.done` | `gameId`, `rowId`, `kind` (the row's event kind), `recipients`, `sent`, `pruned`, `failed`, `skipped`, `eventToFcmMs` (`now - row.at` at the end of the first send), `latencyMs`, `attempts` |
| `reminder.sweep.done` | `pages`, `listed`, `sent`, `replayed`, `noop`, `failed`, `latencyMs` |

**Never logged** (extends LLD 0 P19, LLD 5 section 9): FCM tokens or endpoints, `deviceId`, card text or ids, display names, uids (only `uidHash` if needed), the winner or judge, or any payload `body`. Reminder volume and push counts need only counts and `gameId`.

### 7.3 Metrics and alerts

| Metric (log-based, `ops/metrics/`) | Source | Note |
|---|---|---|
| `dc_push_total{result}` | `push.result` | Existing in LLD 0; delivery success rate is `sent / (sent + failed)` |
| `dc_push_pruned_total` | `push.result` with `result=pruned` | Token prune count |
| `dc_push_invalid_argument_total` | `push.result` with `result=invalid_argument` | New; such tokens are never pruned (4.4) |
| `dc_reminder_sent_total` | `reminder.sweep.done` weighted by `sent` | Existing in LLD 0; an upper bound (5.2) |
| `dc_reminder_push_total` | `notify.row.done` where row kind is `Reminder`, weighted by `sent` | New; exact reminder pushes |
| `dc_notify_dedupe_total{reason}` | `notify.dedupe` | New; duplicate triggers and supersedes |
| `dc_notify_latency_ms` | distribution of `eventToFcmMs` on `notify.row.done` | New; event to FCM |
| `dc_notify_poison_total` | `notify.poison` | New |

New alerts (same channel as LLD 0): any `notify.poison` or `notify.payload_invalid`; `dc_push_invalid_argument_total` above 5 in 1 h; `dc_notify_latency_ms` p95 above 60 s for 30 min; `outbox.redrive` processing more than 20 rows in one run (consumers are failing or slow). LLD 0's push-health alert (failed share above 50 percent over 1 h, at least 20 attempts) and sweep-missed alert apply unchanged.

## 8. Email (N5)

No email notification in v1 (gameplay.md, N5). The seam: delivery is behind `deliver()` per channel, and recipients are resolved by `planVersion`/`planReminder` independent of channel. A later `EmailChannel` would reuse the same `Plan` list and the same `notifLog` dedupe (key `{rowId}_{uid}_{channel}`), but needs an email address and consent per player, which the product does not collect (players have no accounts; the host's email is the host's alone). Nothing in v1 reserves fields for it.

## 9. Amendments to the HLD and tech-stack (exact text)

| Where | New text |
|---|---|
| HLD 3.8 Owns | "Push subscriptions (per seat, per game, up to 5 devices) and a per-(outbox row, recipient) delivery record." (replaces `lastNotifiedFor` and "delivery log") |
| HLD 3.8 trigger table | Replace with "New HLD 3.8 trigger table (exact)" below this table, plus footnotes: "One recipient receives at most one notification per command; `WinnerPicked` merges into the next `RoundOpened` or `GameFinished`." "A player is notified whenever they become newly waited-on, and reminded daily for as long as they remain waited-on, in WRITING, SUBMITTING and JUDGING (a late joiner still writing is reminded in any phase). Nothing is sent while paused, except that ending the game notifies everyone seated; copy is generic (no card text, no names)." |
| HLD N1 | "N1. **At most one visible notification per `(outbox row, recipient)`** (a rare duplicate alert is possible), enforced by a delivery record created before sending, so redelivery of the trigger cannot double-notify. A crash between provider acceptance and the record update may resend once with the same collapse key and tag; the device shows one notification, which may alert twice." |
| HLD N3 | "N3. Reminders only to players the game is currently waiting on (WRITING: unfinished writers; SUBMITTING: non-judge players who have not submitted; JUDGING: the judge), **at most one per 24 h per `(player, game)`**, stopping on pause, finish or end." (adds the per-`(player, game)` scope; section 11 and open question 9) |
| HLD N4 | "... dead subscriptions are pruned when the push provider reports the token unregistered or invalid." (replaces "on 404/410") |
| HLD 3.8 Interface | `onDomainEvent(row)` (outbox trigger), `registerSubscription(uid, gameId, fcmToken, deviceId?)`, `unregisterSubscription(uid, gameId, fcmToken)` |
| HLD T1 | "T1. The Scheduler holds no game logic and never edits game fields itself. Its only write to game state is the Engine's `markReminded` system command, issued through the Store's `runCommand`; it advances the reminder clock and records the reminder intent in the outbox in one transaction." |
| HLD T2 | append: "(a replayed `markReminded` idempotency key writes nothing)" |
| HLD 3.9 Interface | "Periodic job (hourly) calling `Store.listWaitingOn`, then `Store.runCommand(markReminded)` per due game; the resulting `Reminder` outbox row is delivered by Notifications." |
| tech-stack 5 | `pushSubs/{uid}_{gameId}` holds a `devices` map (up to 5 tokens), not one token |
| tech-stack 6, reminders | "... queries games with `reminderDueAt <= now` (automatic single-field index; no composite index), calls `markReminded` per due game, and the `Reminder` outbox row it writes is delivered like any other notification. Reminders cover every phase in which the game waits on someone: WRITING, SUBMITTING and JUDGING." (replaces the `phase`/`paused` filters and the direct advance) |
| tech-stack 6, failure isolation | "Tokens that return `registration-token-not-registered` or `invalid-registration-token` are removed. `invalid-argument` never removes a token; it is counted and alerted." |

**New HLD 3.8 trigger table (exact):**

| Event | Notified | Title |
|---|---|---|
| `WritingStarted` | every player who has cards to write | Time to write |
| `RoundOpened` (the first, and each later round) | the non-judge players (a late joiner is activated into it) | Your turn |
| `SubmissionsClosed` (all submitted, or the judge closed it) | the judge | Time to judge |
| `JudgeChanged` | the new judge ("Time to judge" if all cards are in, else "You're judging"); the old judge only if they now owe a card ("Your turn") | |
| `PausedChanged{paused:false}` | the players the game is waiting on | Game resumed |
| `WinnerPicked` | all seated players, including late joiners still writing (merged into the next `RoundOpened` as "Your turn" for non-judges) | Round result |
| `GameFinished` | all seated players, including late joiners still writing | Game over |
| `GameEnded` (the host ended the game) | all seated players (writing, ready or active), also while paused | Game ended ("The host ended the game.") |
| Daily reminder (`Reminder`) | players the game is currently waiting on in WRITING, SUBMITTING or JUDGING, and late joiners still writing | Reminder |
| pause, `PlayerLeft`, `PlayerRemoved`, `PlayerJoined`, others | nobody | |

tech-stack 6 additionally: "Notifications cover the WRITING phase as well as turns and judging, and the game ending; an episode (and so a `reminderDueAt`) exists in WRITING." The tech-stack 6 dead-token row above is the exact failure-isolation text.

## 10. Tests

Runner and harness follow LLD 0: unit tests in `functions/src/notify/*.test.ts` (`bun test`), integration in `functions/test-integration/notify.test.ts` against the Node bundle with the Auth, Firestore and Functions emulators, `PUSH_SENDER=fake`, and the injected clock.

### 10.1 Unit (pure)

| Subject | Cases |
|---|---|
| `planVersion` recipients | Every row of section 3.2, including: `RoundOpened` excludes the judge, inactive and departed; `WinnerPicked` + `RoundOpened` merges to `turn_after_result` for non-judges and `result` for the new judge; `WinnerPicked` + `GameFinished` yields `game_over` only, including for a late joiner still writing; `WinnerPicked` alone reaches `ready` and `writing` roster members (`result`); `GameEnded` yields `game_ended` for every seated roster member, also from a `paused: true` row, and nobody departed; void pass yields `turn` and no `owe_card`; `WritingStarted` yields `write` for `writing` players only (not `ready`); `JudgeChanged` in `JUDGING` yields `judge_now`, in `SUBMITTING` yields `judge_assigned` to the new judge and `owe_card` to the old judge for `passed` only (left/removed: no `owe_card`); row `round` for another round number yields none; `PausedChanged{false}` yields `resumed` for exactly `row.waitingOn` (active and writing), `{true}` and any `paused` row yield none; precedence merges (`turn`+`result`, `write` never merged away); no function reads Firestore (`planVersion` takes rows only) |
| Property (fast-check) | Over `planVersion` inputs: at most one plan per `uid` (NT3); every `uid` is a seated roster member; the winning `rowId` belongs to the input rows; deterministic |
| `planReminder` | Intersect with live `waitingOn`; episode mismatch yields none; same episode kind but different `episodeGen` (WRITING before and after a pause) yields none; a late joiner in status `writing` during SUBMITTING or JUDGING gets `reminder_write`; judge in JUDGING gets `reminder_judge`; SUBMITTING players `reminder_play`; row without `round` (WRITING) yields `reminder_write` for `writing` players including a late joiner; paused yields none |
| `buildMessage`, copy | `data` keys exactly the allowed set; every `title`/`body` equals the table; header values (`TTL`, `Urgency`, `Topic` of at most 32 URL-safe chars); `url` is `/g/{gameId}` with no `#`; every `NotifKind` has a copy entry |
| `claim` transitions | Table over (log absent, `pending` fresh, `pending` stale, `retry`, `done`) x (devices present or absent) x (superseded or not) x (min gap); a superseded `retry`/stale log is finalized `done` and sends nothing; `pending` fresh yields `dedupe_inflight` and `deliver` returns `inflight` (row not marked); a reminder claimed 23 h 59 m after the previous reminder claim is `min_gap`, at 24 h it proceeds |
| Error mapping | Each `messaging/*` code to `PushErrorCode`; `invalid-argument` never prunes in any case (all bad, one bad among good, single token, only device), logs `invalid_argument`, and all-bad (at least 2) also logs `notify.payload_invalid` |
| `registerSub` guard logic | Device cap eviction; token dedupe across seats; `deviceId` default derivation |

### 10.2 Emulator integration

| Test | Setup | Pass criteria |
|---|---|---|
| Outbox to FCM | Play a 4-player game from `startGame` through `command` | Fake sender receives, per version: at `WritingStarted` every writer gets `write`; judge-less players get `turn`; after the last submission the judge gets `judge`; after `pickWinner` merged kinds per 10.1; each message has its own `tag`, `Topic`, `TTL` |
| Duplicate trigger | Invoke `handleNotifyRow` twice, sequentially and with `Promise.all` | Exactly one message per device; the second run logs `notify.dedupe`; `notifLog` has one doc per recipient (N1) |
| Retry after failure | Script device B of one recipient `["transient","transient","transient","ok"]` (one transient per in-process attempt, `1 + BACKOFF_MS.length` = 3, before success), device A `["ok"]` | First invocation exhausts its in-process attempts and the handler throws; platform-style rerun sends only B, which succeeds; A receives exactly one message; final log `done`; no duplicate (NT5) |
| Crash window | Insert a `pending` log older than 120 s with one device `ok` | Resend only the other devices; fresh `pending` (under 120 s) is skipped as in-flight, the row keeps `processedAt == null`, and after the claim goes stale a `housekeeping` run delivers the rest and marks the row |
| Dead-token pruning | Script `not-registered` for one of three devices; then the only device | That device is removed, others kept; empty doc deleted; later fan-out skips (`no_devices`) |
| `invalid-argument` | (a) one of three tokens, others ok; (b) all tokens; (c) a recipient's only token | Nothing pruned in any case; the devices stay in `pushSubs`; `push.result invalid_argument` logged per device; (b) also logs `notify.payload_invalid`; the row completes (`lost` devices are not retried) |
| Poison | Script a persistent infrastructure error | After 5 invocations the row has `poisonedAt` and `processedAt`; the trigger stops (NT7); commands in the same time window are unaffected (N4) |
| Judge change and unpause | `passJudging` in SUBMITTING and in JUDGING; drop below 3 active players and recover (unpause) in SUBMITTING, JUDGING and WRITING | SUBMITTING: new judge `judge_assigned`, old judge `owe_card`, nobody else; JUDGING: new judge `judge_now` only; pause sends nothing; unpause sends `resumed` to exactly the waited-on players, none to others |
| Superseded and stale | Deliver a version 14 notice, then a delayed version 13 row; a version 13 log left in `retry` before version 14 was claimed, then retried; an outbox row aged 25 h | Version 13 skipped (`superseded`) both as a new claim and as a retry (log finalized `done`, no send); the aged row marked `stale` and never sent (NT4, NT6) |
| Game end and results reach everyone seated | 4 active players and one late joiner still writing in PLAYING; `pickWinner`; then `endGame`, once unpaused and once while paused | The late joiner gets `result` (or `game_over`); `endGame` sends `game_ended` with copy "The host ended the game." to all five, paused or not; departed players get nothing (K-D) |
| Late joiner reminders | A player joins during PLAYING and leaves writing unfinished; others are waited on in SUBMITTING | The joiner enters `waitingOn` without changing others' `waitingSince`; the next due `Reminder` gives them `reminder_write` and the others `reminder_play` |
| Delayed reminder gap | Deliver one `Reminder` row 2 h late (redrive); the next sweep's `Reminder` row of the same episode arrives on time, 23 h after that claim | The second is skipped `min_gap` (no two reminder claims under 24 h apart); the following one is sent (N3, NT9) |
| Registration | Seat, host-with-seat, host without a seat, spectator, removed seat; two seats register the same token; sixth device | Only seated principals succeed; the token moves to the later seat and leaves the earlier doc; the sixth evicts the oldest (NT8) |
| Cleanup | `leave`, `removePlayer`, `deleteGame`; reissue calling `clearSeatPush` | The `pushSubs` doc is gone after the identity row is processed; the cascade leaves no `pushSubs` or `notifLog` for the game |
| Failure isolation (N4) | Script FCM to always fail while a game plays on | Every command succeeds with unchanged latency; only outbox rows fail |
| Sweep idempotency | 250 games due, 50 future, 50 null (LLD 3 fixture); run the sweep twice, and two sweeps in `Promise.all` | One `Reminder` row per due game, `reminderDueAt` advanced once, second run `noop`/`replayed` (T2, NT10) |
| Time travel | Run once for each phase WRITING (two writers unfinished, one late joiner), SUBMITTING and JUDGING. Injected clock: phase starts at `t0`; sweeps at `t0+23h59m`, `t0+24h01m`, same instant again, `t0+25h`, `t0+49h08m`; a submission (or finished writing) by one waited player; pause and unpause; finish; clock jump of 5 days with one sweep | No reminder before 24 h; one at 24 h (`reminder_write`, `reminder_play` or `reminder_judge` by phase); none on the repeat; the next about 24 h after; the submitter or finished writer is excluded; none while paused, `resumed` on unpause and a new episode; none after finish; the 5-day jump yields exactly one reminder (T1, T2, T3, N3) |
| Redrive | Create an unprocessed `notify` row aged 11 min; run `housekeeping` | It is delivered once; an identity row calls the `handleIdentityRow` stub, then the push cleanup, which sets `notifDoneAt` and never `processedAt`; an identity row with `processedAt` set but `notifDoneAt == null` gets the push cleanup only; a deletion job stuck at `running` is resumed |
| Log sentinel (P19) | Full game with sentinel names, card texts, tokens | No sentinel, token or `deviceId` appears in Functions emulator logs |
| Rules | none new | LLD 3's denial matrix rows 12 and 13 already cover `notifLog` and `pushSubs` (ST7 keeps the names in sync) |

### 10.3 Anonymity tests (R1, N2)

Reuses LLD 2's forbidden-values oracle approach (section 11.2 there): scenarios from LLD 1's legal-command generator with unique fixed-width sentinels for names, card texts and drafts, all variants on, 3 to 10 players, membership churn. After every accepted command the harness runs the real `buildOutbox`, `planVersion`/`planReminder`, and `buildMessage`, and captures every `PushMessage`. The oracle inspects the notification payload and every recipient-visible field, `JSON.stringify({ data: message.data, webpush: message.webpush })`, **excluding the transport `token`** (it is the address, never delivered to the device or shown; it is covered by the log sentinel scan instead). It asserts that this contains:

- no card id or text from the registry, no draft text, no display name sentinel;
- no uid, `hostId`, `seat:`, `#k=`, FCM token or other token-like string, room code, or any `playerId`;
- only the allowed `data` keys, and a `title`/`body` pair that is exactly a `COPY` entry (so no dynamic content can enter);
- (visibility oracle) the kind is derivable from the recipient's own `project(game, viewer)` at that version: `write` implies phase `WRITING` and the recipient has unfinished writing; `resumed` implies the recipient is in `waitingOn`; `judge_assigned` implies the recipient is the judge and the round is `SUBMITTING`; `turn` implies the recipient is a non-judge `waitingOn` in an open round; `judge` implies the recipient is the judge and `round.phase == "JUDGING"`; `result` and `turn_after_result` imply a resolved round in `history`; `game_over` implies `phase == "FINISHED"`; `game_ended` implies `phase == "ENDED"`; `reminder_write` implies the recipient has unfinished writing.

Additionally, for every captured outbox row (including those from `finishWriting`, `importDeck` and write-in commands), assert the row has no `seed`, `actorPlayerId`, `commandType` or card-id field, and that no such command produces a row that identifies the author (NT13).

A mutant (a copy that interpolates a winner name, a payload that adds `playerId`, a row that stores the actor) must fail the suite; the same mutant-must-be-detected pattern as LLD 2 section 11.4.

### 10.4 Manual device checklist (staging, before launch; repeated after any service-worker change)

| # | Device | Steps | Expect |
|---|---|---|---|
| 1 | Android Chrome, installed PWA | Join, grant permission from the banner, background and kill the app; another player opens a round | `Your turn` appears within seconds; tap opens `/g/{gameId}` signed in |
| 2 | Android Chrome, plain tab | Same, tab closed | Notification still arrives |
| 3 | iOS 16.4+, Safari tab | Try to enable | No permission prompt offered; install hint shown (R3); the game still shows "your turn" on open (C4) |
| 4 | iOS 16.4+, installed PWA | Enable from a tap; lock the phone; trigger `turn`, then `judge` in another game | Lock-screen text matches the copy table; one notification per game (tag replacement); tap deep-links |
| 5 | Desktop Chrome, Firefox, Safari 16.4+ | Enable, minimize | Same behavior; notification replaced (not stacked) by the next one for the same game |
| 6 | Any | Deny permission, then re-enable in site settings | Banner states correct; after re-enable and reload the device re-registers |
| 7 | Any | Revoke permission in OS settings; trigger a notice; trigger another | First send prunes the dead token (check `push.result pruned`); no errors afterward |
| 8 | Phone offline for a day | Trigger three events in one game | On reconnect only the latest notice is delivered (`Topic` and `tag`) |
| 9 | Two devices, one seat (rejoin link) | Enable on both | Both notify; unregistering one leaves the other |
| 10 | One phone, two seats of one game (host plus second identity) | Register both | Notices go to the last registered seat only (token dedupe, NT8) |
| 11 | Clear site data, reopen | Re-enable | New token registered; old token pruned on first send |
| 12 | Reminder | Leave a round waiting 24 h on staging (or shorten with the emulator-style clock param) | One `Reminder`; not repeated before another 24 h; none after the player submits |

## 11. Invariants

HLD invariants, restated testably:

| Inv | Statement (as amended in section 9 where noted) | Mechanism | Tests |
|---|---|---|---|
| N1 | At most one visible notification per `(row, recipient)` (a rare duplicate alert is possible) | `notifLog/{rowId}_{uid}` created in `claim` before send; stale-claim resend collapses by `tag` and `Topic` | Duplicate trigger, crash window |
| N2 | No card text or hidden data in any notification | Closed payload key set, copy table with no interpolation, ids and counts only in rows | Anonymity tests 10.3, sentinel log scan |
| N3 | Reminders only to players currently waited on (WRITING, SUBMITTING, JUDGING), at most one per 24 h per `(player, game)`, stopping on pause, finish or end | Engine `reminderDueAt` null outside an unpaused wait episode; `markReminded` +24 h; live `waitingOn` intersection (same `episodeGen`); 24 h delivery-time claim guard | Time-travel, sweep tests |
| N4 | Push failure never fails or delays a command | Separate trigger and schedule functions; no push call on the command path; per-recipient isolation | Failure-isolation test |
| N5 | Email only for host sign-in | No email channel built | Code scan: no mail import in `notify/` |
| T1 | Scheduler holds no game logic; writes only via `markReminded` | `sweep.ts` imports only `listWaitingOn` and `runCommand` | Lint rule: `notify/sweep.ts` may not import `firebase-admin/firestore` write APIs; code scan |
| T2 | Sweep twice yields one notification | Idempotency key plus advanced due time | Sweep-twice tests |
| T3 | Time enters only through the injected clock | `deps.clock()` everywhere; `Date.now()` banned in `functions/src/notify` by lint | Time-travel tests |

New invariants (NT):

| Inv | Statement | Mechanism | Tests |
|---|---|---|---|
| NT1 | A push `data` payload has exactly the keys `v, kind, gameId, round?, title, body, tag, url`, and `title`/`body` are a `COPY` entry | `buildMessage` is the only constructor; a type forbids extra keys | Unit, anonymity mutants |
| NT2 | Recipients are seated roster members at row time; no notice from a `paused` row except `game_ended` | `planVersion` roster and `paused` filters | Property test 10.1 |
| NT3 | Spectators, unseated hosts, departed and removed players never receive a push | `registerPush` rejects them; plan filters by roster; identity cleanup | Registration and cleanup tests |
| NT4 | A recipient is never notified of a version older than one already claimed for that seat and game | `lastNotifiedVersion` checked and set in the claim transaction | Superseded test |
| NT5 | A device that returned `ok` is never resent the same `(row, recipient)` | Per-device status map in `notifLog` | Retry test |
| NT6 | No notice is sent for a row older than 24 h (reminders 6 h) | Age check in `handleNotifyRow` | Stale test |
| NT7 | A row triggers at most 5 handler attempts, then is poisoned | `notifAttempts` on the row | Poison test |
| NT8 | A token belongs to at most one seat per game; at most 5 devices per seat | `registerSub` transaction | Registration tests |
| NT9 | No two reminder claims for one `(uid, game)` are less than 24 h apart, delayed rows included | `lastReminderAt` (previous reminder claim time) checked at delivery in `claim` | `claim` table test, delayed reminder gap test |
| NT10 | A reminder goes only to recipients in live `waitingOn` of the same episode (same `episode` and `episodeGen`) | `planReminder` | Unit and time-travel |
| NT11 | Every device pruned for `not-registered`/`invalid-token` is removed in the invocation that observed it, a rotated token is never removed by a stale failure, and no token is ever pruned for `invalid-argument` | `pruneDead` compares the stored token; `invalid-argument` maps to `lost` | Prune, rotation and `invalid-argument` tests |
| NT12 | Notification data is server-only and removed with the game | Rules rows 12 and 13; cascade stages `push` and `history` | LLD 3 rules and deletion tests |
| NT13 | Outbox rows and push payloads carry no `seed`, `actorPlayerId`, `commandType` or card id, and card-minting commands produce no notify row identifying an author | `buildOutbox` row shape (LLD 3 2.3); `NOTIFY_EVENTS` excludes minting events; closed payload keys | Anonymity tests 10.3 |
| NT14 | A player becomes newly waited-on only with a push: every transition into `waitingOn` (writing start, round open, submissions closed, judge change, unpause) yields a plan for that player unless they are in the app by construction (late joiner, any phase); the game ending (`GameEnded`, `GameFinished`) notifies every seated player | Event map 3.2 | `planVersion` unit and integration tests |
| NT15 | `planVersion` and `planReminder` input is the row (plus live `episode`/`waitingOn` for `Reminder` only); no live read for any other row | `OutboxRow.round`, `waitingOn` | Unit (pure signature) |
| NT16 | L6 writes `processedAt` only on `notify` rows and uses `notifDoneAt` on `identity` rows | Handler code path | Redrive test |

## Open questions / conflicts

1. **RESOLVED (user decision U1, C-WRITING): WRITING-phase nudges.** `WritingStarted` notifies writers (`write`), the Engine keeps an episode in WRITING, and reminders cover unfinished writers (`reminder_write`). `NOTIFY_EVENTS` gains `WritingStarted` and `PausedChanged`. History: HLD 3.8 and gameplay.md originally notified only turns and the daily reminder.
2. **RESOLVED by C-OUTBOX (LLD 3): `OutboxRow` carries `round {number, phase}` and `waitingOn`.** `planVersion` does no live read. `Reminder` rows keep one masked live read of `episode` and `waitingOn`, deliberately: it detects a player who acted after the sweep.
3. **HLD N1 weakened to "at most one visible notification".** Strict at-most-once would lose a notice in the crash window; at-least-once with collapse avoids loss. HLD N1 text needs the amendment in section 9.
4. **RESOLVED by C-OUTBOX / C-IDHANDOFF: consumer-added outbox fields.** `id`, `notifAttempts`, `poisonedAt`, `notifSkipped`, `notifDoneAt` are listed in LLD 3's `OutboxRow`. `processedAt` is written by this LLD on `notify` rows only and by LLD 4 on `identity` rows only; this LLD tracks identity-row cleanup in `notifDoneAt`.
5. **RESOLVED (source here, LLD 5 copies; brief item 10): `registerPush` schema.** LLD 5 copies the regexes of section 2.2 for `fcmToken` and `deviceId` (also on `unregisterPush.fcmToken`) and lists `NOT_AUTHORIZED` for unseated principals, including a host who left their seat. The response stays `{ok:true}`. `push_uid` (20 per hour) is enough only if clients register on token change or weekly, not on every open; LLD 7 respects that.
6. **RESOLVED by C-IDHANDOFF: LLD 3/4 consumer topology.** LLD 4 exports `handleIdentityRow(db, gameId, rowId)`, called by its `identityOutbox` trigger and by this LLD's hourly redrive; LLD 4's `reissueRejoinLink` calls `clearSeatPush(db, gameId, uid)` (exported here) after the reissue commits. This LLD also deletes `pushSubs` on `PlayerLeft`/`PlayerRemoved` identity rows but writes only `notifDoneAt`, never `processedAt`. The unseated host's `pushSubs` doc is left inert because its uid is not derivable from the row.
7. **LLD 0 additions needed.** Enable `fcm.googleapis.com` (and `fcmregistrations.googleapis.com`) in the API list of the first-deploy walkthrough; add logger events and fields (`rowId`, `kind`, `recipients`, `eventToFcmMs`), the new metrics and alerts of section 7.3, and note that `reminder.sweep.done.sent` is an upper bound. Also verify that `fn-runtime`'s `firebasecloudmessaging.admin` role is sufficient for `sendEach`.
8. **Quiet hours and time zones.** None in v1. A reminder can land at night if the original notice did; a fix needs a per-device time zone offset (new optional field on `registerPush`) and a defer path in `deliver`.
9. **N3 is per `(player, game)`.** A player in several games can receive several reminders in one hour. A global per-player cap would need a per-uid document across games (uids differ per game for seats, so a cap is only possible for a host's own uid). Accepted.
10. **Web Push `Topic` through FCM.** Support for the `Topic` header in `webpush.headers` via FCM HTTP v1 is assumed; verify at the first staging deploy (device test 8). `tag` replacement works regardless.
11. **RESOLVED (review CR): FCM `invalid-argument` ambiguity.** `invalid-argument` never prunes a token (the earlier single-token/one-of-many pruning heuristic is removed); it is counted and alerted (4.4, 7.3), and only `registration-token-not-registered` and equivalents prune. A genuinely bad token keeps costing one failed send per notice until FCM reports it unregistered; accepted. Alternative: dry-run the token at registration; rejected for the extra latency and because validity can change later.
12. **Firestore-trigger retry semantics.** `retry: true` is assumed to retry with backoff for a bounded period on the pinned `firebase-functions` 6.x; the `notifAttempts` counter and hourly redrive make the design correct even if the platform retries less.
13. **Host push on iOS.** The host's email-link sign-in opens in Safari (LLD 4 conflict 10), so the host's `pushSubs` belong to the browser context they registered from; a host who plays from the installed PWA must register there. Their seat uid is `hostId`.
14. **RESOLVED by U1: unpause is no longer silent.** `PausedChanged{paused:false}` sends `resumed` to the waited-on players and starts a new episode. Pausing itself stays silent.
15. **Cleanup race on `deleteGame`.** A fan-out in flight at delete time may recreate one `notifLog` doc after the `history` stage; it expires by TTL. Accepted (ids only).
16. **Engine `markReminded` drift.** LLD 1 sets `reminderDueAt = now + 24 h`, giving a cadence of 24 h plus sweep lag. Setting it to `dueAt + 24 h` would remove the drift but cause a catch-up burst after an outage, so it is not requested.

17. **Late joiner reminder timing.** A late joiner in status `writing` (WRITING or PLAYING, K-E) is added to the running episode's `waitingOn` without changing the episode or others' `waitingSince` (no push; they are in the app), so their first reminder follows the episode's `reminderDueAt` and may come sooner than 24 h after joining. Accepted; if LLD 1 instead gives each writer their own due time, the sweep needs no change but N3 needs a per-player check.
18. **`JudgeChanged` in SUBMITTING and the old judge.** U1 says nobody besides the new judge is told when judging moves during SUBMITTING, and also that every newly waited-on transition notifies. This LLD reads the first as "no broadcast" and keeps the `owe_card` push to the old judge, since they become newly waited-on. Drop the `owe_card` row if the product owner meant otherwise.
19. **`PausedChanged` outbox rows.** Both directions create a `notify` row (the pause row is inert, `paused: true`), so one extra row per flip. Accepted for simplicity of `NOTIFY_EVENTS`.

## Interfaces to other LLDs

| LLD | This LLD provides | This LLD expects |
|---|---|---|
| 0 Platform | Exports for `exports.json`: `notifyOutbox`, `reminderSweep`, `housekeeping`, plus the bodies of `registerPush`/`unregisterPush`; log events and metrics of section 7; `PUSH_SENDER=fake` emulator gate; params `REMINDER_SWEEP_CRON`; Cloud Scheduler needs (two jobs); no new secrets | `fn-runtime` FCM admin role and enabled FCM APIs; metric and alert definitions applied by `ops-apply`; the emulator-only clock override; Scheduler API enabled; extra logger fields |
| 1 Engine | Reads only: event catalog (section 11), `expected`, `waitingOn`, `episode`, `episodeGen`, `reminderDueAt`; the sweep's `markReminded` invocation (with `episode` and `episodeGen`) | `markReminded` kept with the episode, `episodeGen` and due checks; `episodeGen` incremented at every episode start, including unpause; late joiners in status `writing` added to `waitingOn` in any phase without resetting the episode (LLD 1 4.2); an episode (`waitingOn`, `waitingSince`, `reminderDueAt` +24 h) in WRITING as well as SUBMITTING and JUDGING; `waitingOn` and `episode` exposed on the aggregate; no event payload carries card text, seed or actor; a paused game's `reminderDueAt` is `null` |
| 2 Projector | Nothing at runtime; the visibility oracle uses `project` in tests | Views carry no push data; `project` usable from `functions` tests |
| 3 Store | `processedAt` and consumer fields (`notifAttempts`, `poisonedAt`, `notifSkipped`, `notifDoneAt`) on `notify` rows, `notifDoneAt` on `identity` rows, `notifLog` (TTL `expiresAt`), `pushSubs` with `uid`, `gameId`; the hourly redrive and the `deletions` stuck-job sweep (`housekeeping`) | `OutboxRow` with `id`, `roster`, `judgeId`, `paused`, `round?`, `waitingOn`, the consumer fields above, stable `v{n}_{i}` ids, and no seed, actor or command type; `buildOutbox(prev, next, cmd, a, now)`; `NOTIFY_EVENTS` including `WritingStarted`, `PausedChanged` and `GameEnded`; `Reminder` row written inside `markReminded`, its event carrying `episodeGen`; `listWaitingOn` items carrying `episodeGen`; `notifDoneAt: null` written at row creation and the index for the identity `notifDoneAt == null` redrive query; `listWaitingOn`, `runCommand`, `runDeletion`; the redrive index; cascade stages `push` and `history`; `where version ==` query registered in `queries.ts` |
| 4 Identity | Exports `clearSeatPush(db, gameId, uid)` from `subs.ts`; push cleanup on `PlayerLeft`/`PlayerRemoved` rows, recorded in `notifDoneAt`, never `processedAt` | `handleIdentityRow(db, gameId, rowId)` export (called by the redrive); `reissueRejoinLink` calls `clearSeatPush` after commit; sole writer of `processedAt` on `identity` rows; no other use of `pushSubs` |
| 5 Command API | Bodies and Firestore effects of `registerPush`/`unregisterPush`; membership validation inside them; the zod constraints for `fcmToken` and `deviceId` (section 2.2 is the source; LLD 5 copies them exactly) | `defineCallable` wrapper, principals seat and host, `assertSeatLive`, `push_uid` bucket; no system actor path other than `markReminded` |
| 7 Web Client | The push contract of section 2.1: data-only payload keys, `tag`, `renotify`, relative deep link, always-show rule, token rotation and re-registration rules, unregister-before-sign-out, permission and iOS status machine and "not reaching you" heuristic (section 6) | The single `/sw.js` worker (`push` and `notificationclick` handlers, receipts), with no Firebase SDK or config inside it; `VITE_FCM_VAPID_KEY`; install prompt on iOS; the local receipt log and the "since `lastSeenAt`" miss rule (section 6) |
