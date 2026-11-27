import { beforeAll, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { createHash } from "node:crypto";
import { idemId } from "../../src/store/idem";
import { Table } from "./support/drive";
import { clear, db, run } from "./support/harness";
import { diff, snapshot } from "./support/inspect";
import { HOST_NAME, newKey, pid } from "./support/seed";

// I13 join through runCommand with the harness's test recipe for extraWrites (the Store half of LLD 3 section 6.2). Identity's real seats and
// joinIdem writes, keyHash and the raw-key sentinel are #42.
beforeAll(clear);

test("I13 a rejected join writes no extra docs; an accepted one writes the extra docs and views/{uid} in one commit; a replay echoes meta", async () => {
  const t = await Table.lobby(2);
  const k = 5;
  const uid = t.uidOf(k);
  const keyHash = createHash("sha256").update(newKey()).digest("hex");
  const req = { gameId: t.gameId, actor: { kind: "user" as const, uid }, idemKey: keyHash, meta: { playerId: pid(k) }, extraWrites: { recipe: "testSeat" as const, keyHash } };
  const extra = [`joinIdem/${keyHash}`];

  const before = await snapshot(t.gameId, extra);
  const taken = await run({ ...req, idemKey: `${keyHash}-x`, cmd: { type: "join", playerId: pid(k), name: HOST_NAME } as Command });
  expect(taken.outcome).toMatchObject({ kind: "rejected", rejection: { code: "NAME_TAKEN" } });
  expect(diff(before, await snapshot(t.gameId, extra))).toEqual({ created: [], changed: [], deleted: [] });

  const ok = await run({ ...req, cmd: { type: "join", playerId: pid(k), name: "NAME-SENTINEL-5" } as Command });
  expect(ok.outcome).toMatchObject({ kind: "accepted", replay: false });
  const after = await snapshot(t.gameId, extra);
  const seat = after.get(`games/${t.gameId}/seats/${pid(k)}`);
  const join = after.get(`joinIdem/${keyHash}`);
  const view = after.get(`games/${t.gameId}/views/${uid}`);
  expect(seat?.data).toMatchObject({ uid, epoch: 0, firstSignInAt: null });
  expect(join?.data).toMatchObject({ gameId: t.gameId, playerId: pid(k), uid });
  expect(view).toBeDefined();
  expect(new Set([seat?.updateTime, join?.updateTime, view?.updateTime, after.get(`games/${t.gameId}`)?.updateTime]).size).toBe(1); // one commit
  expect(after.has(`games/${t.gameId}/idem/${idemId({ kind: "user", uid }, keyHash)}`)).toBe(true); // the ledger id derives from the key hash

  const replay = await run({ ...req, cmd: { type: "join", playerId: pid(k), name: "NAME-SENTINEL-5" } as Command });
  expect(replay.outcome).toMatchObject({ kind: "accepted", replay: true, meta: { playerId: pid(k) } });
  expect(diff(after, await snapshot(t.gameId, extra))).toEqual({ created: [], changed: [], deleted: [] });
}, 120_000);
