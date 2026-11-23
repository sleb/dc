# Deep Cuts: LLD 5, Command API & Contracts

Status: draft v0.1. Companion to [gameplay.md](../gameplay.md), [high-level-design.md](../high-level-design.md) (HLD), [tech-stack.md](../tech-stack.md), [00-platform-build-deploy.md](./00-platform-build-deploy.md) (LLD 0), [01-game-engine.md](./01-game-engine.md) (LLD 1), [02-view-projector.md](./02-view-projector.md) (LLD 2), [03-game-store.md](./03-game-store.md) (LLD 3) and [04-identity-sessions.md](./04-identity-sessions.md) (LLD 4). This LLD specifies the callable surface, `packages/contracts` (zod schemas, error codes, versioning), the request pipeline and the `defineCallable` wrapper, the `command` handler, the Firestore-backed rate limiter and its bucket table, API observability, and the API test plan. It builds on the names and types of LLDs 0 to 4 unchanged (`Principal`, `principalOf`, `assertSeatLive`, `toActor`, `runCommand`, `CommandOutcome`, `StoreError`, `Rejection`, `ErrorCode`, `ViewDoc`, `RoundDoc`, `RateLimitDoc`); conflicts are recorded at the end rather than silently fixed. HLD invariants A1 to A4 are kept; new API invariants are labeled **API1 onward**. "Must" statements are testable. Code lives in `functions/src/api/` and `packages/contracts/`.

## 1. Decisions at a glance

| Topic | Decision | Rationale |
|---|---|---|
| Rejection vs failure on the wire | A typed domain **rejection** is an HTTP-success body `{ok:false, reason, ...}`. Only gates (no auth, bad shape, outdated client) and infrastructure **failures** are `HttpsError`s | HLD 4.2 shape; clients never confuse "the game said no" with "the system broke"; retry rules differ |
| Creating and deleting games | Separate callables `createGame` and `deleteGame`; `command` rejects `createGame`, `join`, `deleteGame`, `importDeck`, `markReminded` at the schema | They need no aggregate to exist, a host-only principal, an extra Auth check (`deleteGame`), their own limits and ledgers (LLD 3 6.1, 6.4) |
| Wire names | `idempotencyKey` everywhere on the wire (HLD 4.2); `idemKey` stays the internal Store name (LLD 3) | One client helper, one name; conflict 2 |
| Request schemas | Non-strict (`z.object`: unknown keys stripped). **Response and view schemas are strict on the server** (`z.strictObject`, PJ2) and lenient on the client | Forward-compat during deploy skew vs. fail-closed redaction |
| Version signal | Integer `v` in every request, `sv` in every response, `ViewDoc.schema`/`viewsRev` for documents | Section 2.5 |
| Rate limiter | Fixed window, transactional counter per bucket, hashed keys, lockout, TTL | Section 7 |
| `consumeAppCheckToken` | Not adopted; `enforceAppCheck: true` on every callable | LLD 4 conflict 13 resolved: accept |
| Deck callables | Names and schemas **reserved** in `contracts`; nothing deployed in v1 | Deck Library is a later phase |

## 2. `packages/contracts`

### 2.1 Layout and build

```
packages/contracts/
  package.json         # "name": "@dc/contracts"; exports { ".": "./src/index.ts" }; dependencies: { "zod": "<exact 4.x>" } and nothing else
  tsconfig.json        # lib ["ES2023"], types []  (LLD 0 section 5): no DOM, no Node
  src/
    index.ts           # the only public entry; re-exports everything below
    version.ts         # CONTRACT_V, MIN_V, view SCHEMA constants
    ids.ts             # GameId, PlayerId, CardId, Uid, IdempotencyKey schemas and regexes
    limits.ts          # shared numeric caps (MAX_SEATED, MAX_TOTAL_JOINS, MAX_VOTES, text caps)
    errors.ts          # ERROR_CODES, REJECTION_DETAILS, DETAIL_BY_CODE, RejectionSchema, GATE_REASONS
    settings.ts        # Settings pieces shared by the command patch (2.4) and the view schemas (2.5): VariantsSchema, SpectatorsSchema, SettingsPatchSchema, Settings
    commands.ts        # payload schemas, CommandEnvelopeSchema, toEngineCommand, SERVER_ONLY_COMMANDS, Command/ClientCommand/ServerOnlyCommand types
    view.ts            # GameView, ViewDoc, RoundDoc schema factory (strict and loose), enum tuples, DraftSchema (issue #27)
    callables.ts       # (not yet built, M4) request/response schemas for every callable, CALLABLES, RESERVED_CALLABLES
  test/                # schema, compat and fixture tests (bun:test)
  compat/              # (not yet built, #38) frozen JSON-Schema snapshots per released CONTRACT_V (section 2.6)
```

- Built so far (issues #18 and #27): `version`, `ids`, `limits`, `errors`, `settings`, `commands`, `view` and `index`. `callables.ts` and `compat/` arrive with their own steps. Tests are in `test/`, included by `tsconfig.test.json`. The Playwright browser smoke and the Node 22 run are deferred to the first bundling step (#45); until then isolation is covered by a dependencies assertion and a source scan (no `node:*`, `bun*`, `firebase*`, `@dc/*` import; no `Date`, `crypto`, `fetch`). zod is pinned to 4.6.7.
- Consumed as TypeScript source (LLD 0 section 3); never built separately. `functions` bundles it, Vite compiles it for `web`. Types come from `z.infer`; no hand-written duplicate of a wire type exists (tech-stack section 8).
- Runtime dependency: **zod only**. No `firebase*`, `node:*`, `bun*`, no `@dc/*` import (LLD 0 P5 already lints this). No `Date`, `crypto`, `fetch`: uuid and hashing helpers live in `functions` and `web`. Runs unchanged in Node 22 and in browsers (tests run it under `bun test` now; the Playwright page-evaluate smoke and the Node 22 run are deferred to #45).
- zod is pinned to one exact version in `packages/contracts/package.json`; the APIs used (`object`, `strictObject`, `discriminatedUnion`, `infer`, `looseObject`) exist in zod 3.25 and 4. `bun.lock` carries it.
- `src/index.ts` exports **values** (schemas, constants, `toEngineCommand`) and **types**. It exports no function that performs I/O.

### 2.2 Identifiers, caps, versions

```ts
// ids.ts
export const GameIdSchema   = z.string().regex(/^[A-Za-z0-9]{20}$/);
export const PlayerIdSchema = z.string().regex(/^p_[a-z2-7]{8}$/);          // alphabet ratified by LLD 4 2.1
export const CardIdSchema   = z.string().regex(/^c_[a-z0-9]{10}$/);         // LLD 1 says "base-32"; accept a-z0-9 so an alphabet choice cannot break old clients (conflict 11)
export const IdempotencyKeySchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);  // lowercase UUIDv4
export const RoomCodeSchema = z.string().trim().toUpperCase().regex(/^[BCDFGHJKLMNPQRSTVWXZ]{4}$/);   // alphabet from LLD 3 2.4

// limits.ts: DoS guards at the edge; the Engine remains the semantic authority (X1, M-rules)
export const MAX_SEATED = 10, MAX_TOTAL_JOINS = 50, MAX_VOTES = 1500;      // last two are Engine-enforced via totalJoins and votes.length (section 8.2)
export const TEXT_LIMITS = { name: 24, card: 80, pitch: 140 } as const;     // code points; the Engine's semantic limits; LLD 7 imports it for input maxlength and counters
export const WIRE_TEXT_MAX = 400;     // UTF-16 units per card/name/pitch string at the edge; deliberately above every TEXT_LIMITS value
export const WIRE_DRAFT_MAX = 40;     // strings per color in saveDraft; Engine cap is writeTarget
// version.ts
export const CONTRACT_V = 1;          // wire major; bumped only by a breaking change (section 2.5)
export const MIN_V = 1;               // oldest wire major the deployed server still serves
export const VIEW_SCHEMA = 1;         // ViewDoc.schema, RoundDoc.schema
```

### 2.3 Error codes (finalizes HLD 4.3 plus the Engine's proposals)

```ts
// errors.ts
export const ERROR_CODES = [
  // HLD 4.3
  "NOT_AUTHORIZED", "WRONG_PHASE", "STALE", "NOT_IN_HAND", "ALREADY_SUBMITTED", "ROOM_FULL", "NAME_TAKEN",
  "CONTENT_REJECTED", "PAUSED", "RATE_LIMITED", "NOT_FOUND",
  // LLD 1 5.3, adopted
  "NOT_PLAYABLE", "INVALID_ARGUMENT", "VARIANT_UNAVAILABLE",
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);

// Closed set of `detail` strings. LLD 1/4 introduced most of these; join_cap (`totalJoins >= MAX_TOTAL_JOINS`) and vote_cap (`votes.length >= MAX_VOTES`) are the Engine caps enforced by LLD 1 (8.2).
export const DETAIL_BY_CODE = {
  CONTENT_REJECTED:    ["EMPTY", "TOO_LONG", "INVALID_CHARS", "PROFANITY"],
  NOT_PLAYABLE:        ["below_minimum", "players", "minimums", "no_submissions", "incomplete", "no_replacement"],
  WRONG_PHASE:         ["finished"],
  NOT_AUTHORIZED:      ["sitting_out", "own_card", "seat_revoked"],   // seat_revoked: assertSeatLive refused a removed or reissued seat (LLD 4 ID3); client shows "ask the host"
  ROOM_FULL:           ["join_cap"],
  VARIANT_UNAVAILABLE: ["vote_cap"],
  NOT_FOUND:           ["seat_replaced"],
  // STALE, NOT_IN_HAND, ALREADY_SUBMITTED, NAME_TAKEN, PAUSED, RATE_LIMITED, INVALID_ARGUMENT: never a detail
} as const satisfies Partial<Record<ErrorCode, readonly string[]>>;

export const GATE_REASONS = ["CLIENT_OUTDATED"] as const;   // HttpsError details only, never in a body (2.5)

export const RejectionSchema = z.strictObject({
  ok: z.literal(false),
  reason: ErrorCodeSchema,
  version: z.number().int().nonnegative(),      // aggregate version the rejection was decided against; 0 when no game state was read
  detail: z.enum([...new Set(Object.values(DETAIL_BY_CODE).flat())] as [string, ...string[]]).optional(),
  retryAfterMs: z.number().int().positive().optional(),   // RATE_LIMITED only
  sv: z.number().int(),
});
```

`version` is required in every rejection body, from every callable. The identity callables (`joinGame`, `rejoin`, `lobbyInfo`, `spectate`, `reissueRejoinLink`, and the rest of LLD 4) send the decision version of the game they read when one was read (for example a `joinGame` rejected by the Engine), and `version: 0` when no game state was read (rate limits, unresolved codes, uniform `rejoin` `NOT_FOUND`, principal refusals). `RATE_LIMITED` is produced only by the API layer (LLD 1: never by the Engine). `CLIENT_OUTDATED` is deliberately not an `ErrorCode`: it is a gate answer (2.5) that must work even when the client cannot parse the current body shape.

### 2.4 Command envelope and payloads

The envelope is HLD 4.2 with `v` added. Payloads match LLD 1 section 7 field for field.

```ts
// commands.ts
const env = <T extends string, P extends z.ZodRawShape>(type: T, payload: P, needsVersion = false) => z.object({
  v: z.number().int().min(1), gameId: GameIdSchema, idempotencyKey: IdempotencyKeySchema,
  expectedVersion: needsVersion ? z.number().int().nonnegative() : z.number().int().nonnegative().optional(),
  type: z.literal(type), payload: z.object(payload),
});
const Text = z.string().max(WIRE_TEXT_MAX);
const Pitch = Text.optional();

export const CommandEnvelopeSchema = z.discriminatedUnion("type", [
  env("updateSettings",    { patch: SettingsPatchSchema }),
  env("leave",             {}),
  env("removePlayer",      { playerId: PlayerIdSchema }),
  env("removeCard",        { cardId: CardIdSchema }),
  env("startGame",         {}),
  env("saveDraft",         { red: z.array(Text).max(WIRE_DRAFT_MAX), green: z.array(Text).max(WIRE_DRAFT_MAX) }),
  env("finishWriting",     {}),
  env("confirmSubmission", { cardId: CardIdSchema, pitch: Pitch }, true),
  env("writeIn",           { text: Text, pitch: Pitch }, true),
  env("redraw",            {}),
  env("closeSubmissions",  {}, true),
  env("pickWinner",        { submissionId: CardIdSchema }, true),
  env("passJudging",       {}, true),
  env("castVote",          { round: z.number().int().positive(), submissionId: CardIdSchema }),
  env("endGame",           {}),
]);
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;
export type ClientCommandType = CommandEnvelope["type"];
export const SERVER_ONLY_COMMANDS = ["createGame", "join", "importDeck", "deleteGame", "markReminded"] as const;

// SettingsPatchSchema: targetOverride int 2..10 | null; profanity "on"|"off"; variants and spectators as COMPLETE objects (never partial inner
// objects: LLD 1 does not say whether a patch merges nested keys, conflict 10); writeCountsOverride {red 0..10, green 0..10} | null.
export function toEngineCommand(e: CommandEnvelope): ClientCommand {          // pure; the only place an envelope becomes an Engine Command
  return { type: e.type, ...e.payload, ...(e.expectedVersion === undefined ? {} : { expectedVersion: e.expectedVersion }) } as ClientCommand;
}
```

| Command type (client) | Payload | `expectedVersion` |
|---|---|---|
| `updateSettings` | `{patch}` | optional, ignored |
| `leave`, `startGame`, `finishWriting`, `redraw`, `endGame` | `{}` | optional, ignored |
| `removePlayer` / `removeCard` | `{playerId}` / `{cardId}` | optional, ignored |
| `saveDraft` | `{red[], green[]}` | optional, ignored |
| `castVote` | `{round, submissionId}` | optional, ignored |
| `confirmSubmission` | `{cardId, pitch?}` | **required** |
| `writeIn` | `{text, pitch?}` | **required** |
| `closeSubmissions`, `passJudging` | `{}` | **required** |
| `pickWinner` | `{submissionId}` | **required** |

Built shape (issue #18): there are **strict command schemas only**. The "strict and loose" pair applies to the view schemas (2.5, issue #27); a command envelope has no loose variant (unknown envelope keys are stripped by `z.object`, as decided in section 1). The server-only commands are **plain TypeScript types** (`ServerOnlyCommand`), not schemas, so nothing can parse them off the wire; `SERVER_ONLY_COMMANDS` is the runtime name list and tests assert it is disjoint from the envelope types and that both together equal the LLD 1 section 7 name list. `ClientCommand` is derived from the envelope type (payload fields flattened, plus optional `expectedVersion`); `Command = ClientCommand | ServerOnlyCommand`. `SettingsPatchSchema` and its pieces live in `settings.ts` so the view schemas reuse them. Server-only shapes also carry `expectedVersion?`, as LLD 1 section 7 says every command does.

The required five are exactly the commands LLD 1 5.3 step 3 can answer with `STALE`. `Command`, `ClientCommand`, `ErrorCode` and the server-only command shapes (`createGame`, `join`, `importDeck`, `deleteGame`, `markReminded`, written as in LLD 1 section 7) are exported here; the Engine imports them (LLD 1 section 2).

### 2.5 `GameView`, `ViewDoc`, `RoundDoc`

LLD 2 section 4.2 and 7.1 are normative for every field name, nullability and meaning; this LLD owns the zod. The schemas are built by a factory so the server gets strict and the client gets lenient parsing from one definition:

```ts
// view.ts (built, issue #27; the file is the reference for every field, LLD 2 4.2 and 7.1 for meaning)
export const PHASES = ["LOBBY", "WRITING", "PLAYING", "FINISHED", "ENDED"] as const;   // also PLAYER_STATUSES, ROUND_PHASES, YOU_TURNS, DEPARTED_REASONS
export const makeViewSchemas = (mode: "strict" | "loose") => {
  const obj = mode === "strict" ? z.strictObject : z.looseObject;
  const en = (e) => (mode === "strict" ? e : z.string());   // loose: any string in enum positions (forward compatibility)
  // Counts, PublicSettings, PlayerPublic, RevealCard, RoundPublic, AwardsView, YouView, HostPanel, Live: LLD 2 4.2, field for field
  const GameView = z.discriminatedUnion("audience", [spectator, host, player /* host optional */, departed]);
  // viewsRev: clients order snapshots by (version, viewsRev) lexicographically, so a rebuild at the same version wins (LLD 2)
  const ViewDoc = obj({ schema: z.literal(VIEW_SCHEMA), viewsRev, gameId, enabled, version, generatedAt,
    view: GameView.nullable(), draftSeq: NonNeg.optional(), draft: Draft.nullable().optional() });
  const RoundDoc = obj({ schema, round, judgeId, winnerId, winnerCardId, green: { id, text: string | null }, plays, absent, resolvedAt, redacted });
  return { GameView, ViewDoc, RoundDoc };
};
export const { GameView: GameViewSchema, ViewDoc: ViewDocSchema, RoundDoc: RoundDocSchema } = makeViewSchemas("strict");  // server only: PJ2
export const { GameView: GameViewLooseSchema, ViewDoc: ViewDocLooseSchema, RoundDoc: RoundDocLooseSchema } = makeViewSchemas("loose");  // web
```

Built shape (issue #27), where it refines the sketch above:

- **Types** `GameView`, `ViewDoc`, `RoundDoc` are inferred from the strict schemas. The loose exports are re-typed with a `WidenEnums` mapped type (`GameViewLoose`, `ViewDocLoose`, `RoundDocLoose`): every `phase`, `status`, `turn`, `profanity` and `reason` key is `string`, discriminators stay literal. The factory itself returns the strict shape; the loose set is cast once, where it is exported.
- **Names.** The settings leaf is `PublicSettings` inside the factory (`settings.ts` already exports `Settings`, which includes `writeCountsOverride`); `Draft` is exported as `DraftSchema`/`Draft`, a strict object in both modes. The enum tuples are `PHASES`, `PLAYER_STATUSES`, `ROUND_PHASES`, `YOU_TURNS`, `DEPARTED_REASONS`, each with a `...Schema` (`z.enum`) and a type.
- **Optional and nullable.** `ViewDoc.draft` and `ViewDoc.draftSeq` and `PlayerView.host` are omitted, not `undefined`; every "nothing here" field is `null`. `draft` is also nullable (LLD 2 4.1).
- **Numbers.** Counts, `version`, `viewsRev`, `generatedAt`, `resolved`, `score`, `votes`, `joinOrder` are nonnegative integers; `round.number`, `target`, `podium.round` and `RoundDoc.round` are positive; `podium.rank` is 1, 2 or 3; `myVotes` keys are decimal round numbers (`/^[1-9][0-9]*$/`) with `CardId` values. There are no length caps on view strings or arrays: the Engine owns semantic limits, and the size budget is the Store's (PJ14, 512 KiB cap, step 2.3).
- **Room code.** `roomCode` reuses `RoomCodeSchema`, whose trim and uppercase transforms are no-ops on a valid code.
- **Not enforced by the schema.** `ViewDoc.version == view.version`, and `enabled == false` iff `view == null`, are Projector and Store obligations (steps 2.3 and M3), not parse-time checks.


**Loose-schema rule (forward compatibility, LLD 7 open question 21).** The loose variant differs from the strict one in exactly two ways: objects accept unknown keys (`looseObject`), and every enum position (`phase`, `status`, `turn`, `profanity`, departed `reason`, and any enum added later, through `en()`) is parsed as `z.string()`, so an additive enum member (for example a new `YouTurn`) reaches the client's default branch instead of failing the parse. The strict server schemas stay closed. The `audience` discriminator and the `schema` literal stay exact: the client checks the raw envelope `schema` before parsing and treats any loose parse failure as "Update needed" (LLD 7 section 4.1).

- Enumerations (`Phase`, `PlayerStatus`, `RoundPhase`, `YouTurn`, departed `reason`, `ERROR_CODES`) are declared here as `as const` tuples. The Engine keeps its own literal types, and they must equal the tuples (built in #27: `packages/engine/test/contracts-view-enums.test.ts`, an `Equal<>` type assertion plus exhaustive `Record<EnginePhase, true>` maps, LLD 2 11.6 `_d`; `ErrorCode` is imported, not duplicated); the Engine imports `ErrorCode` from here, so that one cannot drift.
- `project()` is declared to return the contracts `GameView` type, so a Projector field that is not in the schema is a compile error; the strict parse (PJ2) is the runtime half. The contracts tests also assert that `JSON.parse(JSON.stringify(game))` fails `GameViewSchema` (LLD 2 11.6).
- **Client rule for unknown enum values.** Every `switch` over a view enum (`turn`, `phase`, `status`) has a default branch that shows the "update needed" banner (2.6). Enum **additions** are therefore additive; removals and renames are breaking.

### 2.6 Versioning and compatibility

Client (Hosting) and server (Functions) deploy at different times: functions first, then Hosting (LLD 0 P16), preview channels run new web code against staging functions from `main` (LLD 0 conflict 1), and a phone can run a cached old bundle for days. Therefore the server is always the newer side in production, and the rules are:

| Mechanism | Rule |
|---|---|
| **`v` (request)** | Every callable request carries `v = CONTRACT_V` of the bundle that built it. `v < MIN_V` is answered with `HttpsError("failed-precondition", "CLIENT_OUTDATED", { reason: "CLIENT_OUTDATED", minV, sv })` **before** the body is parsed. `v` above the server's `CONTRACT_V` (preview or rollback skew) is served normally; unknown fields are stripped |
| **`sv` (response)** | Every body, success or rejection, carries `sv = CONTRACT_V` of the server. A client that sees `sv > its CONTRACT_V` shows a non-blocking "new version, reload" banner and asks the service worker to update (LLD 7) |
| **Hard block** | `CLIENT_OUTDATED`, or a `ViewDoc.schema` greater than the client's `VIEW_SCHEMA`, shows a full-screen "reload to continue" and stops issuing calls. The page reload picks up the new bundle (Hosting sends `no-cache` for `index.html` and `sw.js`, LLD 0 section 4) |
| **Additive-only within a `v`** | Allowed: new optional request fields; new response and view fields (clients parse leniently); new callables; new `ErrorCode`/enum values (clients default-branch). Forbidden without bumping `v`: removing or renaming a field, making an optional request field required, changing a type, narrowing an accepted value set, changing a field's meaning |
| **Breaking request/response change** | Bump `CONTRACT_V`. For one release the server accepts both (`MIN_V` stays at the old value, handlers branch on `input.v` through an adapter in `functions/src/api/compat/`). After the old client share is negligible, raise `MIN_V` (this is what turns old clients into `CLIENT_OUTDATED`) |
| **Breaking view change (`ViewDoc.schema`)** | A viewer has exactly one stored doc, so the server cannot serve two schemas at once. Sequence: (1) ship a web release that parses schema N and N+1; (2) after it is dominant, deploy the server writing N+1 and run `rebuildViews` (LLD 3 6.5, which also bumps `viewsRev`); (3) drop N support later. Old clients that still run see `schema` above theirs and show the hard block |
| **`PROJECTOR_REV`** | Content change within a schema (LLD 2 8.2), unrelated to compatibility |

The compat gate in CI (section 10.4) enforces the additive rules mechanically from frozen JSON-Schema snapshots in `packages/contracts/compat/v{N}.json`, generated at release (`bun run contracts:snapshot`).

## 3. Callable reference

All callables: region `us-central1`, service account `fn-runtime` (both from `setGlobalOptions`, LLD 0), `enforceAppCheck: true`, wrapped by `defineCallable` (section 4), exported by name from `functions/src/index.ts` and listed in `functions/exports.json`. Principal kinds are LLD 4 section 2.2.

### 3.1 Behavior

| Callable | Purpose | Principals (`allow`) | Request (zod, section 3.3) | Success body | Rejection reasons in body | Idempotency | Rate buckets (section 7.3) |
|---|---|---|---|---|---|---|---|
| `command` | Every in-game command (2.4) | seat, host, spectator (`castVote` only) | `CommandEnvelope` | `{ok:true, version, view, draftSeq?, replay}` | all `ErrorCode` except none excluded; `RATE_LIMITED` | ledger `(uid, idempotencyKey)` per game, LLD 3 5.4; required | `cmd_uid`; `draft_uid` for `saveDraft`; `vote_uid` for spectator `castVote` |
| `createGame` | Create a game, allocate room code, host seat | host | `{v, idempotencyKey, hostName, settings?}` | `{ok:true, gameId, roomCode, inviteUrl, replay}` | `CONTENT_REJECTED`, `INVALID_ARGUMENT`, `RATE_LIMITED` | ledger `hosts/{uid}/idem`; replay returns same ids | `create_uid`, `create_ip` |
| `deleteGame` | Phase 0 of S5, cascade follows | host | `{v, gameId, idempotencyKey}` | `{ok:true, deleting:true}` (no `replay`) | `NOT_AUTHORIZED`, `NOT_FOUND` (already deleting or absent: client treats as success), `RATE_LIMITED` | none in the body: a replay of `deleteGame` returns `NOT_FOUND`, never `replay:true`; the client helper maps it to success | `delete_uid` |
| `joinGame` | Join by code or invite; mint seat | guest, spectator, host, seat | LLD 4 4.1 (`target`, `displayName`, `idempotencyKey`) | `{ok:true, gameId, playerId, customToken, rejoinUrl, version, replay}` | `NOT_FOUND`, `NAME_TAKEN`, `ROOM_FULL`, `CONTENT_REJECTED`, `WRONG_PHASE`, `RATE_LIMITED` | `joinIdem/{sha256(idempotencyKey)}` checked before the code is resolved, so a same-key retry recovers the seat after the code expired; replay returns credentials only while `seats/{uid}.firstSignInAt == null`, else `NOT_FOUND` (LLD 4 4.2, 6.3 below) | by code: `code_ip`, `join_ip`, `join_game_code`; by id: `invite_ip`, `join_ip`, `join_game_invite` |
| `lobbyInfo` | Pre-join peek, never returns `gameId` | guest, spectator, host, seat | `{v, target:{code}\|{gameId}}` | `{ok:true, joinable:false}` or `{ok:true, joinable:true, playerCount}` | `RATE_LIMITED` | read-only | by code: `code_ip`, `code_code`; by id: `invite_ip` |
| `rejoin` | New-device seat recovery | guest, spectator, host, seat | `{v, gameId, secret}`, both permissive (3.3): a malformed value is `NOT_FOUND`, never `invalid-argument` | `{ok:true, playerId, customToken}` | `NOT_FOUND` (uniform), `RATE_LIMITED` | none (token mint only) | `rejoin_fail_ip`, `rejoin_fail_game` (failure-counted) |
| `spectate` | Is the spectator doc available; spectator voting? | spectator, host, seat | `{v, gameId}` | `{ok:true, available, vote}` | `RATE_LIMITED` | read-only | `spectate_ip` |
| `registerPush` | Store an FCM token for a seat or host | seat, host | `{v, gameId, fcmToken, deviceId?}` (constraints in 3.3) | `{ok:true}` | `NOT_AUTHORIZED`, `NOT_FOUND`, `RATE_LIMITED` | natural upsert on `pushSubs/{uid}_{gameId}` | `push_uid` |
| `unregisterPush` | Remove it | seat, host | `{v, gameId, fcmToken}` | `{ok:true}` | as above | natural | `push_uid` |
| `reissueRejoinLink` | Rotate a player's link | host | `{v, gameId, playerId}` | `{ok:true, rejoinUrl}` | `NOT_AUTHORIZED`, `NOT_FOUND`, `RATE_LIMITED` | **not idempotent by design** (LLD 4 6.1) | `reissue_uid` |
| `signOutEverywhere` | Revoke the host's refresh tokens | host | `{v}` | `{ok:true}` | `RATE_LIMITED` | naturally idempotent | `signout_uid` |
| `listGamesByHost` | Host's game list (LLD 3 open question 4) | host | `{v, limit?<=50, after?}` | `{ok:true, games:[{gameId, roomCode\|null, phase, playerCount, createdAt}], next}` | `RATE_LIMITED` | read-only | `list_uid` |
| `hostProfile` | Post-sign-in bootstrap: `ensureHostProfile`, returns `{hostId, createdAt}`; no email | host | `{v}` | `{ok:true, hostId, createdAt}` | `RATE_LIMITED` | idempotent upsert | `profile_uid` |
| `beforeEmailSent` (blocking function, not a callable) | Per-email and per-IP cap on host sign-in emails | n/a (Identity Platform) | provider event | allow or throw | n/a | n/a | `email_addr`, `email_ip` (8.1) |

Every row's rejection set also contains `NOT_AUTHORIZED` (principal not in `allow`, or revoked seat). `INVALID_ARGUMENT` in a body means the **Engine** rejected a value that passed the shape check (range, count); a malformed shape is an `HttpsError("invalid-argument")` (section 5).

**Reserved, not deployed in v1** (`RESERVED_CALLABLES` in `callables.ts`; a test asserts none is in `CALLABLES` or `exports.json`): `saveDeck {v, gameId, name}`, `listDecks {v}`, `deleteDeck {v, deckId}`, `importDeck {v, gameId, deckId, idempotencyKey}` (the latter builds the Engine's `importDeck` command server-side from `hosts/{uid}/decks`, LLD 1 section 13; it is never accepted by `command`). All host principal.

### 3.2 Runtime settings

| Callable | memory / cpu | `timeoutSeconds` | `minInstances` | `maxInstances` | `concurrency` | Secrets bound |
|---|---|---|---|---|---|---|
| `command` | 512MiB / 1 | 30 | param `COMMAND_MIN_INSTANCES` (staging 0, prod 1) | 20 | 40 | `RATE_LIMIT_HASH_SALT`, `LOG_HASH_SALT` |
| `createGame` | 256MiB / 1 | 20 | 0 | 5 | 20 | rate salt, log salt |
| `deleteGame` | 256MiB / 1 | 30 | 0 | 5 | 20 | rate salt, log salt |
| `joinGame` | 256MiB / 1 | 20 | 0 | 10 | 40 | `SEAT_DERIVATION_KEY`, rate salt, log salt |
| `lobbyInfo`, `spectate` | 256MiB / 1 | 10 | 0 | 10 | 80 | rate salt, log salt |
| `rejoin` | 256MiB / 1 | 15 | 0 | 10 | 40 | rate salt, log salt |
| `registerPush`, `unregisterPush` | 256MiB / 1 | 10 | 0 | 5 | 80 | rate salt, log salt |
| `reissueRejoinLink`, `signOutEverywhere`, `listGamesByHost`, `hostProfile` | 256MiB / 1 | 10 (reissue 20) | 0 | 3 | 20 | rate salt, log salt |

Rationale: the work is I/O bound and `decide` plus fan-out is a few milliseconds (LLD 2 section 10), so one vCPU with concurrency 40 to 80 per instance keeps instance count low (`concurrency > 1` requires cpu >= 1 on gen2). `command` gets 512MiB because it holds the whole bundle (Engine, wordlist, fan-out) and up to 40 concurrent `GameDoc`s. `timeoutSeconds: 30` bounds the Store's 8-attempt retry loop (LLD 3 5.2); a timeout leaves "maybe committed", which the same-key retry resolves. Only `command` is kept warm in prod: the first tap after idle is the one players feel (tech-stack section 10); a cold `lobbyInfo` costs one extra second at join, accepted. `maxInstances` caps the cost of any abuse that passes the limiter. Whether `cpu: 1` is accepted at 256MiB is verified at the first deploy (conflict 14).

### 3.3 Schemas for the non-command callables (`callables.ts`)

```ts
const V = { v: z.number().int().min(1) };
export const JoinRequestSchema = z.object({ ...V, target: z.union([z.object({ code: RoomCodeSchema }), z.object({ gameId: GameIdSchema })]),
  displayName: z.string().max(WIRE_TEXT_MAX), idempotencyKey: IdempotencyKeySchema });
export const JoinResponseSchema = z.union([
  z.strictObject({ ok: z.literal(true), gameId: GameIdSchema, playerId: PlayerIdSchema, customToken: z.string(), rejoinUrl: z.string(),
                   version: Int, replay: z.boolean(), sv: Int }),
  RejectionSchema]);
export const LobbyRequestSchema = z.object({ ...V, target: z.union([z.object({ code: RoomCodeSchema }), z.object({ gameId: GameIdSchema })]) });
export const LobbyResponseSchema = z.union([
  z.strictObject({ ok: z.literal(true), joinable: z.literal(false), sv: Int }),
  z.strictObject({ ok: z.literal(true), joinable: z.literal(true), playerCount: Int, sv: Int }),   // never a gameId (ID14)
  RejectionSchema]);
// rejoin: deliberately permissive so a malformed secret or gameId is indistinguishable from a wrong one (LLD 4). Any value, including a
// missing one, parses (`.catch("")`); the handler checks the GameId/secret shape itself and answers the uniform NOT_FOUND (version 0),
// counting a failure in rejoin_fail_ip/rejoin_fail_game like any bad secret. Only `v` is still gated (CLIENT_OUTDATED).
export const RejoinRequestSchema = z.object({ ...V, gameId: z.string().max(WIRE_TEXT_MAX).catch(""), secret: z.string().max(WIRE_TEXT_MAX).catch("") });
export const CommandResponseSchema = z.union([
  z.strictObject({ ok: z.literal(true), version: Int, view: GameViewSchema, draftSeq: Int.optional(), replay: z.boolean(), sv: Int }),
  RejectionSchema]);
// ...one Request/Response pair per row of 3.1, same pattern; all response arms are strictObject and end with RejectionSchema.
export const CALLABLES = { command: { req: CommandEnvelopeSchema, res: CommandResponseSchema }, joinGame: {...}, /* ... */ } as const;
```

```ts
// registerPush / unregisterPush constraints, copied from LLD 6 section 2.2 (deviceId is a Firestore map key)
const DeviceId = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/);
const FcmToken = z.string().regex(/^[A-Za-z0-9_:\-]{50,4096}$/);
export const RegisterPushRequestSchema = z.object({ ...V, gameId: GameIdSchema, fcmToken: FcmToken, deviceId: DeviceId.optional() });  // omitted: server derives t_ + 20 chars of base64url(sha256(token))
export const UnregisterPushRequestSchema = z.object({ ...V, gameId: GameIdSchema, fcmToken: FcmToken });
```

A violation is a shape failure (`invalid-argument`). Both responses stay `{ok:true, sv}`; `NOT_AUTHORIZED` covers unseated principals, including a host who left their seat (LLD 6 conflict 5). The U1 notification changes (WritingStarted, JudgeChanged, unpause) are server-side `NOTIFY_EVENTS` only; no callable, schema or code changes.

The typed client helper in `apps/web` is generated from `CALLABLES`: `call<K extends keyof typeof CALLABLES>(name, req: In<K>): Promise<Out<K>>`, so a callable's request and response types exist in exactly one place.

## 4. Request pipeline and `defineCallable`

### 4.1 Order

| # | Step | Where | On failure |
|---|---|---|---|
| 1 | **App Check** | framework (`enforceAppCheck: true`, tokens verified, not consumed) | framework `HttpsError("unauthenticated")` before our code runs; never logged by us (appears in Cloud Run request logs, status 401) |
| 2 | **Auth presence** | wrapper | no `request.auth` and `guest` not in `allow`: `HttpsError("unauthenticated")` |
| 3 | **Version gate, parse, validate** | wrapper: `{v}` pre-parse, then `spec.input.safeParse` | `CLIENT_OUTDATED` or `invalid-argument` (fixed messages, input never echoed) |
| 4 | **Rate limit** | `limits.consume(specs)` using `req.auth?.uid`, provider kind, `ipHash`, parsed input | `RATE_LIMITED` body |
| 5 | **Principal resolve** | `principalOf(req.auth)` (pure), `allow` check, then `assertSeatLive` for seats when `gameIdOf` is declared (refuses when the token's `ep` claim differs from `seats/{uid}.epoch` or `authTime <= notBefore`, LLD 4) | `NOT_AUTHORIZED` body |
| 6 | **Handler** | spec-specific; calls `runCommand` and friends | `Rejection` becomes a body; failures throw |
| 7 | **Response mapping** | wrapper: strict `output.parse`, `detail` allowlist, add `sv`, log | see section 5 |

Why this order: the limiter (4) runs before any Firestore read other than its own and before any lookup that distinguishes cases (ID11); the seat freshness read (5) is the first read that depends on a *claimed* identity, so it comes after a flood has been throttled by IP or uid; shape validation (3) precedes everything stateful so garbage costs no I/O. The pure part of principal classification could run earlier, but classification is cheap, `allow` needs the parsed `gameId` for seats, and keeping steps 4 and 5 ordered matches LLD 4 section 2.2.

### 4.2 Wrapper shape (`functions/src/api/callable.ts`)

The wrapper is `defineCallable`, in this file; `callable` is a deprecated alias exported from the same file (conflict 1, resolved: LLD 0 aligns its lint exception, file tree and P12 to `functions/src/api/callable.ts` and lists the options below: `allow`, `limits`, `gameIdOf`, strict output, `sv`). It is the only module that imports `onCall`. **Status (issue #12, corrected by #15):** the minimal wrapper has landed: `REGISTRY` (entries carry `allow` and the `onCall` options), region, `serviceAccount: "fn-runtime@"` (the project id stays out of the code; the CLI resolves it, and a bare name is rejected at deploy time), `enforceAppCheck: true`, `consumeAppCheckToken: false`, the runtime shape (`RT.command`), the auth-presence check (step 2) and error mapping with one `api.done` line (non-`HttpsError` throws become `internal` with the fixed message; an `HttpsError` keeps its code). Its spec is `{ name, allow, runtime, handler({ req }) }`; the version gate, zod input and output, `limits`, `gameIdOf`, `principalOf`, strict output and `sv` (steps 3 to 5 and 7) are still to come in #38. Also landed: an unexpected throw logs its `Error` (message and stack, never the request data) as an `api.error` line for Error Reporting; client-fault `HttpsError` codes log `api.done` as `rejected` (WARNING), others as `error`; `principalKind` is omitted from `api.done` until `principalOf`; a duplicate `name` throws.

```ts
export type PrincipalKind = Principal["kind"];

export interface CallableSpec<I extends { v: number }, O extends { ok: boolean }> {
  name: string;
  input: z.ZodType<I>;
  output: z.ZodType<O | Rejection>;                     // strict; every arm of the union is a strictObject
  allow: readonly PrincipalKind[];                      // explicit, no default (API1); "guest" only for the pre-membership callables
  gameIdOf?: (i: I) => GameId;                          // present => seats are checked with assertSeatLive against this game
  limits: (c: LimitCtx<I>) => LimitSpec[];              // evaluated at step 4: needs no principal, only uid, provider kind, ipHash, input
  runtime: { memory: "256MiB" | "512MiB"; cpu: 1; timeoutSeconds: number; minInstances?: number | Param<number>; maxInstances: number;
             concurrency: number; secrets?: SecretParam[] };
  handler: (c: { input: I; principal: Principal; deps: Deps; limits: LimitHandle; req: CallableRequest }) => Promise<Omit<O, "sv">>;
  // handlers return a body or throw RejectionError (typed domain result) / StoreError / anything else (failure)
}

export function defineCallable<I extends { v: number }, O extends { ok: boolean }>(s: CallableSpec<I, O>) {
  REGISTRY.set(s.name, s);                              // exports.json check and API1 tests read this
  return onCall({ region: REGION, serviceAccount: FN_RUNTIME, enforceAppCheck: true, consumeAppCheckToken: false,
                  secrets: s.runtime.secrets, ...s.runtime }, async (req) => {
    const t0 = Date.now(); const ctx: LogCtx = { callable: s.name, principalKind: "none" };
    try {
      if (!req.auth && !s.allow.includes("guest")) throw new HttpsError("unauthenticated", "Sign in required.");        // 2
      const v = gateVersion(req.data);                                            // 3: throws CLIENT_OUTDATED
      const parsed = s.input.safeParse(req.data);
      if (!parsed.success) throw invalidArgument();                               // fixed message; issues logged by path only, never values
      const input = parsed.data; ctx.clientV = v;
      const handle = await limits.consume(db, s.limits(limitCtx(req, input)));    // 4: throws RejectionError("RATE_LIMITED", {retryAfterMs})
      const principal = principalOf(req.auth);                                    // 5
      ctx.principalKind = principal.kind;
      if (!s.allow.includes(principal.kind)) throw reject("NOT_AUTHORIZED");
      if (principal.kind === "seat" && s.gameIdOf) await assertSeatLive(db, principal, s.gameIdOf(input));
      const out = await s.handler({ input, principal, deps, limits: handle, req }); // 6
      return finish(s, { ...out, sv: CONTRACT_V }, ctx, t0);                      // 7
    } catch (e) { return fail(s, e, ctx, t0); }
  });
}
```

`finish` strict-parses the body with `s.output` (API8: a field the schema does not name never leaves, and a view that does not parse is an `internal` failure), applies `DETAIL_BY_CODE` to any rejection, logs `api.done`, and returns. `fail` is the mapper of section 5. Handlers never build `HttpsError`s themselves, never read `req.data` (they get `input`), and never log request or response bodies (lint: no `console.*`, and `log.ts` accepts no free-form object, LLD 0 section 9).

`deps` is `{ clock, newSeed, mintId, faults? }` (LLD 3 5.1). `limits` exposes `refund(bucket)` and `fail(bucket)` for the hit-refund and failure-counted buckets (section 7).

## 5. Error mapping and non-leakage

### 5.1 Mapping table

| Condition | Wire result | Class (logs) | Client action |
|---|---|---|---|
| `Rejection` from `decide` (any `ErrorCode`) | body `{ok:false, reason, version, detail?, sv}`, HTTP success | `rejected` | Render copy per code; never auto-retry (`STALE`: re-read, let the user decide again) |
| `RejectionError("NOT_AUTHORIZED")` from `principalOf`, `allow`, `assertSeatLive` | body, `version: 0` | `rejected` | Revoked seat: show "ask the host" (LLD 7); else sign-in prompt |
| `RATE_LIMITED` | body, `version: 0`, `retryAfterMs` | `rejected`, plus `rate.limited` | Show wait time; no automatic retry before `retryAfterMs` |
| no auth where required, App Check missing | `HttpsError("unauthenticated")` | `rejected` (gate) | Re-init App Check/sign in once, then stop |
| shape invalid, unknown `type`, key reuse with different payload | `HttpsError("invalid-argument", "INVALID_REQUEST")` | `rejected` (reason `INVALID_REQUEST`, log-only) | Client bug: do not retry; alert on rate (section 9) |
| `v < MIN_V` | `HttpsError("failed-precondition", "CLIENT_OUTDATED", {reason, minV, sv})` | `rejected` (gate) | Hard reload screen |
| `StoreError("CONTENTION")` | `HttpsError("aborted")` | `error` (WARNING, no Error Reporting group) | Retry same key with backoff (6.5) |
| `StoreError("UNAVAILABLE")`, function deadline | `HttpsError("unavailable")` / SDK `deadline-exceeded` | `error` (WARNING) | Retry same key; commit may have happened |
| `StoreError("INVARIANT")`, `EngineInvariantError`, output schema failure, any unknown throw | `HttpsError("internal", "Something went wrong.")` | `error` (`Error` object, Error Reporting) | One retry with the same key, then show an error |
| `AGGREGATE_TOO_LARGE`, `TOO_MANY_WRITES`, `ROOM_CODES_EXHAUSTED` | `HttpsError("resource-exhausted", "LIMIT_REACHED")` | `error` (`Error` object) | Show "this game has reached its limit"; no retry |

Rejections are **never** `HttpsError`s and failures are **never** bodies with a `reason` from the HLD taxonomy (LLD 3 5.8, API11). An `ErrorCode` also has a conventional gRPC analogue for dashboards only (`NOT_AUTHORIZED` permission-denied, `NOT_FOUND` not-found, `RATE_LIMITED` resource-exhausted, `INVALID_ARGUMENT` invalid-argument, the rest failed-precondition); it appears in logs as `reason`, never on the wire.

### 5.2 Never leaking hidden state (HLD 4.3, R1)

1. **The Engine's guard order is the first defense** (LLD 1 5.3): a non-member learns only `NOT_AUTHORIZED`; `pickWinner` with an unknown `submissionId` and with an id from another round both return `NOT_FOUND` with no `detail`; `confirmSubmission` for a card the caller does not hold returns `NOT_IN_HAND` whether or not the card exists elsewhere. The API adds nothing to these answers and must not differentiate them.
2. **Constant shape.** Every body is a strict object from a fixed set of schemas. `detail` is a member of `DETAIL_BY_CODE[reason]` or absent; the wrapper drops any other value (and logs `api.detail.stripped`, a bug signal). `detail` never contains ids, counts, card text or names. `HttpsError` messages come from a fixed table (above); `details` carry only `{reason, minV, sv}` or `{retryAfterMs}`.
3. **Equal cost, equal time.** Rejections that differ only in hidden state (unknown vs other-round `submissionId`) take the same path: `decide` is pure and reads no extra documents, and `runCommand` reads the same two documents in both cases (LLD 3 5.3). The test in 10.2 compares full responses byte for byte; timing is not a control (per-IP limits and friend-group scale make timing channels uninteresting).
4. **No echo.** Neither the wrapper nor handlers put request values into an error, a log line or a response. The zod `issues` are logged as paths only.
5. **Game existence.** A spectator or non-seat calling `command` for an unknown `gameId` gets `NOT_FOUND`; for a real game they get `NOT_AUTHORIZED` unless the command is `castVote`. Ids are 119-bit unguessable, so this is accepted (conflict 12). A seat bound to another game gets `NOT_AUTHORIZED` before any read of that game (ID2).

## 6. The `command` handler

### 6.1 Flow

```ts
export const command = defineCallable({
  name: "command", input: CommandEnvelopeSchema, output: CommandResponseSchema, allow: ["seat", "host", "spectator"],
  gameIdOf: (i) => i.gameId,
  limits: ({ input, uid, providerKind }) => input.type === "saveDraft" ? [lim("draft_uid", uid)]
    : providerKind === "anonymous" ? [lim("vote_uid", uid)] : [lim("cmd_uid", uid)],
  runtime: RT.command,
  handler: async ({ input: i, principal, deps }) => {
    if (principal.kind === "spectator" && i.type !== "castVote") throw reject("NOT_AUTHORIZED");        // LLD 4 2.2 table
    const cmd = toEngineCommand(i);                                       // contracts, pure; expectedVersion passed through untouched
    const fp = fingerprint(i.type, i.payload);                            // 12 hex of SHA-256(type + canonical payload)
    const out = await runCommand(db, deps, { gameId: i.gameId, cmd, actor: toActor(principal), idemKey: i.idempotencyKey, meta: { fp } });
    if (out.kind === "rejected") return { ok: false, reason: out.rejection.code, detail: out.rejection.detail, version: out.version };
    if (out.kind !== "accepted" || out.view === null) throw new Error("unreachable for a client command");   // deleteGame/system are not client commands
    if (out.replay && out.meta?.fp !== fp) throw invalidArgument();       // same key, different command: client bug (API5)
    return { ok: true, version: out.version, view: out.view, ...(out.draftSeq === undefined ? {} : { draftSeq: out.draftSeq }), replay: out.replay };
  },
});
```

- **Envelope validation** is step 3 (zod, discriminated on `type`). A type outside the 15 client types fails the schema; `createGame`, `join`, `deleteGame`, `importDeck` and `markReminded` are therefore unreachable through `command` (API4).
- **Principal to actor.** `toActor(principal)` yields `{kind:"user", uid}` (LLD 4 2.2). No role, `playerId` or `isHost` from the client is read anywhere: the envelope has no such field, and the Engine resolves roles from `uid` through `game.players[].uid` (A2). `markReminded` is reachable only from the Scheduler with `{kind:"system"}`.
- **Seat freshness.** `assertSeatLive` has already run (step 5): one `seats/{playerId}` read, outside the transaction, rejecting revoked or reissued sessions immediately (ID3): a token whose `ep` claim (the one developer claim on seat custom tokens; no other custom claims) is not the seat's current `epoch`, or whose `authTime` is not strictly after `notBefore`, gets `NOT_AUTHORIZED`/`seat_revoked`. The host principal and spectators have no seats doc and skip it.
- **Store call.** One `runCommand` (LLD 3 5.2). `expectedVersion` is never interpreted here (LLD 3 5.4).
- **What `ok:true` returns.** `view` is the caller's own `GameView`, produced in the transaction by `makeProjector(next)(viewerFor(next, uid))` (LLD 2 8.5): for a spectator caller the spectator content; for a caller who has just left or been removed, the tombstone. `version` is the aggregate version the command produced. For a text-only `saveDraft` there is no new aggregate version: `version` and `view` are the unchanged ones and `draftSeq` is the new draft counter. The wrapper strict-parses the response with `GameViewSchema` (API8).
- **Replay (resolves the replay-returns-current-view question).** A ledger hit returns `{ok:true, replay:true, version: <original committed version>, view: <caller's current view>}` (LLD 3 5.4, conflict 8). The contract states: **on a replay `version` can be lower than `view.version`**, and the client must order by `view.version` (LLD 2 8.4) and treat `version` only as "my command was applied at or before this point". Returning the original view was rejected: it is not stored (up to 64 KiB) and is stale by definition.

### 6.2 `expectedVersion` and STALE

- **Required** for `confirmSubmission`, `writeIn`, `closeSubmissions`, `pickWinner`, `passJudging` (the five commands LLD 1 can answer `STALE` to); optional and ignored elsewhere. Required is enforced by the schema, so a client that forgets it gets a shape error in development, not silently weaker protection.
- **Value.** The client sends `view.version` of the view it rendered when the user acted (not the response `version`, and never a value it computed). The Engine compares it with `round.changedAtVersion`, which only changes when the round's judge, phase or membership-of-round changes (LLD 1 5.3 step 3). Unrelated commands by other players do not make a pick stale. The client cannot read `changedAtVersion` (PJ7), so there is nothing else it could send.
- **Skip-unchanged is safe here.** A viewer's `view.version` can lag the aggregate (LLD 2 8.4), but a change to judge or round phase changes the public `round` object in every view, so every doc is rewritten at a version `>= changedAtVersion` and a view rendered before the change always carries a smaller version.
- **Order against the ledger.** The ledger check precedes `STALE` (LLD 3 5.4): a retry of an accepted `pickWinner` after the round moved on is a replay, not `STALE`. A **new** key with the old `expectedVersion` is `STALE`.
- **On `STALE`** the client keeps its pending selection locally, lets the listener deliver the new view, and asks the user again. It does not resend with a new `expectedVersion` automatically (user intent may no longer apply). `rejection.version` is the aggregate version at decision time; it must not be compared with `view.version` to infer "I am behind" (LLD 2 8.4).

### 6.3 Idempotency key: format and scope

- **Format.** Lowercase UUIDv4 from `crypto.randomUUID()`, generated **per user intent** when the action is first attempted and persisted (in memory plus `sessionStorage`) until a definitive answer arrives. A new tap on the same button after a definitive answer is a new key.
- **Scope.** `(gameId, actor uid, key)`: the Store hashes `actor \0 key` into `games/{g}/idem/{hash}` (LLD 3 2.4), so two players cannot collide and a key is meaningless in another game. `createGame` is scoped to the host (`hosts/{uid}/idem`). Retention 7 days.
- **Reuse with a different command.** The ledger stores `meta.fp` (12 hex characters of a SHA-256 over `type` and canonical payload). A replay whose fingerprint differs is `invalid-argument`, which turns a client bug into a loud error instead of silently returning another command's result (API5). The fingerprint is a hash of possibly low-entropy card ids; it lives only in the server-only ledger doc and is never logged.
- **`joinGame` key is a credential.** A same-key replay can return a custom token and rejoin secret (while the seat has never been signed in, LLD 4 4.2), so the join key is treated like a secret: the client keeps it only in `sessionStorage` until the join response is persisted, then deletes it (LLD 7); the handler hashes it at the boundary (`keyHash = sha256(idempotencyKey)`, the id of `joinIdem/{keyHash}` and of the join ledger doc) and uses only the hash afterwards. Neither the raw key nor the hash is logged; `log.ts` has no field for either and redacts any `idempotencyKey` key (API10).
- Only accepted commands are recorded (LLD 3 5.4), so a rejected command may be retried with the same key after state changes; clients still mint a new key for a new intent.

### 6.4 Timeouts

Function limit 30 s (section 3.2); Firestore transaction retries use the SDK backoff within that. The web client sets `httpsCallable(fn, { timeout: 35_000 })`, longer than the server so the server's typed answer wins the race. A client-side timeout means "unknown outcome": retry with the **same** key (6.5).

### 6.5 Client retry guidance (binding for LLD 7)

| Outcome | Action |
|---|---|
| `ok:true` | Apply `view` if `view.version >= current`; done |
| `ok:false` (any reason) | Definitive. Render. Do not retry. Discard the key |
| `aborted`, `unavailable`, `deadline-exceeded`, network error | Retry with the **same** `idempotencyKey`: delays 0.5, 1, 2, 4, 8 s with full jitter, at most 5 retries (about 15 s total), then show "still trying" and keep the key for a manual retry |
| `internal` | One retry with the same key after 1 s; then surface the error, keep the key |
| `resource-exhausted` | Definitive; no retry |
| `unauthenticated` | Refresh the App Check and ID token once, retry once with the same key; then sign-in prompt |
| `invalid-argument` | Definitive client bug; no retry |
| `failed-precondition` / `CLIENT_OUTDATED` | Stop, show reload screen |
| any call while `RATE_LIMITED` | Wait `retryAfterMs` |

`saveDraft` calls are serialized by the client (LLD 7), at most one in flight, debounced to one per 1.5 s, so they cannot hit the `draft_uid` bucket in normal use (900/h is 15 per minute of continuous typing).

## 7. Rate limiter

### 7.1 Design

- **Store.** `rateLimits/{kind}_{keyHash}` (LLD 3 `RateLimitDoc`: `{kind, windowStart, count, lockedUntil, expiresAt}`), Admin SDK only, rules deny everything (LLD 3 row 13).
- **Key hashing.** `keyHash = hex(HMAC-SHA256(RATE_LIMIT_HASH_SALT, kind + "\0" + raw))` truncated to 32 hex characters. `raw` is a normalized IP, room code, `gameId`, uid or email; none appears in a document id, field or log (LLD 4 section 9).
- **Fixed window, transactional increment.** Windows are aligned (`windowStart = floor(now / windowMs) * windowMs`), the counter is read and written in one transaction per call. Chosen over a sliding window (needs a log or two counters per bucket and two reads) because the exposure it fixes, up to 2x the limit across a window boundary, is already bounded by the lockout; chosen over a blind `FieldValue.increment` (cheaper) because the decision needs the value atomically. Cost per bucket per call: **1 read + 1 write**; per call at most 3 buckets in one transaction.
- **Multi-bucket atomicity.** `consume(specs)` reads all documents, decides, and writes increments only if **every** bucket allows; if any denies, only that bucket's `lockedUntil` is written (a request denied by `join_ip` does not burn `join_game_code`).

```ts
export interface LimitSpec { kind: string; raw: string | null /* null = skip, e.g. IP unresolved */; limit: number; windowMs: number;
  lockMs: number; mode: "attempt" | "failure"; cost?: number }
// attempt: counted by consume() before the work. failure: consume() only CHECKS the lock; the handler calls handle.fail(kind) after a failed lookup.

export function step(d: RateLimitDoc | undefined, s: LimitSpec, now: number): { allow: boolean; doc: RateLimitDoc; retryAfterMs?: number } {   // pure
  if (d && d.lockedUntil !== null && d.lockedUntil > now) return { allow: false, doc: d, retryAfterMs: d.lockedUntil - now };
  const ws = Math.floor(now / s.windowMs) * s.windowMs;
  const base = d && d.windowStart === ws ? d : { ...(d ?? blank(s)), windowStart: ws, count: 0, lockedUntil: null };
  if (s.mode === "failure") return { allow: true, doc: base };
  const count = base.count + (s.cost ?? 1);
  if (count > s.limit) { const until = now + (s.lockMs || (ws + s.windowMs - now)); return { allow: false, doc: { ...base, lockedUntil: until, expiresAt: ttl(until + s.windowMs) }, retryAfterMs: until - now }; }
  return { allow: true, doc: { ...base, count, expiresAt: ttl(ws + 2 * s.windowMs) } };
}
```

- **Lockout.** Exceeding the limit sets `lockedUntil = now + lockMs` (or the window end when `lockMs` is 0); while locked every request is denied without incrementing. `retryAfterMs` is the remaining lock, rounded up to whole seconds.
- **Response.** `{ok:false, reason:"RATE_LIMITED", version:0, retryAfterMs, sv}`, same shape for every callable, HTTP success. It reveals the bucket's remaining lock, nothing about the game, code or other callers.
- **TTL.** `expiresAt = windowEnd + windowMs` (or lock end + window for locked docs), on the TTL policy of LLD 3. TTL deletion lags up to a day, so `step` never trusts a stale doc: a document whose `windowStart` is older than the current window is reset, and a `lockedUntil` in the past is ignored.
- **Clock.** `deps.clock()` (LLD 0 P9), so tests control time.
- **Refund on hit.** Buckets marked "refund on hit" count a lookup before the work (ID11) and `handle.refund(kind)` decrements by one (floor 0) when the lookup **hits** a live game, so the bucket measures *misses*, the guessing signal. Cost: one extra write per hit.
- **Failure-counted buckets** (`rejoin_*`): `consume` only checks the lock; `handle.fail` runs `step` in `attempt` mode after a failed lookup. Successes are free.

### 7.2 IP derivation and privacy

```ts
export function clientIp(req: CallableRequest): string | null {
  const xff = String(req.rawRequest.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const raw = xff[xff.length - 1 - TRUSTED_HOPS.value()] ?? req.rawRequest.socket?.remoteAddress ?? null;  // default TRUSTED_HOPS = 0
  return raw ? normalizeIp(raw) : null;      // strip port/brackets, lowercase, IPv4-mapped to IPv4, IPv6 reduced to its /64
}
```

- **Header.** Gen2 functions run on Cloud Run behind Google's front end, which **appends** the address it observed to `X-Forwarded-For`; the leftmost entries are client-supplied and spoofable, so the *last* entry (adjusted by `TRUSTED_HOPS` for any proxy we later add) is used, never the first and not `req.ip` (Express' default with `trust proxy` takes the leftmost). This is an assumption verified at the first staging deploy by a smoke probe that sends a forged `X-Forwarded-For` and asserts the derived hash is unchanged (conflict 3, resolves LLD 4 conflict 11).
- **Unresolved IP.** `clientIp` returns `null`: per-IP specs are skipped (`raw: null`), the per-code, per-game and per-uid buckets still apply, and `ip.unresolved` is logged (alert on any occurrence). Fail open on a single dimension because App Check and the other buckets remain; failing closed would lock everyone out on a header change.
- **Privacy.** The raw IP is held in memory for the request only. Counter docs hold only the keyed hash and live at most about 3 hours. Logs carry `ipHash` computed with the different `LOG_HASH_SALT`, 12 hex characters (LLD 0), so a log line cannot be joined to a counter document. Rotating `RATE_LIMIT_HASH_SALT` resets all counters and is the incident lever.

### 7.3 Buckets and limits

Window is 1 h unless stated. `lock` 0 means "until the window ends". Limits and keys marked LLD 4 are the numbers LLD 4 section 9 asked for; the rest are this LLD's.

| Bucket | Key | Limit | Lock | Mode | Used by |
|---|---|---|---|---|---|
| `code_ip` | ipHash | 30 | 1 h | attempt, **refund on hit** (LLD 4: "30/h, all lookups"; see conflict 4) | `lobbyInfo`(code), `joinGame`(code) |
| `code_code` | code | 120 | 15 min | attempt | `lobbyInfo`(code) |
| `invite_ip` | ipHash | 60 | 1 h | attempt | `lobbyInfo`(gameId), `joinGame`(gameId) |
| `join_ip` | ipHash | 20 | 1 h | attempt | `joinGame` |
| `join_game_code` | gameId, **only after resolve** | 15 | 0 | attempt | `joinGame`(code) |
| `join_game_invite` | gameId | 40 | 0 | attempt | `joinGame`(gameId) |
| `rejoin_fail_ip` | ipHash | 10 failures | 1 h | failure | `rejoin` |
| `rejoin_fail_game` | claimed gameId string | 30 failures | 15 min | failure | `rejoin` (DoS accepted, below) |
| `spectate_ip` | ipHash | 60 | 0 | attempt | `spectate` |
| `reissue_uid` | uid | 30 | 0 | attempt | `reissueRejoinLink` |
| `signout_uid` | uid | 5 | 0 | attempt | `signOutEverywhere` |
| `vote_uid` | uid (spectator `castVote`) | 60 | 0 | attempt | `command` |
| `cmd_uid` | uid | 600 | 5 min | attempt | `command` except `saveDraft` and spectator votes |
| `draft_uid` | uid | 900 | 5 min | attempt | `command` `saveDraft` |
| `create_uid` | host uid | 10 | 0 | attempt | `createGame` |
| `create_ip` | ipHash | 30 | 1 h | attempt | `createGame` |
| `delete_uid` | host uid | 30 | 0 | attempt | `deleteGame` |
| `list_uid`, `profile_uid` | host uid | 60 | 0 | attempt | `listGamesByHost`, `hostProfile` |
| `push_uid` | uid | 20 | 0 | attempt | `registerPush`, `unregisterPush` |
| `email_addr` | normalized email | 5 | 1 h | attempt | `beforeEmailSent` (8.1) |
| `email_ip` | ipHash | 20 | 1 h | attempt | `beforeEmailSent` |

**Accepted DoS: `rejoin_fail_game`.** The bucket is keyed by the claimed `gameId` string, so anyone holding an invite (the `gameId`) can send 30 bad-secret `rejoin` calls and lock new-device rejoin for that game for 15 min. Accepted: signed-in players are unaffected, the lock expires by itself, one IP cannot sustain it (`rejoin_fail_ip`: 10 failures per hour), and dropping the per-game bucket would remove the cap on distributed secret guessing. Tests: API13.

`join_game_code` is keyed by `gameId` and therefore consumed only after the code resolved (a second `consume`, one extra transaction on the hit path), so counters never reveal that a code exists. All numbers are function params (`defineInt`) so an incident needs a redeploy of params, not code. Per-seat command limits exist to cap runaway clients and cost, not to police play: `cmd_uid` 600/h is 10 per minute sustained for a seat in a game that normally issues a handful per day.

**Behind shared NATs (a household or LAN joining at once).** All players share one `ipHash`.
- Ten players joining one game by code: `code_ip` is refunded on each hit, `join_ip` shows 10 of 20, `join_game_code` 10 of 15. Passes with margin; they also pass `invite_ip` (60) if using the invite link.
- Misses are what lock a household: a player mistyping a code five times consumes five of the 30 miss-units shared by everyone behind the NAT. 30 typos in an hour from one address is not a household, so the lockout stays.
- Two households' worth of joins (more than 20 in an hour from one IP) hit `join_ip`; the answer is `RATE_LIMITED` with `retryAfterMs`, and the invite link or a retry later works. `join_ip` is a param.
- `lobbyInfo` is optional for the client: the join form submits code and name together to `joinGame` (LLD 7), so a normal join is one lookup, not two.
- Carrier-grade NAT can place strangers behind one hash; their collateral lockouts are accepted as the cost of per-IP limits, and the 72 h code window and per-code buckets do not depend on IP.
- IPv6 users on one /64 share a hash; that is intended (a /64 is one subscriber).

**Cost** (list price, per call): `lobbyInfo` by code 2 reads + 2 writes + 1 `roomCodes` read (+ aggregate read on hit); `joinGame` by code 4 to 5 reads and writes plus the join transaction; `command` +1 read +1 write over LLD 3's table (about 10% on a 6-player game); `saveDraft` text-only goes from 3 reads/3 writes to 4/4. At this scale the total is cents per month.

### 7.4 Testing the limiter

Pure `step` unit tests (boundary at `limit` and `limit + 1`, window rollover, lock expiry, refund floor, failure mode, TTL-lagged stale doc); `consume` integration on the Firestore emulator with a controlled clock (atomicity across buckets: a denial by one bucket increments none of the others; parallel 50 requests on one bucket count exactly 50; refund; key hashing: no raw code, gameId, IP or email in any `rateLimits` doc id or field); bucket-table test that every row of 7.3 is exercised through its callable at N and N+1 (ID11, API7).

## 8. Per-email limits and Engine caps

### 8.1 Host sign-in email limits (A4): what is enforceable

`sendSignInLinkToEmail` is called by the client SDK directly against the Auth backend, so no callable of ours sees the request. Therefore:

| Control | Enforceable? | Status |
|---|---|---|
| Per-email and per-IP caps in our code on the client-SDK path | No | impossible without routing the send through a server, which would need an email provider and contradicts N5 and tech-stack section 4 |
| Firebase's built-in per-project email quota and per-IP throttles | Yes (infrastructure) | relied on; unchanged |
| App Check enforcement on Auth endpoints | Yes, after the Identity Platform upgrade | required by LLD 4 section 13 |
| **`beforeEmailSent` blocking function** applying `email_addr` (5/h) and `email_ip` (20/h) via the same `limits.consume` | Yes **if** the pinned `firebase-functions` supports it for email-link sends and the project is on Identity Platform | **Decision: implement it if the scaffold-time check passes** (`functions/src/api/emailGuard.ts`, exported and listed in `exports.json`); the handler throws `HttpsError("resource-exhausted")`, which the client shows as a generic "try again later" |
| Client cooldown (60 s, 5/h per browser) | UX only | LLD 4 3.3 |
| Alert on the Auth email-volume metric | Yes | LLD 0 `ops/` |

If the blocking function is unavailable, the residual is inbox spam to a third party using Firebase's sender, accepted for v1 (LLD 4 conflict 1) with the alert as the tripwire. The email address is hashed (`email_addr`) before it touches a counter and is never logged.

### 8.2 Engine caps raised by earlier LLDs

| Cap | Raised by | Enforced where | Rejection | Notes |
|---|---|---|---|---|
| Total joins per game `MAX_TOTAL_JOINS = 50` | LLD 2 q9, LLD 3 q8 | **Engine** `join`: `totalJoins >= MAX_TOTAL_JOINS`, a monotonic counter incremented on every successful join and never decremented (so LOBBY leavers whose player record is deleted still count), in addition to the seated >= 10 rule | `ROOM_FULL`, detail `join_cap` | Bounds `players[]`, tombstone docs and write count (LLD 3 5.7). The API cannot count players without a read it does not make; `lobbyInfo` already reports `joinable:false` for a full room |
| Votes per game `MAX_VOTES = 1500` | LLD 1 q9, LLD 3 q8 | **Engine** `castVote`: `votes.length >= 1500` and the vote is not a replacement | `VARIANT_UNAVAILABLE`, detail `vote_cap` | Bounds the aggregate (LLD 3 2.5) |
| Votes per spectator per hour | LLD 4 | **API** `vote_uid` 60/h | `RATE_LIMITED` | Slows a vote flood before it reaches the cap |
| Per-field payload size and array length | LLD 1 X1 | **API schema** (`WIRE_TEXT_MAX`, `WIRE_DRAFT_MAX`) as a DoS guard; **Engine** for the semantic limits (`TEXT_LIMITS`: 24/80/140 code points, `writeTarget`) | shape failure (`invalid-argument`) vs `INVALID_ARGUMENT`/`CONTENT_REJECTED` | The edge caps are looser than the Engine's on purpose, so they never reject what the Engine would accept |
| Aggregate size, writes per transaction | LLD 3 | **Store** `AGGREGATE_TOO_LARGE`, `TOO_MANY_WRITES` | `resource-exhausted` | Backstop if the Engine caps are missing |

`MAX_TOTAL_JOINS` and `MAX_VOTES` live in `contracts/limits.ts` so Engine, API and tests share one value. **Resolved:** LLD 1 enforces both checks and returns the two details (conflict 6a).

## 9. Observability

Extends LLD 0 section 9. The wrapper emits one line per call through the typed logger (LLD 0 `log.ts`); the Store keeps emitting `command.done`, `command.rejected`, `txn.retry` (LLD 3). The `command` metrics in LLD 0 are fed by the Store's lines; API metrics below are fed by `api.done`.

| Field | Where | Meaning |
|---|---|---|
| `event` | all | `api.done` (every callable, once), `api.gate` (App-Check-adjacent and version gates), `rate.limited`, `api.detail.stripped`, `ip.unresolved` |
| `callable`, `principalKind` (`host`\|`seat`\|`spectator`\|`guest`\|`none`), `clientV` | `api.done` | **New fields; LLD 0's typed logger must add them** (conflict 5) |
| `outcome` (`ok`\|`rejected`\|`error`), `reason` | `api.done` | `reason` is an `ErrorCode` or the log-only `INVALID_REQUEST`, `UNAUTH`, `CLIENT_OUTDATED`, `INTERNAL`, `CONTENTION`, `UNAVAILABLE`, `LIMIT_REACHED` |
| `latencyMs`, `replay` | `api.done` | end to end in the wrapper; `replay` true on a ledger hit |
| `bucket`, `retryAfterMs`, `ipHash`, `uidHash` | `rate.limited` | HMAC with `LOG_HASH_SALT`, 12 hex characters (LLD 0); never raw |
| `gameId`, `version`, `playerId`, `commandType` | game-scoped lines | allowed as in LLD 0 |

**Metrics** (log-based, `ops/metrics/*.yaml`, applied by `ops-apply`; LLD 0 P20):

| Metric | Definition | Labels |
|---|---|---|
| `dc_api_total` | counter, `event="api.done"` | `callable`, `outcome`, `reason` |
| `dc_api_latency_ms` | distribution of `latencyMs` on `api.done` | `callable` |
| `dc_ratelimit_total` | counter, `event="rate.limited"` | `bucket` |
| `dc_api_invalid_total` | counter, `api.done` with `reason="INVALID_REQUEST"` | `callable` |
| `dc_client_outdated_total` | counter, `api.done` with `reason="CLIENT_OUTDATED"` | `clientV` |
| `dc_idem_replay_total` | counter, `api.done` with `replay=true` | `callable` |
| `dc_appcheck_denied_total` | counter from Cloud Run request logs (`httpRequest.status=401`), not our lines; it is every 401 at the edge, not only App Check denials, which is why the alert reads as an aggregate edge-denial rate | `callable` (the Cloud Run service name) |

**Alerts added** (same notification channel as LLD 0): `dc_api_invalid_total` above 1% of calls for 15 min (contract drift or a broken client); `dc_client_outdated_total` nonzero for more than 24 h after `MIN_V` was raised (informational); `ip.unresolved` any occurrence; any `api.detail.stripped`; `dc_ratelimit_total{bucket=code_ip}` spike (LLD 4's global miss alert uses it); `dc_appcheck_denied_total` sustained above baseline.

**Classification.** *Rejection* (`outcome=rejected`): any body with `ok:false`, `RATE_LIMITED`, and the gates (`unauthenticated`, `invalid-argument`, `CLIENT_OUTDATED`). Logged at INFO (gates at WARNING), plain structured line, **never** an `Error` object and never in Error Reporting. *Failure* (`outcome=error`): `INVARIANT`, `internal`, `resource-exhausted`, output-schema failure and unknown throws are logged as `Error` objects (Error Reporting groups them, LLD 0 alert "new group"); the line an unknown throw produces carries `event="api.error"` (LLD 0 section 9), and the `dc_api_error_total` counter over those lines is what LLD 0's function-failure alert watches, so it fires on this class only; retryable `CONTENTION` and `UNAVAILABLE` are `outcome=error` at WARNING without an `Error` object so a bad minute does not page, while the error-rate alert (above 2%) still counts them.

**Never logged**, anywhere, including `HttpsError` messages (extends LLD 0 P19): request and response bodies; `idempotencyKey` and the ledger fingerprint; any payload id of a command (`cardId`, `submissionId`, `removePlayer.playerId`), because a log pairing `playerId` with a card id before the result would break E9; `pitch`, card text, drafts, display names, room codes, emails; seat secrets, rejoin URLs, custom tokens, ID tokens, App Check tokens, FCM tokens and endpoints; raw IPs; zod issue **values** (paths only); the `view` of any response.

## 10. Testing

### 10.1 Contract tests (`packages/contracts/test`, `packages/engine/test/contracts-compat.test.ts`)

| Test | Assertion |
|---|---|
| Command table (built, #18) | A fixture per client command parses with `CommandEnvelopeSchema`; `toEngineCommand` output deep-equals the Engine command of LLD 1 section 7; required-`expectedVersion` set equals `{confirmSubmission, writeIn, closeSubmissions, pickWinner, passJudging}` |
| Engine round trip (in `engine/test`, since contracts cannot import the Engine) | For every `legalCommands` entry of random scenarios (LLD 1 15.1) that is a client command: wrap in an envelope, JSON round trip, parse, `toEngineCommand`, deep-equal the original (G1-style) |
| Type equality | `ClientCommandType \| ServerOnly` equals `Command["type"]`; `ErrorCode`, `Phase`, `PlayerStatus`, `RoundPhase` equal the Engine's (built, #27; `YouTurn` is pinned by an exhaustive table, the Engine has no such type until 2.2); `project` returns the contracts `GameView` (LLD 2 11.6) |
| View schemas (built, #27: fixtures per audience; extra and missing key at every object path; PJ7 fields; loose rule; enum tuples; `JSON.parse(JSON.stringify(game))` in `engine/test/view-schema-vs-game.test.ts`; still waiting for the golden snapshots: step 2.2, #28) | Every golden snapshot of LLD 2 11.5 parses with the strict and the loose schema; the strict schema rejects an extra key, a missing key, `uid`, `scorePile`, and `JSON.parse(JSON.stringify(game))`; loose accepts extra keys and unknown strings in every enum position (a snapshot with `turn: "future_turn"` parses loose, fails strict) |
| Limits export | `MAX_SEATED`, `MAX_TOTAL_JOINS` (50), `MAX_VOTES` (1500) and `TEXT_LIMITS` (`{name:24, card:80, pitch:140}`) are exported from the index; `WIRE_TEXT_MAX` exceeds every `TEXT_LIMITS` value; `DETAIL_BY_CODE.ROOM_FULL` is `["join_cap"]`, `VARIANT_UNAVAILABLE` is `["vote_cap"]`, `NOT_AUTHORIZED` contains `seat_revoked`; the Engine imports the constants (no literal 50 or 1500 in its `join`/`castVote`) |
| Push schemas | `RegisterPushRequestSchema` accepts and rejects at the exact boundaries of the LLD 6 regexes (`deviceId` 8 and 40 chars; `fcmToken` 50 and 4096) |
| Error closure | Every `DETAIL_BY_CODE` value is in the `RejectionSchema` enum; every Engine `Rejection.detail` string appears in `DETAIL_BY_CODE[code]` (scan of the Engine's `reject()` call sites) |
| No authority fields (A2) | No request schema has a key named `role`, `uid`, `hostId`, `isHost`, `actor`, `isJudge` |
| Reserved callables | None of `RESERVED_CALLABLES` is in `CALLABLES` or `exports.json` |
| Isolation | `package.json` dependencies are exactly `{zod}`; the module graph imports no `node:*`, `bun:*`, `firebase*`; the schemas run in a browser context (Playwright `evaluate` smoke) |

### 10.2 Callable integration (Auth + Firestore + Functions emulators against the Node bundle, LLD 0 P9)

| Case | Setup | Expected |
|---|---|---|
| Auth missing | `command` with no ID token | `HttpsError unauthenticated`; no Firestore write (document `updateTime`s unchanged) |
| Guest on a non-guest callable | same for `spectate` | `unauthenticated` |
| Wrong principal | spectator sends `pickWinner`; seat sends `createGame`; spectator sends `reissueRejoinLink` | body `NOT_AUTHORIZED`, `version: 0`, no state read for the game |
| Cross-game seat | seat of g1 calls `command` for g2 | `NOT_AUTHORIZED`; g2 aggregate never read (ID2) |
| Revoked seat | remove player, immediate old-token `command` | `NOT_AUTHORIZED` without waiting for token expiry (ID3) |
| Server-only command types | `command` with `type: "deleteGame" \| "join" \| "createGame" \| "markReminded" \| "importDeck"` | `invalid-argument`; nothing written |
| Version gate | `v: 0` (below `MIN_V` in a test build) | `failed-precondition` with details `CLIENT_OUTDATED`; body not parsed (send a garbage body) |
| Skew tolerance | request with an extra unknown field and `v` above server | accepted, field stripped |
| STALE | judge sees JUDGING; host `passJudging`; judge `pickWinner` with the old `expectedVersion` and a new key | body `STALE`, no state change; same pick with a fresh view version succeeds |
| STALE after ledger | accept `pickWinner`, round advances, resend same key and old `expectedVersion` | `ok:true, replay:true`, `version` = original, `view.version` greater |
| Replay | same key twice; 8 parallel same key | one version bump, identical `version`, one ledger doc; `replay` true on all but one |
| Key reuse | same key, different payload | `invalid-argument`; first command's effect unchanged (API5) |
| Missing `expectedVersion` | `pickWinner` without it | `invalid-argument` |
| Rate limit | 601st `command` in an hour for one uid; N+1 for each row of 7.3 | `RATE_LIMITED`, `retryAfterMs > 0`, then success after the clock advances past the lock; counter ids contain no raw values |
| Shared NAT | 10 joins from one IP by code | all succeed, `code_ip` count 0 after refunds; 31 misses lock the IP, `lobbyInfo` and `joinGame` both `RATE_LIMITED` |
| App Check missing | token validity cannot be checked in the emulator, which only requires the header to be present (LLD 0 section 6) | unit: registry introspection asserts `enforceAppCheck: true` on every `defineCallable`; staging smoke: call without a token must fail |
| Non-leak equality | `pickWinner` with an unknown id vs an id from a past round; `confirmSubmission` with an unknown id vs another player's card id | responses byte-identical, including `detail` absence |
| Hidden-state sentinels | full game with sentinel names, card text, emails, secrets (LLD 0 P19) | no sentinel in any response body outside the caller's own view, nor in any log line; no `HttpsError` message contains input |
| Outcome mapping | inject `faults` for `CONTENTION`, `UNAVAILABLE`, `INVARIANT`, oversize aggregate | `aborted`, `unavailable`, `internal`, `resource-exhausted`; none is a body with `reason` |
| Output strictness | handler stub returning an extra field or a view with `uid` | `internal`; the field never reaches the client (API8) |
| `deleteGame` | host with a revoked session; repeat call | `NOT_AUTHORIZED`-class refusal for the revoked session (LLD 4 ID12); repeat returns `NOT_FOUND` (never `replay:true`; no `replay` field in the success body) which the helper maps to success |
| `registerPush` shape | `deviceId` of 7 or 41 chars or containing `.`; `fcmToken` of 49 or 4097 chars or containing a space; omitted `deviceId` | `invalid-argument` for each violation; omitted `deviceId` accepted |
| Seat revoked detail | removed seat calls `command` | body `NOT_AUTHORIZED`, `detail: "seat_revoked"`, `version: 0` |
| `rejoin` malformed input | `secret` missing, a number, 10 KB, or a non-GameId `gameId` | body `NOT_FOUND`, `version: 0`, byte-identical to a wrong secret; one failure counted; never `invalid-argument` |
| Join key replay | `joinGame` commits; room code then released; retry same key before any sign-in; then sign in and retry again | first retry `ok:true, replay:true` with the same seat; second `NOT_FOUND`; no log line contains the key or its hash |
| Rejection `version` | identity-callable rejections with and without a game read (rate limit, unknown code, `NAME_TAKEN`) | every body has `version`; `0` without a game read, the decision version with one |
| `rejoin_fail_game` lock | 30 bad-secret `rejoin` calls (distinct IPs) for one gameId, then a correct secret | 31st call `RATE_LIMITED`; the correct secret is also `RATE_LIMITED` until 15 min pass; signed-in seats still work (API13) |

### 10.3 Registry tests (unit, `bun test functions/src/api`)

`REGISTRY` equals `functions/exports.json` for callables; every spec declares `allow` and `limits`; every `limits(...)` key builder returns no raw IP (hashed in `consume`, never in the spec); the pipeline order is asserted with a spy handler (a request failing step N never reaches step N+1). Landed in #12 (`functions/src/api/callable.test.ts`): registry keys equal the callable subset of `exports.json`, `allow` present, options and `__endpoint`, the auth-presence check and the `internal` mapping; `limits` and the pipeline-order spy arrive with #38.

### 10.4 Client/server compatibility test

1. **Schema diff gate** (`bun run test:compat`, every PR): regenerates JSON Schema for every request and response from the current `CALLABLES` and compares it with the newest `compat/v*.json` using the additive rules of 2.6: a request may gain optional properties only; no required request property added or removed; response and view properties may only be added (never removed or retyped); enum members may be added in responses and views, never removed anywhere; a failure is fixed by bumping `CONTRACT_V` and keeping an adapter, not by editing the snapshot. Snapshots are committed at each release tag.
2. **Old-client fixtures**: for each frozen version, recorded request fixtures (`compat/fixtures/v{N}/*.json`, one per callable and command type) are replayed against the current bundle in the emulator suite and must succeed (or return the same typed rejection); recorded response fixtures are parsed with the **old** loose schemas (kept in the snapshot) and must pass.
3. **Outdated-client path**: a build with `MIN_V` raised answers an old fixture with `CLIENT_OUTDATED` and the web test double shows the reload screen (Playwright, LLD 7).
4. **View skew**: a `ViewDoc` with `schema` above the client's `VIEW_SCHEMA` produces the hard block; a doc with extra fields renders.

### 10.5 Smoke (LLD 0 `scripts/smoke.ts`)

`lobbyInfo({code: "BBBB"})` (cheap, App Check required, returns `joinable:false`) with the debug token must return `ok:true`; the same call with no token must fail; the forged-`X-Forwarded-For` probe of 7.2; the declared-queries check of LLD 3 for `listGamesByHost`.

## 11. Invariants

### 11.1 HLD A1 to A4

| # | Mechanism | Tests |
|---|---|---|
| **A1** every request resolves to exactly one `Principal` or is rejected before any other component | Steps 2 and 5 of the pipeline; `principalOf` is total (LLD 4 ID1); handlers receive `principal` and cannot run without it; `guest` only where `allow` says | auth-missing, wrong-principal rows of 10.2; pipeline-order spy test |
| **A2** commands authorized by role in the game, not client claims | No role field exists in any request schema; `toActor` carries `uid` only; the Engine's `actorRole` decides; spectators limited to `castVote`; server-only commands unreachable (API4) | no-authority-fields test; wrong-principal rows; Engine E1 matrices |
| **A3** responses contain only Projector output or an explicit DTO | Strict output schemas parsed on every response (API8); views come from `makeProjector` and are re-parsed with `GameViewSchema`; non-game callables return named DTOs | output-strictness and sentinel rows |
| **A4** join and sign-in endpoints rate-limited per IP and per code | Section 7.3 buckets; `beforeEmailSent` for email sends where available (8.1); sign-in beyond that is Firebase's | Rate-limit rows; shared-NAT row; LLD 4 ID11 |

### 11.2 New API invariants

| # | Invariant | Mechanism and tests |
|---|---|---|
| **API1** | Every deployed callable is registered through `defineCallable` with an explicit `allow`, `limits`, `runtime`, and `enforceAppCheck: true`; `REGISTRY`, `exports.json` and the bundle's exports agree | Registry tests (10.3); LLD 0 check-bundle; lint P12 |
| **API2** | The pipeline order of 4.1 is fixed: no handler runs before auth presence, version gate, parse, rate limit and principal resolution; the only Firestore reads before the limiter are none | Spy-handler order test; emulator read-count assertion for a malformed request (zero reads) |
| **API3** | Every response body is one arm of a strict schema; `detail`, when present, belongs to `DETAIL_BY_CODE[reason]`; `HttpsError` messages are fixed strings; no response or error echoes request values | Output-strictness, error-closure, non-leak equality tests |
| **API4** | `command` accepts exactly the 15 client command types; `createGame`, `join`, `deleteGame`, `importDeck`, `markReminded` are unreachable through it; a spectator principal can send only `castVote` | Server-only-type rows; type test on `ClientCommandType` |
| **API5** | `(actor, idempotencyKey)` is applied at most once per game; a replay returns the original `version` and the caller's current view; reuse of a key with a different command is an error and applies nothing | Replay, STALE-after-ledger and key-reuse rows (with LLD 3 ST3) |
| **API6** | `expectedVersion` is required for the five round commands and only ever passed through untouched; the ledger is consulted before `STALE` | Schema test; STALE rows |
| **API7** | Limits are consumed before any lookup that differentiates cases; multi-bucket consumption is atomic; counters hold only keyed hashes and expire; a locked bucket denies without incrementing | Limiter tests (7.4); no-raw-values scan |
| **API8** | Every success body is strict-parsed before it leaves; an unparseable body is an `internal` failure, never sent | Output-strictness row |
| **API9** | Within a `CONTRACT_V` changes are additive; `v < MIN_V` yields `CLIENT_OUTDATED` before body parsing; every body carries `sv`; a view schema above the client's is detected client-side | Compat gate, outdated-client and view-skew tests |
| **API10** | Logs and errors never contain bodies, idempotency keys (nor the join key hash), command payload ids, tokens, secrets, raw IPs, emails, room codes, names or card text | Sentinel scan (LLD 0 P19) extended with idempotency keys and fingerprints |
| **API11** | Rejections are never thrown or classified as failures; failures never carry an `ErrorCode` body; retryable failures are distinguishable from definitive ones by `HttpsError` code | Outcome-mapping row; classification test on logs |
| **API12** | `@dc/contracts` depends only on zod and runs in Node and browsers with no Node, Bun or Firebase import | Isolation test; lint P5 |
| **API13** | `rejoin_fail_game` is a deliberate, bounded DoS: an invite holder can lock new-device rejoin for one game for 15 min, never affecting signed-in seats or other games; the lock expires by itself | `rejoin_fail_game` lock row |
| **API14** | Caps and text limits have one source: `MAX_TOTAL_JOINS`, `MAX_VOTES`, `TEXT_LIMITS` are exported from contracts and imported by Engine and web; `join_cap`, `vote_cap`, `seat_revoked` are in `DETAIL_BY_CODE`; `registerPush` inputs are shape-checked per LLD 6 2.2 | Limits-export, push-schema, seat-revoked rows |
| **API15** | A replay of `deleteGame` is `NOT_FOUND`, never `replay:true`; the client treats it as success | `deleteGame` row |

## Open questions / conflicts

1. **`callable()` vs `defineCallable`. Resolved (C-CALLABLE).** The wrapper is `defineCallable` in `functions/src/api/callable.ts`; `callable` is a deprecated alias from the same file. LLD 0's lint exception, file tree and P12 move to this path and name and list `allow`, `limits`, `gameIdOf`, strict output parsing and `sv` (L0 aligns).
2. **`idemKey` vs `idempotencyKey`.** HLD 4.2 and this LLD use `idempotencyKey` on the wire; LLD 4's `JoinInput` writes `idemKey`. Resolved (C-IDEM) to `idempotencyKey` for every request and handler; `idemKey` remains only an internal Store field name. LLD 4's `JoinInput` and handler code take the one-word change.
3. **Client IP.** LLD 4 conflict 11 assumed `rawRequest.ip`. This LLD uses the last `X-Forwarded-For` entry (adjustable `TRUSTED_HOPS`) and skips per-IP buckets when unresolved. It is an assumption about the gen2 front end that must be proven by the forged-header smoke probe at the first staging deploy; if false, the derivation changes in one function.
4. **`code_ip` semantics differ from LLD 4's table.** LLD 4 says 30/h "all lookups" (shared by `lobbyInfo` and `joinGame`). Here hits are refunded, so the bucket counts misses. Rationale: a household of 10 would otherwise consume 20 of 30 and two games a night would lock them out. Guessing economics (LLD 4 8.3) are unchanged to within `1 - p` where `p` is about 0.001; the extra hit load is bounded by `join_ip`, `join_game_code` and `code_code`. Resolved: LLD 4 8.3 adopts "counts misses, refunds hits" (fix plan).
5. **Logger fields.** LLD 0's typed field set lacks `callable`, `principalKind`, `clientV`, `replay`, `bucket`, `retryAfterMs`, and the events `api.done`, `api.gate`, `api.detail.stripped`, `ip.unresolved`. LLD 0 section 9 adds them (plus `rowId`, `kind`, `recipients`, `devices`, `eventToFcmMs`, `result` and the `api.*`/`notify.*` events), and its `outcome`/`reason` description allows the log-only reasons of section 9. Open until LLD 0 lands.
6. **Engine additions requested.** (a) **Resolved (C-CAPS, LLD 1 7.1):** `join_cap` (`totalJoins >= 50`, `ROOM_FULL`) and `vote_cap` (`votes.length >= 1500`, `VARIANT_UNAVAILABLE`) with those exact `detail` strings, constants imported from contracts; (b) `Rejection.detail` strings enumerated closed in `DETAIL_BY_CODE`; any new detail in the Engine must be added here first (error-closure test fails otherwise); (c) the Engine to import `Command`, `ClientCommand`, `ErrorCode` and the enum tuples from `@dc/contracts`; (d) `updateSettings.patch` for nested `variants`/`spectators`: resolved, LLD 1 replaces them, does not merge (fix plan 15); the contract sends them whole (conflict 10).
7. **HLD 4.3 amendment.** The taxonomy gains `NOT_PLAYABLE`, `INVALID_ARGUMENT`, `VARIANT_UNAVAILABLE` (adopted from LLD 1) and the gate-only `CLIENT_OUTDATED`. HLD sections 4.2/5 also need: `v`/`sv`, the separate `createGame`/`deleteGame` callables, and `replay`.
8. **Replay response (resolved).** Replay returns original `version` and the caller's current view, so `version` can be below `view.version` (LLD 3 conflict 10, LLD 2 8.4). Documented as part of the contract; LLD 7 orders by `view.version`.
9. **`hostProfile`.** LLD 4 creates `hosts/{uid}` lazily inside `createGame` and `listGamesByHost`. A `hostProfile` bootstrap callable is added here because the task lists a host profile callable and the client benefits from a server-verified post-sign-in call; it can be dropped without effect on the rest.
10. **Settings patch.** LLD 1 types `patch: Partial<Settings>`; whether nested objects merge is unspecified. The contract requires complete `variants` and `spectators` objects when present, which behaves the same under either reading.
11. **Edge validation vs Engine ranges.** `WIRE_TEXT_MAX` (400 UTF-16 units) and `WIRE_DRAFT_MAX` (40) must stay above the Engine's limits, including a late joiner's `writeTarget`, which can exceed 10 red (LLD 1 9.4). `CardId` alphabet was left open by LLD 1 ("base-32"); the regex accepts `a-z0-9`.
12. **Game existence oracle.** A spectator-level caller can distinguish a real game (`NOT_AUTHORIZED`) from an unknown one (`NOT_FOUND`) through `command`. Ids are 119-bit unguessable and the ids are already in every invite link; accepted. Making both `NOT_FOUND` would break the Engine's guard order.
13. **`pushSubs` keyed by `{uid}_{gameId}`** (LLD 3, tech-stack) allows one FCM token per seat per game; a player with two devices (rejoin on a second phone, LLD 4) would overwrite the first. `registerPush` takes an optional `deviceId` so LLD 6 can switch to an array or `{uid}_{gameId}_{deviceId}` without a contract change. **Resolved by LLD 6 section 2:** doc id stays `{uid}_{gameId}` with a `devices` map keyed by `deviceId` (max 5); the `deviceId`/`fcmToken` constraints are in 3.3. LLD 6 owns membership validation inside `registerPush`.
14. **Runtime option support. Resolved (issue #6, proven in #15).** `cpu: 1` with `memory: 256MiB`, `concurrency: 80`, `consumeAppCheckToken: false`, `enforceAppCheck: true` and a `minInstances` param (`COMMAND_MIN_INSTANCES`) deploy on the pinned `firebase-functions` 7.4.0: the deployed functions report exactly that shape (`256Mi`, `cpu: 1`, `maxInstanceRequestConcurrency: 80`, `minInstanceCount: 0`, `serviceAccountEmail: fn-runtime@deepcuts-staging.iam.gserviceaccount.com`). One correction: `serviceAccount` must be written `fn-runtime@` (the CLI resolves the project suffix); a bare `"fn-runtime"` makes the CLI drop the function with an empty error message. `minInstances: 1` on prod `command` adds a small fixed monthly cost; revisit after measuring.
15. **Preview channels.** LLD 0 conflict 1 stands: previews call staging functions from `main`. The `v` gate and additive-only rules make a web preview newer than staging safe for compatible changes; a breaking contract change cannot be previewed end to end until `CONTRACT_V` handling is deployed to staging first.
16. **Hot counter documents.** A shared-NAT burst (10 joins at once) writes `join_ip` ten times within a second, above Firestore's ~1 write/s/document guideline. Transactions retry and the burst is short, so it is accepted; if contention shows in `txn.retry`-like metrics for `consume`, shard the counter (not designed here).
17. **Per-email `beforeEmailSent`. Resolved (issue #7, proven in #15).** The pinned `firebase-functions` 7.4.0 supports `beforeEmailSent`, the deploy accepts it and the CLI registers it in Identity Platform (`blockingFunctions.triggers.beforeSendEmail`), so 8.1's plan stands. Two corrections for 8.1: a blocking function defaults to **`us-east1`**, so its region must be set explicitly if it is to sit with the callables; and deleting it leaves the Identity Platform registration behind (clear it with a `blockingFunctions` PATCH). Whether Identity Platform actually invokes it on a real email-link send is unproven until the identity step builds it — #15 deployed a pass-through stub only.
18. **Timeout vs transaction time.** The 30 s function limit is shorter than the Store's worst case of 8 pessimistic-lock attempts under heavy contention; the outcome on timeout is "unknown", resolved by same-key retry. If contention metrics show timeouts, reduce `maxAttempts` or raise the limit.

## Interfaces to other LLDs

| LLD | This LLD provides | This LLD expects |
|---|---|---|
| 0 Platform | `defineCallable`/`callable` (P12), `functions/exports.json` entries for every callable plus `beforeEmailSent`, `RESERVED_CALLABLES` guard, runtime options per callable (3.2), params (`COMMAND_MIN_INSTANCES`, `TRUSTED_HOPS`, limit numbers), `lobbyInfo` as the smoke target, metric and alert definitions of section 9, `contracts` package rules (zod only, Node and browser) | Logger fields and events of conflict 5; `RATE_LIMIT_HASH_SALT`, `LOG_HASH_SALT`, `SEAT_DERIVATION_KEY` bound per function; `rateLimits` TTL policy; emulator `clock()` and `faults` (P9); App Check enforcement per callable plus the smoke test; support for the runtime options in conflict 14; Identity Platform for the blocking function |
| 1 Engine | Authoritative zod for every client command payload; exported `Command`, `ClientCommand`, `ErrorCode`, enum tuples, `MAX_TOTAL_JOINS`, `MAX_VOTES`, `TEXT_LIMITS`, `DETAIL_BY_CODE`; the envelope-to-command mapping `toEngineCommand`; `RATE_LIMITED` produced only here | `decide` unchanged; `join_cap` (`totalJoins`) and `vote_cap` checks (conflict 6, resolved); `Rejection.detail` strings within `DETAIL_BY_CODE`; types imported from contracts; `expectedVersion` semantics of LLD 1 5.3 step 3 |
| 2 Projector | `GameViewSchema`, `ViewDocSchema`, `RoundDocSchema` (strict) and loose twins; strict re-parse of the response view (API8); enum equality tests | `project` returns the contracts `GameView`; field-for-field fidelity of the LLD 2 4.2 text to the schema; `PROJECTOR_REV` bumps on content change; `makeProjector(next)(viewerFor(...))` result in `CommandOutcome.view` |
| 3 Store | A single caller of `runCommand` per command, with `meta.fp`; `createGame` and `deleteGame` callables around LLD 3 6.1 and 6.4; `listGamesByHost` handler over the declared query; the `StoreError` to `HttpsError` table; limiter stored under `rateLimits` | `CommandOutcome` as in 5.1 (including `meta` echo and `replay`); `StoreError` kinds and `fp`-compatible `meta` (<= 1 KiB); ledger-before-`STALE`; `listGamesByHost` query and index; `rateLimits` TTL (ST11); `AGGREGATE_TOO_LARGE`/`TOO_MANY_WRITES` kept as failures |
| 4 Identity | Pipeline calling `principalOf` then `assertSeatLive`; `allow` lists per callable (3.1); schemas and callables for `joinGame`, `lobbyInfo`, `rejoin`, `spectate`, `reissueRejoinLink`, `signOutEverywhere`; `limits.consume/refund/fail`; section 7.3 buckets including LLD 4's numbers; `beforeEmailSent` | `principalOf`, `toActor`, `assertSeatLive`, `ensureHostProfile`, deterministic join minting, handlers that return bodies or throw `RejectionError` (`reject()` is the throwing form of a body); LLD 4's acceptance of conflicts 2 and 4; `deleteGame` session recheck (ID12) called from the `deleteGame` handler |
| 6 Notifications & Scheduler | `registerPush`/`unregisterPush` request and response schemas, auth (seat or host), limits (`push_uid`); the Scheduler is not a client and uses `{kind:"system"}` with `markReminded`, which is not in the client envelope | Storage and membership validation behind `registerPush` (device model, conflict 13); `Notifications.registerSubscription`/`unregisterSubscription` signatures taking `(uid, gameId, fcmToken, deviceId?)`; no card text in push (N2) |
| 7 Web Client | Typed `call()` helper generated from `CALLABLES`; `CONTRACT_V`/`sv`/`VIEW_SCHEMA` handling rules (2.6); retry table (6.5); key generation rules (6.3); `expectedVersion = view.version` rule (6.2); loose view schemas; default branches for unknown enums; error rendering per code and `detail` | Sends `v` on every call; serializes and debounces `saveDraft`; persists keys until a definitive answer; hard-block screen for `CLIENT_OUTDATED` and unknown `ViewDoc.schema`; soft banner on `sv` above its own; submits code and name together to `joinGame`; treats `deleteGame` `NOT_FOUND` as success; orders view snapshots by `(version, viewsRev)` and command responses by `view.version`; keeps the `joinGame` key only in `sessionStorage` until the response is persisted, never logged (6.3); initializes App Check before any call or listener |
