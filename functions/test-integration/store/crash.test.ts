import { beforeAll, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { Table } from "./support/drive";
import { clear, db, run, runError } from "./support/harness";
import { diff, eventVersions, snapshot, touched } from "./support/inspect";
import { newKey } from "./support/ids";

// I4 Crash between steps (ST1, ST2, LLD 3 sections 5.5 and 5.8), with the harness's emulator-only fault hooks.
beforeAll(clear);

test("I4 a throw after the writes are buffered leaves aggregate, views, events, outbox, ledger and drafts unchanged", async () => {
  const t = await Table.lobby(3);
  const extra = [`roomCodes/${(await t.state()).roomCode}`];
  const before = await snapshot(t.gameId, extra);
  const err = await runError({ gameId: t.gameId, actor: { kind: "user", uid: t.hostId }, cmd: { type: "startGame" } as Command, idemKey: newKey(), faults: { throwAt: "afterWritesBuffered" } });
  expect(err).toEqual({ code: "functions/internal", kind: "FAULT" });
  expect(diff(before, await snapshot(t.gameId, extra))).toEqual({ created: [], changed: [], deleted: [] });
}, 60_000);

test("I4 a crash after the commit, then a same-key retry, replays the committed command", async () => {
  const t = await Table.lobby(3);
  const v0 = (await t.state()).version;
  const req = { gameId: t.gameId, actor: { kind: "user" as const, uid: t.hostId }, cmd: { type: "startGame" } as Command, idemKey: newKey() };
  expect(await runError({ ...req, faults: { throwAt: "afterCommit" } })).toEqual({ code: "functions/internal", kind: "FAULT" });
  expect((await t.state()).version).toBe(v0 + 1); // it committed
  const retry = await run(req);
  expect(retry.outcome).toMatchObject({ kind: "accepted", replay: true, version: v0 + 1 });
  expect((await t.state()).version).toBe(v0 + 1);
}, 60_000);

test("I4 a forced ABORTED on attempt 1: effects exactly once, and the stored seed is the committing attempt's", async () => {
  const t = await Table.lobby(3);
  const v0 = (await t.state()).version;
  const before = await snapshot(t.gameId);
  const res = await run({ gameId: t.gameId, actor: { kind: "user", uid: t.hostId }, cmd: { type: "startGame" } as Command, idemKey: newKey(), seeds: ["seed-attempt-1", "seed-attempt-2"], faults: { abortAttempts: [1] } });
  expect(res.attempts).toBe(2);
  expect(res.seeds).toEqual(["seed-attempt-1", "seed-attempt-2"]);
  expect((await t.state()).version).toBe(v0 + 1);
  expect((await eventVersions(t.gameId)).filter((v) => v > v0)).toEqual([v0 + 1]);
  const ev = (await db.doc(`games/${t.gameId}/events/${v0 + 1}`).get()).data();
  expect(ev?.["seed"]).toBe("seed-attempt-2");
  const d = diff(before, await snapshot(t.gameId));
  expect(d.created.filter((p) => p.includes("/idem/"))).toHaveLength(1);
  expect(d.created.filter((p) => p.includes("/outbox/"))).toHaveLength(1);
  expect(touched(d)).toBe(res.writes);
}, 60_000);

test("I4 ABORTED on every attempt gives CONTENTION after 8 attempts with nothing committed", async () => {
  const t = await Table.lobby(3);
  const extra = [`roomCodes/${(await t.state()).roomCode}`];
  const before = await snapshot(t.gameId, extra);
  const err = await runError({ gameId: t.gameId, actor: { kind: "user", uid: t.hostId }, cmd: { type: "startGame" } as Command, idemKey: newKey(), faults: { abortAttempts: [1, 2, 3, 4, 5, 6, 7, 8] } });
  expect(err).toEqual({ code: "functions/aborted", kind: "CONTENTION" });
  expect(diff(before, await snapshot(t.gameId, extra))).toEqual({ created: [], changed: [], deleted: [] });
}, 300_000);
