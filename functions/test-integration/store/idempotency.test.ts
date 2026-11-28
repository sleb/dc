import { beforeAll, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { Timestamp } from "firebase-admin/firestore";
import { idemId } from "../../src/store/idem";
import { Table } from "./support/drive";
import { clear, db, run } from "./support/harness";
import { diff, snapshot, touched } from "./support/inspect";
import { newKey } from "./support/ids";

// I2 same-key race (ST3) and I3 idempotent replay (LLD 3 section 5.4).
beforeAll(clear);

test("I2 8 concurrent requests with one key move the version by exactly 1, all return that version, and leave one ledger doc", async () => {
  const t = await Table.lobby(3);
  const before = (await t.state()).version;
  const key = newKey();
  const actor = { kind: "user", uid: t.hostId } as const;
  const results = await Promise.all(Array.from({ length: 8 }, () => run({ gameId: t.gameId, actor, cmd: { type: "updateSettings", patch: { profanity: "off" } } as Command, idemKey: key })));
  expect((await t.state()).version).toBe(before + 1);
  for (const r of results) expect(r.outcome).toMatchObject({ kind: "accepted", version: before + 1 });
  expect(results.filter((r) => r.outcome.kind === "accepted" && !r.outcome.replay)).toHaveLength(1);
  const ledger = (await db.collection(`games/${t.gameId}/idem`).get()).docs.filter((d) => d.id === idemId(actor, key));
  expect(ledger).toHaveLength(1);
}, 60_000);

test("I3 a replay after the round went stale returns the original version and the current view, and writes nothing; a new key is STALE", async () => {
  const t = await Table.playing(3);
  const g = await t.state();
  const r = g.round;
  if (r === null) throw new Error("round");
  const p = g.players.find((x) => x.status === "active" && x.id !== r.judgeId);
  if (p === undefined) throw new Error("submitter");
  const actor = { kind: "user", uid: p.uid } as const;
  const cmd = { type: "confirmSubmission", cardId: p.hand[0], expectedVersion: r.changedAtVersion } as Command;
  const key = newKey();
  const first = await run({ gameId: t.gameId, actor, cmd, idemKey: key });
  expect(first.outcome).toMatchObject({ kind: "accepted", replay: false });
  const original = first.outcome.kind === "accepted" ? first.outcome.version : -1;
  await t.host({ type: "passJudging", expectedVersion: (await t.state()).round?.changedAtVersion } as Command);
  const now = (await t.state()).version;
  expect(now).toBeGreaterThan(original);

  const before = await snapshot(t.gameId);
  const again = await run({ gameId: t.gameId, actor, cmd, idemKey: key });
  expect(again.outcome).toMatchObject({ kind: "accepted", replay: true, version: original });
  expect(again.outcome.kind === "accepted" ? again.outcome.view?.version : -1).toBe(now); // LLD 5 OQ 12: result.version < view.version on a replay
  expect(again.writes).toBe(0);
  expect(touched(diff(before, await snapshot(t.gameId)))).toBe(0); // no document updateTime changed

  const fresh = await run({ gameId: t.gameId, actor, cmd, idemKey: newKey() });
  expect(fresh.outcome).toMatchObject({ kind: "rejected", rejection: { code: "STALE" } });
  expect(touched(diff(before, await snapshot(t.gameId)))).toBe(0);

  // A ledger doc whose expiresAt has passed (TTL not yet swept) still replays.
  await db.doc(`games/${t.gameId}/idem/${idemId(actor, key)}`).update({ expiresAt: Timestamp.fromMillis(1) });
  const expired = await run({ gameId: t.gameId, actor, cmd, idemKey: key });
  expect(expired.outcome).toMatchObject({ kind: "accepted", replay: true, version: original });
}, 120_000);
