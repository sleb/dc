import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { expect, test } from "bun:test";
import { tmp } from "../functions/scripts/fixtures";
import { findSentinels, scanFiles } from "./log-sentinels";
import { runHarness } from "./run-integration-sentinels";

// L1 (issue #16, LLD 0 P19): the sentinel harness. `findSentinels` is the detector, `runHarness` runs the integration
// suite, captures everything the emulators print and fails if a sentinel is in it. The detector is proven here against
// planted lines; the real emulator run is proven by the CI `emulator` job and the mutation recorded in the PR.

const quiet = () => {};

test("L1a a clean log has no hits", () => {
  expect(findSentinels('{"event":"api.done","callable":"ping","outcome":"ok"}\ni  functions: Beginning execution of "ping"\n')).toEqual([]);
});

test("L1b each sentinel family is found, with its line number and without echoing the line", () => {
  const log = ["ok", "name NAME-SENTINEL-a1 here", "ok", "card CARD-SENTINEL-b2", "mail sentinel@example.test"].join("\n");
  const hits = findSentinels(log, "emulator.log");
  expect(hits.map((h) => [h.line, h.kind])).toEqual([
    [2, "NAME-SENTINEL"],
    [4, "CARD-SENTINEL"],
    [5, "sentinel@example.test"],
  ]);
  expect(JSON.stringify(hits)).not.toContain("a1");
  expect(hits[0]?.file).toBe("emulator.log");
});

test("L1c the sentinels the integration test sends are all detected", () => {
  const source = readFileSync(join(import.meta.dir, "../functions/test-integration/sentinels.test.ts"), "utf8");
  const sent = [...source.matchAll(/(?:NAME-SENTINEL-\w+|CARD-SENTINEL-\w+|sentinel@example\.test)/g)].map((m) => m[0]);
  expect(sent.length).toBeGreaterThanOrEqual(3);
  for (const s of sent) expect([s, findSentinels(`x ${s} y`).length]).toEqual([s, 1]);
});

test("L1d scanFiles reads every file and ignores one that does not exist yet", async () => {
  const dir = await tmp("sentinel");
  await writeFile(join(dir, "a.log"), "fine\n");
  await writeFile(join(dir, "b.log"), "fine\nCARD-SENTINEL-z\n");
  const hits = await scanFiles([join(dir, "a.log"), join(dir, "b.log"), join(dir, "missing.log")]);
  expect(hits.map((h) => [h.file.endsWith("b.log"), h.line])).toEqual([[true, 2]]);
});

test("L1e the harness passes when the command passes and prints no sentinel", async () => {
  const r = await runHarness({ command: ["sh", "-c", "echo all good; echo fine >&2"], extraLogs: [], out: quiet });
  expect(r.code).toBe(0);
  expect(r.hits).toEqual([]);
});

test("L1f the harness fails when a sentinel is planted in stdout or in stderr", async () => {
  for (const cmd of ["echo NAME-SENTINEL-1", "echo sentinel@example.test >&2"]) {
    const r = await runHarness({ command: ["sh", "-c", cmd], extraLogs: [], out: quiet });
    expect([cmd, r.code]).toEqual([cmd, 1]);
    expect([cmd, r.hits.length]).toEqual([cmd, 1]);
  }
});

test("L1g the harness fails when a sentinel is in an extra log file the command writes", async () => {
  const dir = await tmp("sentinel");
  const log = join(dir, "debug.log");
  const r = await runHarness({ command: ["sh", "-c", `echo CARD-SENTINEL-q > '${log}'`], extraLogs: [log], out: quiet });
  expect(r.code).toBe(1);
  expect(r.hits[0]?.file).toBe(log);
});

test("L1h a stale extra log from an earlier run is not read", async () => {
  const dir = await tmp("sentinel");
  const log = join(dir, "debug.log");
  await writeFile(log, "NAME-SENTINEL-old\n");
  const r = await runHarness({ command: ["sh", "-c", "echo fine"], extraLogs: [log], out: quiet });
  expect(r.code).toBe(0);
});

test("L1i a failing command keeps its exit code, even without a sentinel", async () => {
  const r = await runHarness({ command: ["sh", "-c", "echo broken; exit 3"], extraLogs: [], out: quiet });
  expect(r.code).toBe(3);
});

test("L1j the harness output never contains the sentinel it found", async () => {
  const seen: string[] = [];
  await runHarness({ command: ["sh", "-c", "echo NAME-SENTINEL-leak"], extraLogs: [], out: (s) => seen.push(s), report: (s) => seen.push(s) });
  const reports = seen.filter((s) => s.startsWith("sentinel:"));
  expect(reports.length).toBe(1);
  expect(reports[0]).not.toContain("leak");
});

test("L1k a sentinel split across chunks of one stream is found even when the other stream writes in between", async () => {
  const cmd = `printf 'NAME-SENT'; sleep 0.3; echo noise >&2; sleep 0.3; printf 'INEL-split\\n'`;
  const r = await runHarness({ command: ["sh", "-c", cmd], extraLogs: [], out: quiet });
  expect(r.code).toBe(1);
  expect(r.hits.length).toBe(1);
});
