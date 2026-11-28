import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Game } from "@dc/engine";
import { PROJECTOR_REV, viewersOf } from "@dc/engine";
import { idemId } from "../../src/store";
import { clear, db } from "./support/harness";
import { CATALOGUE, FIXTURE_IDS, fixtureCreateKey, fixtureHostId, seedFixture } from "./support/fixtures";
import type { FixtureName } from "./support/fixtures";
import { diff, snapshot, viewProblems } from "./support/inspect";

// V3, V4, V10-V12 (LLD 3 sections 10.1 and 10.3, LLD 0 P1, P9, P13, P19): the fixture catalogue is built by scripts/seed.ts inside
// test:integration, from an empty emulator, through the real createGame and runCommand on the Node bundle. A second --all replays.
const ROOT = join(import.meta.dir, "..", "..", "..");
const SEED = join(ROOT, "scripts", "seed.ts");

interface SeedRun { code: number; out: string; err: string; ms: number }
function runSeed(args: string[], env: Record<string, string | undefined> = {}): SeedRun {
  const started = performance.now();
  const p = Bun.spawnSync({ cmd: ["bun", SEED, ...args], cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env }, timeout: 900_000 });
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString(), ms: Math.round(performance.now() - started) };
}

interface Line { name: FixtureName; game: string; code: string; commands: number; writes: number; replay: boolean }
const LINE = /^seed: (\S+) game=([A-Za-z0-9]{20}) code=([BCDFGHJKLMNPQRSTVWXZ]{4}) commands=(\d+) writes=(\d+) replay=(true|false)$/gm;
const reported = (r: SeedRun): Map<FixtureName, Line> =>
  new Map([...r.out.matchAll(LINE)].map((m) => {
    const line: Line = { name: m[1] as FixtureName, game: m[2] ?? "", code: m[3] ?? "", commands: Number(m[4]), writes: Number(m[5]), replay: m[6] === "true" };
    return [line.name, line];
  }));

const aggregate = async (name: FixtureName): Promise<Game> => {
  const { store: _store, ...game } = (await db.doc(`games/${FIXTURE_IDS[name]}`).get()).data() as Game & { store: unknown };
  return game as Game;
};
const extraPaths = async (name: FixtureName): Promise<string[]> => {
  const g = await aggregate(name);
  return [`roomCodes/${g.roomCode}`, `hosts/${g.hostId}/idem/${idemId({ kind: "user", uid: g.hostId }, fixtureCreateKey(name))}`];
};

let first: SeedRun;
let once: Map<FixtureName, Awaited<ReturnType<typeof snapshot>>>;
beforeAll(async () => {
  await clear();
  first = runSeed(["--all"]);
}, 900_000);

test("the script builds the whole catalogue from an empty emulator and reports ids and counts only", () => {
  expect(first.code).toBe(0);
  expect(first.err).not.toMatch(/SENTINEL|NAME-|CARD-/);
  expect(first.out).not.toMatch(/SENTINEL|NAME-|CARD-/);
  const got = reported(first);
  expect([...got.keys()].sort()).toEqual([...CATALOGUE].sort());
  for (const name of CATALOGUE) {
    expect(got.get(name)?.game).toBe(FIXTURE_IDS[name]);
    expect(got.get(name)?.replay).toBe(false);
    expect(got.get(name)?.commands).toBeGreaterThan(0);
  }
});

test("every catalogue fixture has its documented shape, built from real commands", async () => {
  const shape = {
    lobby3: { players: 3, phase: "LOBBY", paused: false, rounds: 0, roundPhase: null, views: 4, code: true },
    writing4: { players: 4, phase: "WRITING", paused: false, rounds: 0, roundPhase: null, views: 5, code: true },
    submitting5: { players: 5, phase: "PLAYING", paused: false, rounds: 0, roundPhase: "SUBMITTING", views: 6, code: true },
    judging6: { players: 6, phase: "PLAYING", paused: false, rounds: 0, roundPhase: "JUDGING", views: 7, code: true },
    paused3: { players: 3, phase: "WRITING", paused: true, rounds: 0, roundPhase: null, views: 4, code: true },
    ended4: { players: 4, phase: "ENDED", paused: false, rounds: 0, roundPhase: null, views: 5, code: false },
    departed40: { players: 51, phase: "WRITING", paused: false, rounds: 0, roundPhase: null, views: 52, code: true },
    viewsStale: { players: 4, phase: "WRITING", paused: false, rounds: 0, roundPhase: null, views: 5, code: true },
  } as const;
  for (const [name, want] of Object.entries(shape) as [Exclude<FixtureName, "finished6-votes" | "midsize10">, (typeof shape)[keyof typeof shape]][]) {
    const g = await aggregate(name);
    expect([name, g.id]).toEqual([name, FIXTURE_IDS[name]]);
    expect([name, g.players.length]).toEqual([name, want.players]);
    expect([name, g.phase]).toEqual([name, want.phase]);
    expect([name, g.paused]).toEqual([name, want.paused]);
    expect([name, g.history.length]).toEqual([name, want.rounds]);
    expect([name, g.round?.phase ?? null]).toEqual([name, want.roundPhase]);
    expect([name, viewersOf(g).length]).toEqual([name, want.views]);
    expect([name, (await db.doc(`roomCodes/${g.roomCode}`).get()).exists]).toEqual([name, want.code]);
    expect(await viewProblems(g.id)).toEqual([]);
  }

  // Seed order and the create-ledger/view documents of every fixture.
  for (const name of CATALOGUE) {
    const g = await aggregate(name);
    expect((await db.doc(`games/${g.id}/events/1`).get()).get("commandType")).toBe("createGame");
    const ledger = await db.doc(`hosts/${g.hostId}/idem/${idemId({ kind: "user", uid: g.hostId }, fixtureCreateKey(name))}`).get();
    expect([name, ledger.get("commandType"), ledger.get("gameId")]).toEqual([name, "createGame", g.id]);
    const versions = (await db.collection(`games/${g.id}/events`).get()).docs.map((d) => d.get("version") as number).sort((a, b) => a - b);
    expect([name, versions]).toEqual([name, Array.from({ length: g.version }, (_, i) => i + 1)]);
  }

  // The per-fixture states the catalogue exists for.
  const writing = await aggregate("writing4");
  expect(writing.players.map((p) => p.status)).toEqual(["writing", "ready", "writing", "writing"]);
  expect((await db.doc(`games/${writing.id}/drafts/${writing.players[1]?.id}`).get()).exists).toBe(false); // pid(1) finished
  expect((await db.doc(`games/${writing.id}/drafts/${writing.players[2]?.id}`).get()).exists).toBe(true); // pid(2) mid-draft

  const submitting = await aggregate("submitting5");
  expect(submitting.round?.submissions).toHaveLength(2);
  const judging = await aggregate("judging6");
  expect(judging.round?.submissions).toHaveLength(5);
  expect(judging.round?.revealOrder).toHaveLength(5);

  const paused = await aggregate("paused3");
  expect(paused.players.filter((p) => p.status === "left")).toHaveLength(1);

  const departed = await aggregate("departed40");
  expect(departed.totalJoins).toBe(50);
  // 40 joins that left, plus the host's own seat (unseated, tombstoned).
  expect(departed.players.filter((p) => p.status === "left")).toHaveLength(41);
  expect(departed.players.find((p) => p.uid === departed.hostId)?.status).toBe("left");
  expect(departed.players.filter((p) => p.status === "writing" || p.status === "ready" || p.status === "active")).toHaveLength(10);

  const stale = await (async () => {
    const doc = (await db.doc(`games/${FIXTURE_IDS.viewsStale}`).get()).data() as Game & { store: { viewsRev: number } };
    return doc;
  })();
  expect(stale.store.viewsRev).toBe(PROJECTOR_REV - 1);
  for (const d of (await db.collection(`games/${FIXTURE_IDS.viewsStale}/views`).get()).docs) expect(d.get("viewsRev")).toBe(PROJECTOR_REV - 1);

  // finished6-votes: voted history, a released code, and views rebuilt from the patched aggregate.
  const finished = await aggregate("finished6-votes");
  expect(finished.phase).toBe("FINISHED");
  expect(finished.history.length).toBeGreaterThanOrEqual(2);
  expect(finished.votes.length).toBeGreaterThan(0);
  for (const v of finished.votes) {
    const h = finished.history.find((x) => x.round === v.round);
    expect(h?.plays.some((p) => p.cardId === v.cardId)).toBe(true);
    expect(v.voter).toMatch(/^p:p_[a-z2-7]{8}$/);
  }
  expect((await db.doc(`roomCodes/${finished.roomCode}`).get()).exists).toBe(false);
  expect(viewersOf(finished)).toHaveLength(7);
  expect(await viewProblems(finished.id)).toEqual([]);
}, 120_000);

test("a failed vote rebuild is healed on the next fixture replay, while a completed replay is still zero-write", async () => {
  const g = await aggregate("finished6-votes");
  const viewer = viewersOf(g).find((v) => v.viewer.kind === "player");
  expect(viewer).toBeDefined();
  await db.doc(`games/${g.id}/views/${viewer?.docId}`).update({ view: null }); // a rebuild that committed the votes but no views
  expect(await viewProblems(g.id)).not.toEqual([]);

  const healed = await seedFixture("finished6-votes");
  expect(healed.rebuilt).toBe(true);
  expect(healed.writes).toBe(0); // every command replays; only the Admin-side rebuild writes
  expect(await viewProblems(g.id)).toEqual([]);

  const replay = await seedFixture("finished6-votes");
  expect(replay.rebuilt).toBe(false);
  expect(replay.writes).toBe(0);
}, 120_000);

test("a second --all replays every command and changes no updateTime", async () => {
  const before = new Map<FixtureName, Awaited<ReturnType<typeof snapshot>>>();
  for (const name of CATALOGUE) before.set(name, await snapshot(FIXTURE_IDS[name], await extraPaths(name)));
  const second = runSeed(["--all"]);
  expect(second.code).toBe(0);
  const got = reported(second);
  for (const name of CATALOGUE) {
    expect([name, got.get(name)?.replay, got.get(name)?.writes]).toEqual([name, true, 0]);
    expect([name, diff(before.get(name) as Awaited<ReturnType<typeof snapshot>>, await snapshot(FIXTURE_IDS[name], await extraPaths(name)))]).toEqual([name, { created: [], changed: [], deleted: [] }]);
  }
}, 900_000);

test("the guards refuse a real project, a missing emulator host, an unknown fixture and a malformed argument", () => {
  const real = runSeed(["--fixture", "lobby3"], { GCLOUD_PROJECT: "deepcuts-prod" });
  expect(real.code).toBe(1);
  expect(real.err).toContain("demo-");
  const noHost = runSeed(["--fixture", "lobby3"], { FIRESTORE_EMULATOR_HOST: "" });
  expect(noHost.code).toBe(1);
  expect(noHost.err).toContain("FIRESTORE_EMULATOR_HOST");
  for (const argv of [["--fixture", "nope"], ["--fixture"], ["--all", "--fixture", "lobby3"], [], ["--wat"]]) {
    const r = runSeed(argv);
    expect([argv, r.code]).toEqual([argv, 2]);
    expect(r.err).toContain("seed:");
  }
});

test("the catalogue is built by the real path, not the crafted-state helper", () => {
  const files = [
    "functions/test-integration/store/support/fixtures.ts",
    "functions/test-integration/store/fixtures.test.ts",
    "functions/test-integration/store/fixtures-size.test.ts",
    "scripts/seed.ts",
  ];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), "utf8");
    expect([f, /support\/crafted|\.\/crafted/.test(src)]).toEqual([f, false]);
  }
});

/** The parts of a fixture that a rebuild from empty must reproduce; card ids and hands are minted, so they are counted, not compared. */
const summary = async (name: FixtureName) => {
  const g = await aggregate(name);
  return {
    name,
    id: g.id,
    phase: g.phase,
    paused: g.paused,
    players: g.players.length,
    statuses: g.players.map((p) => p.status).sort(),
    views: viewersOf(g).length,
    history: g.history.length,
    round: g.round?.phase ?? null,
    submissions: g.round?.submissions.length ?? 0,
    votes: g.votes.length,
    cards: Object.keys(g.cards).length,
  };
};

test("after clear() a rebuild from empty reproduces the catalogue's shape", async () => {
  const before = [];
  for (const name of CATALOGUE) before.push(await summary(name));
  await clear();
  const rebuilt = runSeed(["--all"]);
  expect(rebuilt.code).toBe(0);
  const after = [];
  for (const name of CATALOGUE) after.push(await summary(name));
  expect(after).toEqual(before);
}, 900_000);