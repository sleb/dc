// #28: purity, makeProjector, strictness, JSON round trip and the departed view (LLD 2 PJ1, PJ2, PJ9; 4.2, 4.3, 5.4).
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { DEPARTED_REASONS, GameViewSchema } from "@dc/contracts";
import { decide } from "../../src/decide";
import { EngineInvariantError } from "../../src/errors";
import { makeProjector, project, viewersOf } from "../../src/project";
import type { Viewer } from "../../src/project";
import type { Game } from "../../src/types";
import { HOST_UID, cid, deepFreeze, pid } from "../support/factories";
import { assertProperty } from "../support/fc";
import { enumerators } from "../support/legal";
import { park, roundGame } from "../support/round-fixtures";
import { membershipDriver, progressDriver, runScenario } from "../support/scenario";
import type { Picks } from "../support/scenario";
import { DEP, FIXTURES, HU, P, SPEC, unseatHost, uidOf } from "./fixtures";

const states = (): [string, Game][] => Object.entries(FIXTURES).flatMap(([name, make]) => [[name, make()] as [string, Game], [`${name}/hostless`, unseatHost(make())] as [string, Game]]);

describe("PR1 purity and the projector instance (PJ1)", () => {
  test("project does not mutate a deeply frozen game, and equal inputs give equal output", () => {
    for (const [name, g] of states()) {
      const frozen = deepFreeze(structuredClone(g));
      for (const t of viewersOf(frozen)) {
        const a = project(frozen, t.viewer);
        const b = project(structuredClone(g), t.viewer);
        expect(JSON.stringify(a), `${name} ${t.docId}`).toBe(JSON.stringify(b));
      }
    }
  });
  test("makeProjector(game)(viewer) equals project(game, viewer) for every target, and the instance can be reused", () => {
    for (const [name, g] of states()) {
      const at = makeProjector(g);
      for (const t of viewersOf(g)) expect(at(t.viewer), `${name} ${t.docId}`).toStrictEqual(project(g, t.viewer));
      for (const t of viewersOf(g)) expect(at(t.viewer), `${name} ${t.docId} again`).toStrictEqual(project(g, t.viewer));
    }
  });
  test("a player viewer who is not seated fails closed with EngineInvariantError (ruling 4): left, removed, unknown", () => {
    const g = park(park(roundGame({ n: 4, judge: 1 }), 2, "left"), 3, "removed");
    const ghost: Viewer = { kind: "player", uid: "nobody", playerId: pid(40), isHost: false };
    for (const v of [P(2), P(3), ghost]) {
      expect(() => project(g, v)).toThrow(EngineInvariantError);
      expect(() => makeProjector(g)(v)).toThrow(EngineInvariantError);
    }
  });
  test("a player viewer whose uid is not the seat's uid fails closed, including a host uid on a non-host seat", () => {
    const g = roundGame({ n: 4, judge: 1 });
    for (const v of [{ ...P(2), uid: uidOf(3) }, { ...P(2), uid: HOST_UID }, { ...P(0), uid: uidOf(1) }] as Viewer[]) expect(() => project(g, v)).toThrow(EngineInvariantError);
  });
  test("a projector never reads the clock or entropy: the view of a game does not change between two calls with different Date", () => {
    const g = roundGame({ n: 4, judge: 1, submitted: [2] });
    const a = JSON.stringify(project(g, P(2)));
    const realNow = Date.now;
    Date.now = () => 123;
    try { expect(JSON.stringify(project(g, P(2)))).toBe(a); } finally { Date.now = realNow; }
  });
});

describe("PR2 every view parses strictly, has no undefined and survives JSON (PJ2)", () => {
  const viewers = (g: Game): Viewer[] => viewersOf(g).map((t) => t.viewer);
  test("every fixture, every viewer, with and without a host seat", () => {
    let n = 0;
    for (const [name, g] of states()) {
      for (const v of viewers(g)) {
        const view = project(g, v);
        const parsed = GameViewSchema.safeParse(view);
        expect(parsed.success, `${name} ${JSON.stringify(v)}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`).toBe(true);
        expect(JSON.parse(JSON.stringify(view)) as unknown, `${name} ${JSON.stringify(v)} (undefined values or non-JSON types)`).toStrictEqual(view);
        n++;
      }
    }
    expect(n).toBeGreaterThan(100);
  });
  test("PlayerView.host is absent, not undefined, for a player who is not the host", () => {
    const view = project(roundGame({ n: 4, judge: 1 }), P(2));
    expect(Object.hasOwn(view, "host")).toBe(false);
    expect(Object.hasOwn(project(roundGame({ n: 4, judge: 1 }), P(0)), "host")).toBe(true);
  });
  test("a spectator view has neither you nor host; an unseated host has host and no you", () => {
    const g = roundGame({ n: 4, judge: 1 });
    expect(Object.keys(project(g, SPEC)).includes("you")).toBe(false);
    expect(Object.keys(project(g, SPEC)).includes("host")).toBe(false);
    const hu = project(unseatHost(g), HU);
    expect(Object.keys(hu).includes("you")).toBe(false);
    expect(Object.hasOwn(hu, "host")).toBe(true);
  });

  const placeholders: Picks = Array.from({ length: 500 }, () => ({ kind: "legal" as const, pick: 0 }));
  const created = (pitch: boolean): Game => {
    const c = decide(null, { type: "createGame", gameId: "gameaaaaaaaaaaaaaaaa", roomCode: "BCDF", hostId: HOST_UID, hostPlayerId: pid(0), hostName: "Host" }, {
      now: 1, rng: { seed: "s", int: () => 0, shuffle: (x) => [...x] }, mintId: () => "c_0000000000", actor: { kind: "user", uid: HOST_UID }, drafts: {},
    });
    if (!c.ok) throw new Error("createGame");
    if (!pitch) return c.value.state;
    const u = decide(c.value.state, { type: "updateSettings", patch: { variants: { pitch: true, writeIn: false, redraw: false, peoplesChoice: true }, spectators: { enabled: true, vote: true } } } as never, {
      now: 2, rng: { seed: "s", int: () => 0, shuffle: (x) => [...x] }, mintId: () => "c_0000000001", actor: { kind: "user", uid: HOST_UID }, drafts: {},
    });
    if (!u.ok) throw new Error("updateSettings");
    return u.value.state;
  };
  test("over real decide output: every state of whole churned and straight games, every viewer, parses strictly and round-trips", () => {
    const seen = { states: 0, phases: new Set<string>(), judging: 0, departed: 0 };
    assertProperty(fc.property(fc.integer({ min: 3, max: 7 }), fc.integer(), fc.boolean(), (n, seed, churn) => {
      const drive = churn ? membershipDriver(`${seed}`, n, enumerators) : progressDriver(`${seed}`, n, enumerators, true);
      const trace = runScenario(decide, created(true), placeholders, { seed, table: enumerators, drive });
      for (const g of trace.states) {
        if (g === null) continue;
        seen.states++;
        seen.phases.add(g.phase);
        if (g.round?.phase === "JUDGING") seen.judging++;
        for (const t of viewersOf(g)) {
          if (t.viewer.kind === "departed") seen.departed++;
          const view = project(g, t.viewer);
          expect(GameViewSchema.safeParse(view).success).toBe(true);
          expect(JSON.parse(JSON.stringify(view)) as unknown).toStrictEqual(view);
        }
      }
    }), { ...process.env, FC_NUM_RUNS: process.env.FC_NUM_RUNS ?? "8" });
    expect(seen.phases.has("PLAYING")).toBe(true);
    expect(seen.judging).toBeGreaterThan(0);
    expect(seen.departed).toBeGreaterThan(0);
  });
});

describe("DP1 the departed view (4.3, 5.4)", () => {
  const g = park(park(roundGame({ n: 4, judge: 1, submitted: [2], extra: { roomCode: "ROOM" } }), 3, "left"), 2, "removed");
  test("exactly kind, audience, gameId, version, reason", () => {
    const view = project(g, DEP(3, "left"));
    expect(Object.keys(view).sort()).toEqual(["audience", "gameId", "kind", "reason", "version"]);
    expect(view).toStrictEqual({ kind: "departed", audience: "departed", gameId: g.id, version: g.version, reason: "left" });
  });
  test("each reason is passed through: left, removed, gone", () => {
    expect([...DEPARTED_REASONS].sort()).toEqual(["gone", "left", "removed"]);
    for (const reason of DEPARTED_REASONS) expect((project(g, DEP(3, reason)) as { reason: string }).reason).toBe(reason);
  });
  test("it carries no game data: no player name, card id, card text, room code or uid", () => {
    const text = JSON.stringify(project(g, DEP(2, "removed")));
    for (const secret of ["Player 0", "Player 1", "ROOM", cid(900), "the green card", uidOf(2), uidOf(0), "seat:", pid(1)]) expect(text).not.toContain(secret);
  });
  test("it parses strictly and is the same for a departed viewer of any phase", () => {
    for (const [name, game] of states()) {
      const view = project(game, DEP(1, "left"));
      expect(GameViewSchema.safeParse(view).success, name).toBe(true);
      expect(Object.keys(view).sort(), name).toEqual(["audience", "gameId", "kind", "reason", "version"]);
    }
  });
});
