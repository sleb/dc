// #28: viewerFor and viewersOf (LLD 2 sections 3.2, 3.3; PJ9).
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { decide } from "../../src/decide";
import { docIdOf, viewerFor, viewersOf } from "../../src/project";
import type { Viewer } from "../../src/project";
import type { Game } from "../../src/types";
import { HOST_UID, deepFreeze, makeGame, makePlayer, pid } from "../support/factories";
import { assertProperty } from "../support/fc";
import { enumerators } from "../support/legal";
import { park, roundGame } from "../support/round-fixtures";
import { membershipDriver, runScenario } from "../support/scenario";
import type { Picks } from "../support/scenario";
import { DEP, FIXTURES, HU, P, SPEC, uidOf, unseatHost } from "./fixtures";

/** Five players: 2 left, 3 removed, 4 active. */
const mixed = (): Game => park(park(roundGame({ n: 5, judge: 1 }), 2, "left"), 3, "removed");
const hostGone = (status: "left" | "removed"): Game => park(roundGame({ n: 4, judge: 1 }), 0, status);

describe("VW1 viewerFor, first match wins (LLD 2 3.2)", () => {
  const rows: [string, Game, string | null, Viewer][] = [
    ["a seated player", mixed(), uidOf(1), P(1)],
    ["the seated host", mixed(), HOST_UID, P(0)],
    ["a judge is an ordinary player viewer", mixed(), uidOf(4), P(4)],
    ["a host whose seat is left: the host rule beats the tombstone (PJ9)", hostGone("left"), HOST_UID, HU],
    ["a host whose seat was removed: still the host rule", hostGone("removed"), HOST_UID, HU],
    ["a host who never had a seat", makeGame({ players: [makePlayer(1, { status: "writing" })] }), HOST_UID, HU],
    ["a left player", mixed(), uidOf(2), DEP(2, "left")],
    ["a removed player", mixed(), uidOf(3), DEP(3, "removed")],
    ["a null uid is the shared spectator", mixed(), null, SPEC],
    ["an unknown uid is the shared spectator", mixed(), "someone-else", SPEC],
    ["an unknown uid in a host-less game is the shared spectator", hostGone("left"), "someone-else", SPEC],
    ["a seat uid of a game that never existed is the shared spectator", mixed(), "seat:gameXXXXXXXXXXXXXXXXX:p_aaaaaaaa", SPEC],
  ];
  for (const [name, game, uid, want] of rows) test(name, () => expect(viewerFor(deepFreeze(structuredClone(game)), uid)).toStrictEqual(want));
});

describe("VW2 viewersOf (LLD 2 3.3)", () => {
  const ids = (g: Game): string[] => viewersOf(deepFreeze(structuredClone(g))).map((t) => t.docId);

  test("LOBBY: one per seated player, then the shared spectator", () => {
    expect(ids(FIXTURES["lobby"]?.() as Game)).toEqual([uidOf(0), uidOf(1), uidOf(2), "spectator"]);
  });
  test("a seated host has one doc and it is a player doc", () => {
    const t = viewersOf(roundGame({ n: 3, judge: 1 }));
    expect(t.filter((x) => x.docId === HOST_UID)).toEqual([{ docId: HOST_UID, viewer: P(0) }]);
  });
  test("an unseated host gets exactly one extra doc keyed by hostId, between the seats and the spectator", () => {
    expect(ids(hostGone("left"))).toEqual([uidOf(1), uidOf(2), uidOf(3), HOST_UID, "spectator"]);
    expect(viewersOf(hostGone("left")).find((t) => t.docId === HOST_UID)?.viewer).toStrictEqual(HU);
  });
  test("departed players follow the spectator, in player order, and exclude the host (PJ9)", () => {
    expect(ids(mixed())).toEqual([uidOf(0), uidOf(1), uidOf(4), "spectator", uidOf(2), uidOf(3)]);
    const t = viewersOf(mixed());
    expect(t.find((x) => x.docId === uidOf(2))?.viewer).toStrictEqual(DEP(2, "left"));
    expect(t.find((x) => x.docId === uidOf(3))?.viewer).toStrictEqual(DEP(3, "removed"));
    expect(ids(hostGone("removed"))).not.toContain("gone");
    expect(viewersOf(hostGone("removed")).filter((x) => x.viewer.kind === "departed")).toEqual([]);
  });
  test("the shared spectator doc is always present, in every phase, with no uid", () => {
    for (const [name, make] of Object.entries(FIXTURES)) {
      const t = viewersOf(make()).filter((x) => x.docId === "spectator");
      expect(t, name).toEqual([{ docId: "spectator", viewer: SPEC }]);
    }
  });
  test("no duplicate docIds in any fixture, including unseated-host variants", () => {
    for (const [name, make] of Object.entries(FIXTURES)) {
      for (const g of [make(), unseatHost(make())]) {
        const d = ids(g);
        expect(new Set(d).size, name).toBe(d.length);
      }
    }
  });
  test("deterministic: equal states give equal lists, and the input is not mutated", () => {
    const g = deepFreeze(mixed());
    expect(viewersOf(g)).toStrictEqual(viewersOf(structuredClone(g)));
  });
  test("docIdOf: a seat or departed viewer is its uid, the unseated host is hostId, the shared spectator is 'spectator'", () => {
    expect(docIdOf(P(2))).toBe(uidOf(2));
    expect(docIdOf(DEP(3, "removed"))).toBe(uidOf(3));
    expect(docIdOf(HU)).toBe(HOST_UID);
    expect(docIdOf(SPEC)).toBe("spectator");
  });
});

describe("VW3 viewerFor inverts viewersOf over whole games", () => {
  const placeholders: Picks = Array.from({ length: 300 }, () => ({ kind: "legal" as const, pick: 0 }));
  test("for every target of every state of a churned game, viewerFor(game, target.viewer.uid) equals the viewer, and docIdOf equals the docId", () => {
    let targets = 0;
    assertProperty(fc.property(fc.integer({ min: 3, max: 7 }), fc.integer(), (n, seed) => {
      const created = decide(null, { type: "createGame", gameId: "gameaaaaaaaaaaaaaaaa", roomCode: "BCDF", hostId: HOST_UID, hostPlayerId: pid(0), hostName: "Host" }, {
        now: 1, rng: { seed: "s", int: () => 0, shuffle: (x) => [...x] }, mintId: () => "c_0000000000", actor: { kind: "user", uid: HOST_UID }, drafts: {},
      });
      if (!created.ok) throw new Error("createGame");
      const trace = runScenario(decide, created.value.state, placeholders, { seed, table: enumerators, drive: membershipDriver(`${seed}`, n, enumerators) });
      for (const g of trace.states) {
        if (g === null) continue;
        for (const t of viewersOf(g)) {
          targets++;
          expect(viewerFor(g, t.viewer.uid)).toStrictEqual(t.viewer);
          expect(docIdOf(t.viewer)).toBe(t.docId);
        }
      }
    }), { ...process.env, FC_NUM_RUNS: process.env.FC_NUM_RUNS ?? "8" });
    expect(targets).toBeGreaterThan(100);
  });
  test("the fixtures too", () => {
    for (const make of Object.values(FIXTURES)) for (const g of [make(), unseatHost(make())]) for (const t of viewersOf(g)) expect(viewerFor(g, t.viewer.uid)).toStrictEqual(t.viewer);
  });
});
