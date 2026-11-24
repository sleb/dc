// #30 H2 (sentinels) and H4 (variant injector). LLD 2 11.1.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { decide } from "../../src/decide";
import { check } from "../../src/moderation";
import type { Game } from "../../src/types";
import { checkAll } from "../support/checks";
import type { Step } from "../support/checks";
import { ctxFor, deepFreeze, pid } from "../support/factories";
import { enumerators } from "../support/legal";
import { membershipDriver, progressDriver, runScenario } from "../support/scenario";
import { decorate, sentinel, sentinelDriver } from "./inject";
import { created } from "./scenarios";
import { finished, judging, lobby, submitting } from "./fixtures";

setDefaultTimeout(180_000); // generated games on a loaded machine must not trip the 5 s default
const SENT = /^[RGP]\d{4}x$/;

describe("H2 sentinels", () => {
  test("fixed width, unique, no one a substring of another, and untouched by Moderation with the profanity filter on and off", () => {
    const all = new Set<string>();
    for (const kind of ["R", "G", "P"] as const) {
      for (let n = 0; n < 10_000; n++) {
        const s = sentinel(kind, n);
        expect(s).toMatch(SENT);
        expect(s.length).toBe(6);
        all.add(s);
        const k = kind === "P" ? "pitch" : "card";
        for (const mode of ["on", "off"] as const) {
          const r = check(s, k, mode);
          if (!r.ok || r.text !== s) throw new Error(`moderation changes or rejects ${s} (${mode})`);
        }
      }
    }
    expect(all.size).toBe(30_000);
    expect(() => sentinel("R", 10_000)).toThrow();
  });

  for (const profanity of ["on", "off"] as const) {
    test(`through a whole game (profanity ${profanity}) every card text and pitch is a unique sentinel and every minted id is c_ plus 10 characters`, () => {
      const g0: Game = { ...created(true), settings: { ...created(true).settings, profanity } };
      const picks = Array.from({ length: 400 }, () => ({ kind: "legal" as const, pick: 0 }));
      const tr = runScenario(decide, g0, picks, { seed: 5, table: enumerators, drive: sentinelDriver(membershipDriver("5", 5, enumerators)) });
      const last = tr.states.at(-1) as Game;
      const texts = Object.values(last.cards).map((c) => c.text);
      expect(texts.length).toBeGreaterThan(50);
      for (const t of texts) expect(t).toMatch(/^[RG]\d{4}x$/);
      expect(new Set(texts).size).toBe(texts.length);
      for (const id of Object.keys(last.cards)) expect(id).toMatch(/^c_[0-9a-z]{10}$/);
      const pitches = tr.states.flatMap((s) => (s?.round?.submissions ?? []).flatMap((x) => (x.pitch === undefined ? [] : [x.pitch])));
      expect(pitches.length).toBeGreaterThan(0);
      for (const p of pitches) expect(p).toMatch(/^P\d{4}x$/);
    });
  }

  test("an instance counts up from zero, so a scenario replays", () => {
    const run = () => runScenario(decide, created(true), Array.from({ length: 60 }, () => ({ kind: "legal" as const, pick: 0 })), { seed: 2, table: enumerators, drive: sentinelDriver(progressDriver("2", 3, enumerators, true)) });
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

describe("H4 the variant injector decorates an after-state with the shapes of types.ts and nothing else", () => {
  test("write-in: a marker on at least one submission, its owner's powerUsage.writeIn, the variant switch; the input is untouched", () => {
    const g = deepFreeze(structuredClone(submitting()));
    const v = decorate(g, 1);
    expect(v).not.toBeNull();
    expect(v?.kinds).toContain("writeIn");
    const marked = v?.game.round?.submissions.filter((s) => s.writeIn === true) ?? [];
    expect(marked.length).toBeGreaterThan(0);
    for (const s of marked) expect(v?.game.players.find((p) => p.id === s.playerId)?.powerUsage.writeIn).toBe(true);
    expect(v?.game.settings.variants.writeIn).toBe(true);
    expect(g.round?.submissions.some((s) => s.writeIn === true)).toBe(false);
  });

  test("redraw: powerUsage.redraw on a seated player; votes: valid Votes for resolved plays, by players and by a spectator", () => {
    const f = finished();
    const seen = new Set<string>();
    for (let salt = 0; salt < 8; salt++) for (const k of decorate(f, salt)?.kinds ?? []) seen.add(k);
    expect(seen.has("redraw")).toBe(true);
    expect(seen.has("votes")).toBe(true);
    const v = [0, 1, 2, 3, 4, 5, 6, 7].map((s) => decorate(f, s)).find((x) => x?.kinds.includes("votes"));
    for (const vote of v?.game.votes ?? []) {
      expect(vote.voter).toMatch(/^(p:p_[a-z2-7]{8}|s:.+)$/);
      expect(f.history.some((h) => h.round === vote.round && h.plays.some((p) => p.cardId === vote.cardId))).toBe(true);
    }
    expect(v?.game.votes.length).toBeGreaterThan(f.votes.length);
    expect(decorate(lobby(), 0)).toBeNull();
  });

  test("deterministic in (game, salt)", () => {
    expect(JSON.stringify(decorate(judging(), 3))).toBe(JSON.stringify(decorate(judging(), 3)));
  });

  const stepOf = (before: Game, cmd: unknown, uid: string): Step => {
    const result = decide(before, cmd as never, ctxFor({ actor: { kind: "user", uid } }));
    return { index: 0, before, cmd, result, actor: { kind: "user", uid } };
  };

  test("a decorated state passes the structural Engine checkers through real decide: pickWinner, leave, removePlayer (the commands that read the marker)", () => {
    const g = decorate(judging(), 1)?.game as Game;
    expect(g.round?.submissions.some((s) => s.writeIn === true)).toBe(true);
    const r = g.round;
    const judge = g.players.find((p) => p.id === r?.judgeId);
    const pick = stepOf(g, { type: "pickWinner", submissionId: r?.revealOrder?.[0], expectedVersion: r?.changedAtVersion }, judge?.uid ?? "");
    expect(pick.result.ok).toBe(true);
    expect(() => checkAll(pick)).not.toThrow();
    const sub = r?.submissions.find((s) => s.writeIn === true);
    const owner = g.players.find((p) => p.id === sub?.playerId);
    const leave = stepOf(g, { type: "leave" }, owner?.uid ?? "");
    expect(leave.result.ok).toBe(true);
    expect(() => checkAll(leave)).not.toThrow();
    const remove = stepOf(g, { type: "removePlayer", playerId: pid(sub === undefined ? 1 : Number(owner?.joinOrder)) }, g.hostId);
    expect(remove.result.ok).toBe(true);
    expect(() => checkAll(remove)).not.toThrow();
    // the engine acts on the marker: a leaving write-in author's card goes to the discard, not back to a hand
    if (leave.result.ok) expect(leave.result.value.state.pools.redDiscard).toContain(sub?.cardId as string);
  });

  test("decorated votes and flags do not break the structural checkers on a finished game that real commands produced", () => {
    const tr = runScenario(decide, created(true), Array.from({ length: 400 }, () => ({ kind: "legal" as const, pick: 0 })), { seed: 4, table: enumerators, drive: progressDriver("4", 3, enumerators, true) });
    const end = tr.states.at(-1) as Game;
    expect(end.phase).toBe("FINISHED");
    const v = decorate(end, 0);
    expect(v?.kinds).toEqual(expect.arrayContaining(["redraw", "votes"]));
    const step = stepOf(v?.game as Game, { type: "endGame" }, end.hostId);
    expect(step.result.ok).toBe(true);
    expect(() => checkAll(step)).not.toThrow();
  });
});
