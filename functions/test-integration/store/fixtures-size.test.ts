import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { Command } from "@dc/contracts";
import type { Game } from "@dc/engine";
import { viewersOf } from "@dc/engine";
import { DELETION_STAGES } from "../../src/store";
import { estimateBytes } from "../../src/store/size";
import { Table } from "./support/drive";
import { clear, db, runDeletion } from "./support/harness";
import { FIXTURE_IDS, fixtureHostId } from "./support/fixtures";
import { diff, snapshot, touched, viewProblems } from "./support/inspect";

// V5, V6 (LLD 3 sections 2.5, 5.7, 6.4 and 10.3): the size fixture. Built through the real commands inside test:integration,
// under a 5-minute build bound; if it overruns, LLD 3's crafted-history fallback applies and "the full real round count"
// moves to Not proven here (#37). 500 votes are Admin-patched with the real Game.votes shape because castVote is M7.
const NAME = "midsize10" as const;
const ID = FIXTURE_IDS[NAME];
const ROOT = join(import.meta.dir, "..", "..", "..");
const SEED = join(ROOT, "scripts", "seed.ts");
const BUILD_BOUND_MS = 300_000;

let buildMs = 0;
let buildOut = "";
let t: Table;

beforeAll(async () => {
  await clear();
  const started = performance.now();
  const p = Bun.spawnSync({ cmd: ["bun", SEED, "--fixture", NAME], cwd: ROOT, stdout: "pipe", stderr: "pipe", env: process.env, timeout: 900_000 });
  buildMs = Math.round(performance.now() - started);
  buildOut = `${p.stdout.toString()}${p.stderr.toString()}`;
  expect(p.exitCode).toBe(0);
  expect(buildOut).not.toMatch(/SENTINEL|NAME-|CARD-/);
  t = Table.attach(ID, fixtureHostId(NAME));
}, 900_000);

test("midsize10 is 10 players and 91 real rounds with 500 votes, and the stored aggregate is under the 600/900 KiB budgets", async () => {
  const g = await t.state();
  expect(g.id).toBe(ID);
  expect(g.players).toHaveLength(10);
  expect(g.phase).toBe("FINISHED");
  expect(g.history).toHaveLength(91);
  expect(g.votes).toHaveLength(500);
  for (const v of g.votes) {
    const h = g.history.find((x) => x.round === v.round);
    expect(h?.plays.some((p) => p.cardId === v.cardId)).toBe(true);
    expect(v.voter).toMatch(/^p:p_[a-z2-7]{8}$/);
  }
  const aggregate = (await db.doc(`games/${ID}`).get()).data();
  const bytes = estimateBytes(aggregate);
  const line = /commands=(\d+) writes=(\d+)/.exec(buildOut);
  console.log(`midsize10: buildMs=${buildMs} estimateBytes=${bytes} votes=${g.votes.length} rounds=${g.history.length} commands=${line?.[1]} harnessWrites=${line?.[2]}`);
  expect(bytes).toBeLessThan(600 * 1024);
  expect(bytes).toBeLessThan(900 * 1024);
  expect(buildMs).toBeLessThan(BUILD_BOUND_MS);
  expect(Number(line?.[1])).toBeGreaterThan(900); // ~10 commands per round
  expect(viewersOf(g)).toHaveLength(11);
  expect(await viewProblems(ID)).toEqual([]);
  expect((await db.doc(`roomCodes/${g.roomCode}`).get()).exists).toBe(false); // the finishing pick released the code
}, 300_000);

test("a stale-view command on midsize10 stays within section 5.7 and writes exactly what the independent diff sees", async () => {
  // The fixture builder also has this helper; the size test lowers the rev after the build so the command is the measured part.
  const { lowerViewsRev } = await import("./support/fixtures");
  expect(await lowerViewsRev(ID)).toBe(true);
  const g = await t.state();
  const before = await snapshot(ID);
  const r = await t.host({ type: "endGame" } as Command);
  const after = await snapshot(ID);
  const d = diff(before, after);
  expect(touched(d)).toBe(r.writes);
  expect(touched(d)).toBe(3 + viewersOf(await t.state()).length); // aggregate, events, ledger, every stale view
  expect(r.writes).toBeLessThanOrEqual(75);
  expect((await t.state()).phase).toBe("ENDED");
  expect(d.changed.filter((p) => p.includes("/views/"))).toHaveLength(viewersOf(g).length);
}, 300_000);

test("deleteGame on midsize10 is within section 5.7 and the in-process cascade leaves the documented end state", async () => {
  const g = await t.state();
  const code = g.roomCode;
  const version = g.version;
  const ledger = `hosts/${g.hostId}/idem/${(await db.collection(`hosts/${g.hostId}/idem`).get()).docs[0]?.id ?? ""}`;
  const before = await snapshot(ID);
  const del = await t.run({ kind: "user", uid: t.hostId }, { type: "deleteGame" } as Command);
  expect(del.outcome).toEqual({ kind: "deleting" });
  expect(del.writes).toBe(2); // the aggregate marker and the job; the code was released at FINISHED
  const d = diff(before, await snapshot(ID));
  expect(d.created).toEqual([`deletions/${ID}`]);
  expect(d.changed).toEqual([`games/${ID}`]);
  expect(d.deleted).toEqual([]);
  expect((await t.state()).version).toBe(version);
  expect((await db.doc(`roomCodes/${code}`).get()).exists).toBe(false);
  expect((await db.doc(ledger).get()).exists).toBe(true);

  const run = await runDeletion(ID);
  expect(run.result).toMatchObject({ kind: "done", stuck: false });
  expect(run.result.stagesRun).toEqual([...DELETION_STAGES]);
  expect(run.purged).toHaveLength(1);
  expect(run.purged[0]).toEqual({ gameId: ID, uids: g.players.map((p) => p.uid).filter((u) => u !== g.hostId), requested: 9, deleted: 9 });

  expect((await db.doc(`games/${ID}`).get()).exists).toBe(false);
  for (const c of ["views", "drafts", "events", "history", "seats"]) expect([c, (await db.collection(`games/${ID}/${c}`).get()).empty]).toEqual([c, true]);
  expect((await db.doc(`roomCodes/${code}`).get()).exists).toBe(false);
  expect((await db.doc(ledger).get()).exists).toBe(false);
  const job = (await db.doc(`deletions/${ID}`).get()).data();
  expect(job).toMatchObject({ gameId: ID, hostId: g.hostId, status: "done", stagesDone: [...DELETION_STAGES] });
  expect(job?.["expiresAt"]).toBeDefined();
}, 300_000);