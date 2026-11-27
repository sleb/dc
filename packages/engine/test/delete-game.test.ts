import { describe, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { decide } from "../src/decide";
import { REGISTRY } from "../src/registry";
import type { Actor, Ctx, Game, Phase } from "../src/types";
import { GAME_ID, HOST_UID, ctxFor, makeGame, makePlayer, pid, seatUidOf, userActor } from "./support/factories";
import { junkCommands, legalCommands } from "./support/legal";

// D1-D5 (LLD 1 sections 5.3, 6, 7.1, 7.2, 7.3, 15.2): the real deleteGame row. The app deletes the game; the
// Engine authorizes only, so the state, version and events envelope stay exactly as they were.
const cmd = (c: object): Command => c as unknown as Command;
const host: Actor = userActor(HOST_UID);
const seat = (n: number): Actor => userActor(seatUidOf(GAME_ID, pid(n)));
const stranger: Actor = userActor("stranger-uid");
const system: Actor = { kind: "system" };
const PHASES: Phase[] = ["LOBBY", "WRITING", "PLAYING", "FINISHED", "ENDED"];

const game = (phase: Phase): Game =>
  makeGame({ phase, players: [0, 1, 2].map((i) => makePlayer(i, { status: phase === "LOBBY" ? "writing" : "active" })) });
const run = (state: Game | null, c: object, actor: Actor = host, ctx: Partial<Ctx> = {}) => decide(state, cmd(c), ctxFor({ actor, ...ctx }));

describe("D1 the real deleteGame row accepts the host in every phase and changes nothing", () => {
  for (const phase of PHASES) {
    test(`${phase}: GameDeleted, aggregateChanged false, unchanged state and version, deleteGame true`, () => {
      const before = game(phase);
      const r = run(before, { type: "deleteGame" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.state).toEqual(before);
      expect(r.value.state.version).toBe(before.version);
      expect(r.value.events).toEqual([{ t: "GameDeleted" }]);
      expect(r.value.aggregateChanged).toBe(false);
      expect(r.value.deleteGame).toBe(true);
      expect(r.value.draftChanges).toEqual([]);
      expect(r.value.roundRecords).toEqual([]);
    });
  }
});

describe("D2 ENDED is terminal: deleteGame is the only accepted command", () => {
  test("every other registered command for the host is WRONG_PHASE, and a stranger's deleteGame is NOT_AUTHORIZED", () => {
    const ended = game("ENDED");
    const seen = new Set<string>();
    for (const { actor, cmd: c } of junkCommands(ended)) {
      if (actor.kind !== "user" || actor.uid !== HOST_UID || !Object.hasOwn(REGISTRY, c.type)) continue;
      seen.add(c.type);
      const r = run(ended, c);
      if (c.type === "deleteGame") expect(r.ok).toBe(true);
      else expect(r).toStrictEqual({ ok: false, error: { code: "WRONG_PHASE" } });
    }
    expect([...seen].sort()).toEqual(Object.keys(REGISTRY).sort());
    expect(run(ended, { type: "deleteGame" }, stranger)).toStrictEqual({ ok: false, error: { code: "NOT_AUTHORIZED" } });
  });
});

describe("D3 authorization is host-only in every phase", () => {
  for (const phase of PHASES) {
    test(`${phase}: seated non-host, stranger and system are NOT_AUTHORIZED; the host is accepted`, () => {
      for (const actor of [seat(1), stranger, system]) {
        expect(run(game(phase), { type: "deleteGame" }, actor)).toStrictEqual({ ok: false, error: { code: "NOT_AUTHORIZED" } });
      }
      expect(run(game(phase), { type: "deleteGame" }, host).ok).toBe(true);
    });
  }

  test("an unseated host (uid === hostId, no player record) is accepted", () => {
    const unseated = makeGame({ players: [makePlayer(1), makePlayer(2)] });
    expect(run(unseated, { type: "deleteGame" }, host).ok).toBe(true);
  });
});

describe("D4 null state and expectedVersion", () => {
  test("a null state is NOT_FOUND", () => {
    expect(run(null, { type: "deleteGame" }, host)).toStrictEqual({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("expectedVersion of any shape does not change the outcome: authorization only", () => {
    for (const expectedVersion of [undefined, -1, 0, 1, 4.5, "x", null]) {
      expect(run(game("LOBBY"), { type: "deleteGame", expectedVersion }).ok).toBe(true);
      expect(run(game("LOBBY"), { type: "deleteGame", expectedVersion }, seat(1))).toStrictEqual({ ok: false, error: { code: "NOT_AUTHORIZED" } });
    }
  });
});

describe("D5 the enumerator and the registry agree (G1, E1, E15)", () => {
  test("legalCommands enumerates the host's deleteGame in every phase", () => {
    for (const phase of PHASES) {
      const entries = legalCommands(game(phase), {}).filter((e) => e.cmd.type === "deleteGame");
      expect(entries).toEqual([{ actor: host, cmd: { type: "deleteGame" } }]);
    }
  });

  test("the registry holds the row and only deleteGame is accepted in ENDED", () => {
    expect(Object.hasOwn(REGISTRY, "deleteGame")).toBe(true);
    expect(REGISTRY.deleteGame).toMatchObject({ type: "deleteGame", phases: PHASES });
    for (const { cmd: c } of legalCommands(game("ENDED"), {})) {
      const r = run(game("ENDED"), c);
      if (c.type === "deleteGame") expect(r.ok).toBe(true);
      else expect(r).toStrictEqual({ ok: false, error: { code: "WRONG_PHASE" } });
    }
  });
});
