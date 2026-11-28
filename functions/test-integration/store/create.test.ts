import { beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Command } from "@dc/contracts";
import { PROJECTOR_REV } from "@dc/engine";
import type { Game } from "@dc/engine";
import { Timestamp } from "firebase-admin/firestore";
import { roomCodeFromSeed, type CreateOutcome } from "../../src/store";
import { Table } from "./support/drive";
import { clear, create, createError, createSeeds, db, load, run } from "./support/harness";
import { diff, snapshot, viewProblems } from "./support/inspect";
import { HOST_NAME, newKey, pid, seatUid } from "./support/seed";
import { playerName } from "../../src/store/test-support";

// I17-I20, I22 (LLD 3 sections 2.2, 2.3, 5.4, 5.8, 6.1, 10.1, ST1, ST3, ST4, ST5, ST8): createGame through the Node bundle.
beforeAll(clear);

const newHost = (): string => `host-${crypto.randomUUID()}`;
const codeAlphabet = /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
/** The ledger id independently of the production helper: base64url(sha256(hostId \0 idemKey)) (LLD 3 section 2.4). */
const ledgerOf = (hostId: string, idemKey: string): string => `hosts/${hostId}/idem/${createHash("sha256").update(`${hostId}\u0000${idemKey}`).digest("base64url")}`;
const accepted = (o: CreateOutcome): Extract<CreateOutcome, { kind: "accepted" }> => {
  if (o.kind !== "accepted") throw new Error(`expected accepted, got ${JSON.stringify(o)}`);
  return o;
};
const count = async (path: string): Promise<number> => (await db.collection(path).get()).size;
/** Every top-level collection a createGame could plausibly touch, counted independently of any plan (the oracle's "nothing else" half). */
const topLevelCounts = async () => ({
  games: await count("games"),
  roomCodes: await count("roomCodes"),
  hosts: await count("hosts"),
  outbox: await count("outbox"),
  joinIdem: await count("joinIdem"),
  deletions: await count("deletions"),
  pushSubs: await count("pushSubs"),
  rateLimits: await count("rateLimits"),
});

test("I17 createGame commits exactly six documents and the aggregate, views, code and ledger agree", async () => {
  const hostId = newHost();
  const idemKey = newKey();
  const now = 1_700_000_000_000;
  const collectionsBefore = await topLevelCounts();
  const result = await create({ hostId, hostName: HOST_NAME, idemKey, now });
  const out = accepted(result.outcome);
  expect(out.replay).toBe(false);
  expect(out.roomCode).toMatch(codeAlphabet);
  expect(result.attempts).toBe(1);

  const gameId = out.gameId;
  const code = out.roomCode;
  const codePath = `roomCodes/${code}`;
  const ledgerPath = ledgerOf(hostId, idemKey);
  const snap = await snapshot(gameId, [codePath, ledgerPath]);
  expect([...snap.keys()].sort()).toEqual(
    [
      `games/${gameId}`,
      `games/${gameId}/events/1`,
      `games/${gameId}/views/${hostId}`,
      `games/${gameId}/views/spectator`,
      codePath,
      ledgerPath,
    ].sort(),
  );
  expect(diff(new Map(), snap).created).toHaveLength(6);
  // One transaction: all six documents carry the same updateTime (join.test.ts precedent), not just the same six paths.
  expect(new Set([...snap.keys()].map((p) => snap.get(p)?.updateTime)).size).toBe(1);

  // The independent oracle's "nothing else": the six documents are the whole write, so no excluded neighbour gained a row (LLD 3 section 10.3).
  const collectionsAfter = await topLevelCounts();
  expect((await db.doc(`hosts/${hostId}`).get()).exists).toBe(false); // the parent stays Identity's (LLD 3 section 6.1)
  expect(collectionsAfter.games).toBe(collectionsBefore.games + 1);
  expect(collectionsAfter.roomCodes).toBe(collectionsBefore.roomCodes + 1);
  expect(collectionsAfter.hosts).toBe(collectionsBefore.hosts);
  for (const c of ["outbox", "joinIdem", "deletions", "pushSubs", "rateLimits"] as const) expect(collectionsAfter[c]).toBe(collectionsBefore[c]);

  // The aggregate: LOBBY v1, the host seated with the derived p_ id, the code, the fresh store map.
  const doc = snap.get(`games/${gameId}`)?.data as unknown as Game & { store: Record<string, unknown> };
  expect(doc.phase).toBe("LOBBY");
  expect(doc.version).toBe(1);
  expect(doc.roomCode).toBe(code);
  expect(doc.hostId).toBe(hostId);
  expect(doc.store).toEqual({ schema: 1, viewsRev: PROJECTOR_REV, updatedAt: now, deleting: null });
  const host = doc.players.find((p) => p.uid === hostId);
  expect(host?.id).toMatch(/^p_[a-z2-7]{8}$/);
  expect(doc.players).toHaveLength(1);

  // events/1: createGame v1 with the host's actorPlayerId and a seed.
  const ev = snap.get(`games/${gameId}/events/1`)?.data as Record<string, unknown>;
  expect(ev).toMatchObject({ version: 1, at: now, commandType: "createGame", actorPlayerId: host?.id, events: [{ t: "GameCreated", hostPlayerId: host?.id }] });
  expect(typeof ev["seed"]).toBe("string");

  // Views: PJ11 against the stored aggregate; the spectator doc exists and is off by default.
  expect(await viewProblems(gameId)).toEqual([]);
  expect(snap.get(`games/${gameId}/views/spectator`)?.data).toMatchObject({ enabled: false, view: null, version: 1 });

  // roomCodes and the ledger.
  expect(snap.get(codePath)?.data).toEqual({ gameId, createdAt: now });
  const ledger = snap.get(ledgerPath)?.data as Record<string, unknown>;
  expect(ledger).toMatchObject({ at: now, commandType: "createGame", version: 1, gameId, roomCode: code });
  expect((ledger["expiresAt"] as Timestamp).toMillis()).toBe(now + 7 * 86_400_000);
  expect(await count(`hosts/${hostId}/idem`)).toBe(1);

  // A join on the new game is accepted, so the created aggregate is a real game.
  const joined = await run({
    gameId,
    actor: { kind: "user", uid: seatUid(gameId, pid(1)) },
    cmd: { type: "join", playerId: pid(1), name: playerName(1) } as Command,
    idemKey: newKey(),
  });
  expect(joined.outcome.kind).toBe("accepted");
});

test("I18 seven forced collisions then success on the eighth code; eight collisions exhaust with nothing written", async () => {
  const hostId = newHost();
  const seeds = Array.from({ length: 8 }, (_, i) => `i18-${i}`);
  const codes = seeds.map((seed) => roomCodeFromSeed(seed));
  expect(new Set(codes).size).toBe(8);
  const seeded = (i: number): string => `gI18Seed${String(i).padStart(12, "0")}`;
  for (let i = 0; i < 7; i++) await db.doc(`roomCodes/${codes[i]}`).set({ gameId: seeded(i), createdAt: 1 });
  for (let i = 0; i < 7; i++) expect((await db.doc(`roomCodes/${codes[i]}`).get()).get("gameId")).toBe(seeded(i));

  const result = await create({ hostId, hostName: HOST_NAME, idemKey: newKey(), seeds: createSeeds(seeds) });
  const out = accepted(result.outcome);
  expect(out.roomCode).toBe(codes[7] as string);
  expect(result.attempts).toBe(8);
  // One new game and one ledger row; each of the eight codes maps to its own game (no code twice).
  expect((await db.collection(`hosts/${hostId}/idem`).get()).size).toBe(1);
  const gameIds = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const g = (await db.doc(`roomCodes/${codes[i]}`).get()).get("gameId") as string;
    gameIds.add(g);
    if (i < 7) expect(g).toBe(seeded(i)); // untouched
  }
  expect(gameIds.size).toBe(8);
  expect(gameIds.has(out.gameId)).toBe(true);
  expect((await db.doc(`games/${out.gameId}`).get()).exists).toBe(true);

  // Eight occupied codes: resource-exhausted, and an empty diff.
  const hostId2 = newHost();
  const seeds2 = Array.from({ length: 8 }, (_, i) => `i18-exhaust-${i}`);
  const codes2 = seeds2.map((seed) => roomCodeFromSeed(seed));
  for (let i = 0; i < 8; i++) await db.doc(`roomCodes/${codes2[i]}`).set({ gameId: seeded(i), createdAt: 1 });
  const gamesBefore = await count("games");
  const codesBefore = await count("roomCodes");
  const err = await createError({ hostId: hostId2, hostName: HOST_NAME, idemKey: newKey(), seeds: createSeeds(seeds2) });
  expect(err).toEqual({ code: "functions/resource-exhausted", kind: "ROOM_CODES_EXHAUSTED" });
  expect(await count("games")).toBe(gamesBefore);
  expect(await count("roomCodes")).toBe(codesBefore);
  expect(await count(`hosts/${hostId2}/idem`)).toBe(0);
});

test("I19 replay and ledger expiry: same key returns the same ids with no document changed, even after the code is re-taken", async () => {
  const hostId = newHost();
  const idemKey = newKey();
  const now = 1_700_000_100_000;
  const codeSeed = "i19-code";
  const code = roomCodeFromSeed(codeSeed);
  const first = accepted((await create({ hostId, hostName: HOST_NAME, idemKey, now, seeds: [codeSeed] })).outcome);
  expect(first.roomCode).toBe(code);

  const codePath = `roomCodes/${code}`;
  const ledgerPath = ledgerOf(hostId, idemKey);
  const before = await snapshot(first.gameId, [codePath, ledgerPath]);
  const second = await create({ hostId, hostName: HOST_NAME, idemKey, now: now + 5_000, seeds: [codeSeed] });
  const replay = accepted(second.outcome);
  expect(replay).toEqual({ kind: "accepted", gameId: first.gameId, roomCode: code, replay: true });
  expect(second.attempts).toBe(1);
  expect(diff(before, await snapshot(first.gameId, [codePath, ledgerPath]))).toEqual({ created: [], changed: [], deleted: [] });
  expect((await count(`hosts/${hostId}/idem`))).toBe(1);

  // A ledger row whose expiresAt has passed but was not swept still replays (LLD 3 section 2.6).
  await db.doc(ledgerPath).update({ expiresAt: Timestamp.fromMillis(now - 1) });
  const afterExpiry = accepted((await create({ hostId, hostName: HOST_NAME, idemKey, now: now + 9_000 })).outcome);
  expect(afterExpiry).toEqual({ kind: "accepted", gameId: first.gameId, roomCode: code, replay: true });

  // A newer game takes the released code; the old key still replays before the code is judged.
  await db.doc(codePath).delete();
  const newer = accepted((await create({ hostId: newHost(), hostName: HOST_NAME, idemKey: newKey(), now: now + 10_000, seeds: [codeSeed] })).outcome);
  expect(newer.roomCode).toBe(code);
  expect(newer.gameId).not.toBe(first.gameId);
  const afterRetake = accepted((await create({ hostId, hostName: HOST_NAME, idemKey, now: now + 11_000 })).outcome);
  expect(afterRetake).toEqual({ kind: "accepted", gameId: first.gameId, roomCode: code, replay: true });

  // A rejected host name and an invalid settings patch write nothing at all, including no ledger row under the host (ST1's "not even a ledger row").
  const gamesBefore = await count("games");
  const codesBefore = await count("roomCodes");
  const nameHost = newHost();
  const settingsHost = newHost();
  const nameRejected = await create({ hostId: nameHost, hostName: "   ", idemKey: newKey() });
  expect(nameRejected.outcome).toMatchObject({ kind: "rejected", rejection: { code: "CONTENT_REJECTED" } });
  const settingsRejected = await create({ hostId: settingsHost, hostName: HOST_NAME, idemKey: newKey(), settings: { spectators: { enabled: "yes" } } });
  expect(settingsRejected.outcome).toMatchObject({ kind: "rejected", rejection: { code: "INVALID_ARGUMENT" } });
  expect(await count("games")).toBe(gamesBefore);
  expect(await count("roomCodes")).toBe(codesBefore);
  expect(await count(`hosts/${nameHost}/idem`)).toBe(0);
  expect(await count(`hosts/${settingsHost}/idem`)).toBe(0);
});

test("I20a two parallel calls with one key: one game, one ledger row, both callers get the same ids", async () => {
  const hostId = newHost();
  const idemKey = newKey();
  const request = { hostId, hostName: HOST_NAME, idemKey };
  const [a, b] = await Promise.all([create(request), create(request)]);
  const left = accepted(a.outcome);
  const right = accepted(b.outcome);
  expect(right.gameId).toBe(left.gameId);
  expect(right.roomCode).toBe(left.roomCode);
  expect([left.replay, right.replay].filter((r) => r === false).length).toBeGreaterThanOrEqual(1);
  const games = await db.collection("games").where("hostId", "==", hostId).get();
  expect(games.size).toBe(1);
  expect(games.docs[0]?.id).toBe(left.gameId);
  expect(await count(`hosts/${hostId}/idem`)).toBe(1);
});

test("I20b two parallel calls with different keys on one code: two games, distinct codes, the loser retried", async () => {
  const seed = "i20-shared-code";
  const code = roomCodeFromSeed(seed);
  const [a, b] = await Promise.all([
    create({ hostId: newHost(), hostName: HOST_NAME, idemKey: newKey(), seeds: [seed] }),
    create({ hostId: newHost(), hostName: HOST_NAME, idemKey: newKey(), seeds: [seed] }),
  ]);
  const left = accepted(a.outcome);
  const right = accepted(b.outcome);
  expect(left.roomCode).not.toBe(right.roomCode);
  expect(left.gameId).not.toBe(right.gameId);
  expect(left.roomCode === code || right.roomCode === code).toBe(true);
  // Both calls start from the same scripted code seed, so the winner commits on attempt 1 and the loser must be on attempt 2 (I20).
  expect([a.attempts, b.attempts].sort()).toEqual([1, 2]);
  for (const out of [left, right]) {
    expect((await db.doc(`roomCodes/${out.roomCode}`).get()).get("gameId")).toBe(out.gameId);
    expect((await db.doc(`games/${out.gameId}`).get()).exists).toBe(true);
  }
  const mine = (await db.collection("roomCodes").get()).docs.filter((d) => d.get("gameId") === left.gameId || d.get("gameId") === right.gameId);
  expect(mine).toHaveLength(2);
});

test("I22 a fresh Table.lobby game is created by the production path", async () => {
  const t = await Table.lobby(2);
  const g = await t.state();
  const ev = await db.doc(`games/${t.gameId}/events/1`).get();
  expect(ev.exists).toBe(true);
  expect(ev.get("commandType")).toBe("createGame");
  expect(ev.get("version")).toBe(1);
  expect((await db.doc(`roomCodes/${g.roomCode}`).get()).get("gameId")).toBe(t.gameId);
  const ledgers = await db.collection(`hosts/${t.hostId}/idem`).get();
  expect(ledgers.size).toBe(1);
  expect(ledgers.docs[0]?.get("commandType")).toBe("createGame");
  expect(await viewProblems(t.gameId)).toEqual([]);
  // The join drove the aggregate forward, so a created lobby is a normal game.
  expect((await load(t.gameId))?.game.players.length).toBe(2);
});

test("I22b a harness-supplied fixed gameId names every document; a create without one still draws a 20-character id", async () => {
  const fixed = "gFixCreate0000000001";
  const hostId = newHost();
  const idemKey = newKey();
  const out = accepted((await create({ gameId: fixed, hostId, hostName: HOST_NAME, idemKey, now: 1_700_000_000_000 })).outcome);
  expect(out.gameId).toBe(fixed);
  const codePath = `roomCodes/${out.roomCode}`;
  const ledgerPath = ledgerOf(hostId, idemKey);
  const snap = await snapshot(fixed, [codePath, ledgerPath]);
  expect([...snap.keys()].sort()).toEqual(
    [`games/${fixed}`, `games/${fixed}/events/1`, `games/${fixed}/views/${hostId}`, `games/${fixed}/views/spectator`, codePath, ledgerPath].sort(),
  );
  expect(await viewProblems(fixed)).toEqual([]);
  expect((await load(fixed))?.game.id).toBe(fixed);

  const auto = accepted((await create({ hostId: newHost(), hostName: HOST_NAME, idemKey: newKey() })).outcome);
  expect(auto.gameId).toMatch(/^[A-Za-z0-9]{20}$/);
  expect(auto.gameId).not.toBe(fixed);
  expect((await db.doc(`games/${auto.gameId}`).get()).exists).toBe(true);
}, 120_000);
