import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as logger from "firebase-functions/logger";
import { KEYS, log, logError } from "./log";
import type { LogFields } from "./log";

// LLD 0 section 9: the logger takes the whole typed field set; an unknown event or key is a type error and is dropped
// at runtime. T4a and T4c's exhaustive half are checked by `bun run typecheck`; the rest by this file.
const written: Record<string, unknown>[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => void (spy = spyOn(logger, "write").mockImplementation((entry) => void written.push({ ...entry }))));
afterEach(() => (written.length = 0));
afterAll(() => spy.mockRestore());

/** The 27 events of LLD 0 section 9, spelled out so a rename or a dropped event fails here too. */
const EVENTS = [
  "command.done",
  "command.rejected",
  "txn.retry",
  "store.size.warn",
  "deletion.stuck",
  "roomcode.collision",
  "api.done",
  "api.gate",
  "api.detail.stripped",
  "rate.limited",
  "ip.unresolved",
  "api.error",
  "auth.join",
  "auth.rejoin",
  "auth.reissue",
  "auth.revoke",
  "auth.purge.partial",
  "notify.row.done",
  "notify.dedupe",
  "notify.payload_invalid",
  "notify.poison",
  "push.result",
  "push.register",
  "push.unregister",
  "reminder.sweep.done",
  "reminder.sweep.game_failed",
  "outbox.redrive",
] as const;

/** One line with every field set, to prove KEYS carries the whole field table through. */
const FULL = {
  event: "notify.row.done",
  callable: "command",
  principalKind: "seat",
  clientV: 3,
  gameId: "g1",
  version: 7,
  commandType: "submit",
  outcome: "ok",
  reason: "INVALID_REQUEST",
  playerId: "p1",
  latencyMs: 12,
  attempts: 2,
  replay: true,
  bucket: "code_ip",
  retryAfterMs: 1500,
  rowId: "v7_1",
  kind: "Reminder",
  recipients: 4,
  devices: 5,
  eventToFcmMs: 900,
  result: "invalid_argument",
  ipHash: "0123456789ab",
  uidHash: "ba9876543210",
  count: 3,
  sent: 2,
  pruned: 1,
  failed: 0,
  skipped: 0,
  pages: 1,
  listed: 6,
  replayed: 1,
  noop: 0,
} as const satisfies LogFields;

test("T4a every event of LLD 0 section 9 is accepted and written", () => {
  for (const event of EVENTS) log({ event });
  expect(written.map((w) => w["event"])).toEqual([...EVENTS]);
});

test("T4a an event not in the list is a type error", () => {
  // @ts-expect-error not in the event list
  log({ event: "made.up.event" });
});

test("T4b LogEvent and the LLD 0 section 9 event row cannot drift", () => {
  const lld = readFileSync(join(import.meta.dir, "../../docs/lld/00-platform-build-deploy.md"), "utf8");
  const row = lld.split("\n").find((line) => line.startsWith("| `event` |"));
  expect(row).toBeDefined();
  for (const event of EVENTS) expect([event, row?.includes(`\`${event}\``)]).toEqual([event, true]);
});

test("T4b LogFields and KEYS cannot drift from the LLD 0 section 9 field table", () => {
  // The same drift guard as the event row, over the field rows: a field added to the table (or dropped from the type)
  // fails here rather than surviving as a silently dropped key.
  const lld = readFileSync(join(import.meta.dir, "../../docs/lld/00-platform-build-deploy.md"), "utf8");
  const lines = lld.split("\n");
  const start = lines.findIndex((line) => line.startsWith("| `event` |"));
  expect(start).toBeGreaterThan(-1);
  const rows: string[] = [];
  for (const line of lines.slice(start)) {
    if (!line.startsWith("|")) break;
    // Escaped pipes inside a cell (`host`\|`seat`) are not cell boundaries.
    rows.push(line.replace(/\\\|/g, "/").split("|")[1] ?? "");
  }
  // The first cell names the fields; parenthetical values (`host`|`seat`, an `ErrorCode`) are not field names.
  const documented = new Set(
    rows.flatMap((cell) =>
      cell
        .replace(/\([^)]*\)/g, "")
        .split(",")
        .map((token) => token.trim())
        .filter((token) => /^`[a-z][A-Za-z0-9]*`$/.test(token))
        .map((token) => token.slice(1, -1)),
    ),
  );
  expect([...documented].sort()).toEqual([...KEYS].sort());
  type TypeKeys = keyof LogFields;
  const documentedAsTypes: Record<string, TypeKeys> = Object.fromEntries([...documented].map((k) => [k, k as TypeKeys]));
  expect(Object.keys(documentedAsTypes).sort()).toEqual([...KEYS].sort());
});

test("T4c KEYS covers every LogFields key", () => {
  // Compile-time exhaustiveness: `satisfies` in log.ts proves KEYS ⊆ LogFields, this proves LogFields ⊆ KEYS.
  type Missing = Exclude<keyof LogFields, (typeof KEYS)[number]>;
  const exhaustive: Missing extends never ? true : false = true;
  expect(exhaustive).toBe(true);
});

test("T4c a line with every field set survives intact", () => {
  log(FULL);
  expect(written).toHaveLength(1);
  expect(written[0]).toMatchObject({ ...FULL });
  expect(Object.keys(written[0] ?? {}).sort()).toEqual(["message", "severity", ...KEYS].sort());
});

test("T4d forbidden keys are still a type error and are dropped", () => {
  // @ts-expect-error `displayName` is not a logger field (and must never be logged, P19)
  log({ event: "api.done", outcome: "ok", displayName: "NAME-SENTINEL" });
  // @ts-expect-error card text must never be a logger field (P19)
  log({ event: "command.done", cardText: "CARD-SENTINEL" });
  // @ts-expect-error emails must never be a logger field (P19)
  log({ event: "api.done", email: "sentinel@example.test" });
  // @ts-expect-error raw IPs must never be a logger field (P19)
  log({ event: "rate.limited", ip: "203.0.113.9" });
  // @ts-expect-error FCM tokens must never be a logger field (P19)
  log({ event: "push.register", fcmToken: "TOKEN-SENTINEL" });
  const all = JSON.stringify(written);
  for (const sentinel of ["NAME-SENTINEL", "CARD-SENTINEL", "sentinel@example.test", "203.0.113.9", "TOKEN-SENTINEL"]) expect(all).not.toContain(sentinel);
  for (const key of ["displayName", "cardText", "email", "ip", "fcmToken"]) for (const line of written) expect(line).not.toHaveProperty(key);
});

test("T4e logError writes severity ERROR, event api.error, and only the Error's message and stack", () => {
  const failure = Object.assign(new Error("boom"), { data: { cardText: "CARD-SENTINEL", idempotencyKey: "IDEM-SENTINEL" }, rawRequest: { headers: { authorization: "TOKEN-SENTINEL" } } });
  logError(failure);
  expect(written).toHaveLength(1);
  const entry = written[0] ?? {};
  expect(entry["severity"]).toBe("ERROR");
  expect(entry["event"]).toBe("api.error");
  expect(String(entry["message"])).toContain("boom");
  expect(Object.keys(entry).sort()).toEqual(["event", "message", "severity"]);
  expect(JSON.stringify(entry)).not.toContain("SENTINEL");
});

test("T4e logError never writes a non-Error's payload either", () => {
  logError({ code: 500, request: { data: { cardText: "CARD-SENTINEL" } } });
  expect(written).toHaveLength(1);
  expect(Object.keys(written[0] ?? {}).sort()).toEqual(["event", "message", "severity"]);
  expect(JSON.stringify(written[0])).not.toContain("CARD-SENTINEL");
});
