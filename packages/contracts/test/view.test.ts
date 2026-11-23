// #27: GameView, ViewDoc and RoundDoc strict and loose schemas (LLD 5 2.5; LLD 2 4.1, 4.2, 7.1).
import { describe, expect, test } from "bun:test";
import * as contracts from "../src";
import {
  DEPARTED_REASONS, GameViewLooseSchema, GameViewSchema, PHASES, PLAYER_STATUSES, ROUND_PHASES, RoundDocLooseSchema, RoundDocSchema,
  SettingsSchema, ViewDocLooseSchema, ViewDocSchema, YOU_TURNS, makeViewSchemas,
} from "../src";
import type { GameView, GameViewLoose, RoundDoc, ViewDoc } from "../src";
import { C, GID, gameViews, roundDocs, viewDocs } from "./fixtures/view";

type Json = Record<string, unknown>;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <_T extends true>(): void => undefined;

// V13: the strict view is a discriminated union on `audience`; the strict type is assignable to the loose one.
assertType<Equal<GameView["audience"], "spectator" | "host" | "player" | "departed">>();
assertType<GameView extends GameViewLoose ? true : false>();
assertType<Equal<ViewDoc["schema"], 1>>();
assertType<Equal<RoundDoc["redacted"], boolean>>();

interface Target { name: string; strict: { safeParse(v: unknown): { success: boolean } }; loose: { safeParse(v: unknown): { success: boolean } }; docs: Record<string, Json>; wrapped: boolean }
const targets: Target[] = [
  { name: "GameView", strict: GameViewSchema, loose: GameViewLooseSchema, docs: gameViews, wrapped: false },
  { name: "ViewDoc", strict: ViewDocSchema, loose: ViewDocLooseSchema, docs: viewDocs, wrapped: true },
  { name: "RoundDoc", strict: RoundDocSchema, loose: RoundDocLooseSchema, docs: roundDocs, wrapped: false },
];
const clone = <T>(v: T): T => structuredClone(v);
const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown): boolean => s.safeParse(v).success;

type Path = (string | number)[];
const RECORDS = new Set(["you.myVotes"]); // a record's keys are data, not schema keys
const norm = (p: Path): string => p.map((s) => (typeof s === "number" ? "[]" : s)).join(".").replace(/\.\[\]/g, "[]");
const get = (root: unknown, p: Path): unknown => p.reduce<unknown>((o, k) => (o as Record<string | number, unknown>)[k], root);
const setAt = <T>(root: T, p: Path, v: unknown): T => {
  const c = clone(root);
  if (p.length === 0) return v as T;
  (get(c, p.slice(0, -1)) as Record<string | number, unknown>)[p[p.length - 1] as string | number] = v;
  return c;
};
const del = <T>(root: T, p: Path): T => {
  const c = clone(root);
  delete (get(c, p.slice(0, -1)) as Record<string, unknown>)[p[p.length - 1] as string];
  return c;
};
/** Every object node (not arrays, not records) with its path. */
function objectPaths(v: unknown, p: Path = [], inView = false): Path[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => objectPaths(x, [...p, i], inView));
  if (v === null || typeof v !== "object") return [];
  if (RECORDS.has(viewNorm(p))) return [];
  return [p, ...Object.entries(v).flatMap(([k, x]) => objectPaths(x, [...p, k], inView))];
}
/** ViewDoc paths below `view` are reported as GameView paths so one allowlist serves both. */
const viewNorm = (p: Path): string => norm(p[0] === "view" ? p.slice(1) : p);

const OPTIONAL_KEYS = new Set(["draft", "draftSeq", "host(player)"]);
const optionalKey = (root: Json, p: Path): string => {
  const last = p[p.length - 1];
  const parent = get(root, p.slice(0, -1)) as Json;
  if (last === "host" && parent["audience"] === "player") return "host(player)";
  return p.length === 1 && typeof last === "string" ? last : "";
};

describe("V1 valid fixtures parse strict and loose", () => {
  for (const t of targets) {
    for (const [name, doc] of Object.entries(t.docs)) {
      test(`${t.name} ${name}`, () => {
        expect(t.strict.safeParse(doc).error?.issues ?? []).toEqual([]);
        expect(t.loose.safeParse(doc).error?.issues ?? []).toEqual([]);
      });
    }
  }
  test("the factory returns both schema sets from one definition", () => {
    const s = makeViewSchemas("strict");
    const l = makeViewSchemas("loose");
    expect(ok(s.GameView, gameViews["host"])).toBe(true);
    expect(ok(l.RoundDoc, roundDocs["plain"])).toBe(true);
    expect(ok(s.ViewDoc, { ...viewDocs["spectator"], extra: 1 })).toBe(false);
    expect(ok(l.ViewDoc, { ...viewDocs["spectator"], extra: 1 })).toBe(true);
  });
});

describe("V2 fixtures exercise every nullable", () => {
  const NULLABLE = [
    "round.judgeId", "round.reveal", "round.reveal[].pitch", "writeCounts", "players[].cardsLeft", "awards", "winnerId", "settings.targetOverride",
    "you.yourSubmission", "you.yourSubmission.pitch", "you.writeTarget", "you.cardsLeft", "host.writeCountsOverride", "view", "draft", "green.text",
    "plays[].text", "plays[].pitch",
  ];
  const seen = new Map<string, Set<boolean>>();
  const walk = (v: unknown, p: Path): void => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, [...p, i]));
    const key = viewNorm(p);
    if (v === null) { seen.set(key, (seen.get(key) ?? new Set()).add(true)); return; }
    if (typeof v !== "object") { seen.set(key, (seen.get(key) ?? new Set()).add(false)); return; }
    seen.set(key, (seen.get(key) ?? new Set()).add(false));
    if (RECORDS.has(key)) return;
    for (const [k, x] of Object.entries(v)) walk(x, [...p, k]);
  };
  for (const t of targets) for (const d of Object.values(t.docs)) walk(d, []);
  for (const path of NULLABLE) {
    test(`${path} is seen null and non-null`, () => {
      expect([...(seen.get(path) ?? [])].sort()).toEqual([false, true]);
    });
  }
  test("reveal is also seen as an empty array", () => {
    expect(Object.values(gameViews).some((v) => Array.isArray((v["round"] as Json | null)?.["reveal"]) && ((v["round"] as Json)["reveal"] as unknown[]).length === 0)).toBe(true);
  });
  test("ids are valid and fixtures contain no UUID literal", () => {
    expect(GID).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(JSON.stringify([gameViews, viewDocs, roundDocs])).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe("V3 strict rejects an extra key at every object path, loose accepts it", () => {
  for (const t of targets) {
    for (const [name, doc] of Object.entries(t.docs)) {
      test(`${t.name} ${name}`, () => {
        const paths = objectPaths(doc);
        expect(paths.length).toBeGreaterThan(0);
        for (const p of paths) {
          const mutated = setAt(doc, [...p, "zzExtra"], 1);
          expect([p.join("."), ok(t.strict, mutated)]).toEqual([p.join("."), false]);
          expect([p.join("."), ok(t.loose, mutated)]).toEqual([p.join("."), true]);
        }
      });
    }
  }
});

describe("V4 a missing key fails both modes unless it is a named optional", () => {
  const seenOptional = new Set<string>();
  for (const t of targets) {
    for (const [name, doc] of Object.entries(t.docs)) {
      test(`${t.name} ${name}`, () => {
        for (const p of objectPaths(doc)) {
          for (const k of Object.keys(get(doc, p) as Json)) {
            const path = [...p, k];
            const mutated = del(doc, path);
            const opt = OPTIONAL_KEYS.has(optionalKey(doc, path));
            if (opt) seenOptional.add(optionalKey(doc, path));
            for (const s of [t.strict, t.loose]) expect([path.join("."), ok(s, mutated)]).toEqual([path.join("."), opt]);
          }
        }
      });
    }
  }
  test("every named optional was exercised", () => {
    // runs after the sweeps above (bun runs tests in file order)
    expect([...seenOptional].sort()).toEqual([...OPTIONAL_KEYS].sort());
  });
  test("draft is optional and nullable: absent, null and present all parse", () => {
    const d = viewDocs["playerWithDraft"]!;
    expect(ok(ViewDocSchema, del(del(d, ["draft"]), ["draftSeq"]))).toBe(true);
    expect(ok(ViewDocSchema, setAt(d, ["draft"], null))).toBe(true);
    expect(ok(ViewDocSchema, setAt(d, ["draft"], undefined))).toBe(true);
  });
  test("an explicit undefined for host (omitted-not-undefined is the writer's rule; the schema tolerates absent only)", () => {
    expect(ok(GameViewSchema, del(gameViews["playerSubmission"], ["host"]))).toBe(true);
  });
});

describe("V5 strict rejects fields that belong to the Engine and never to a view (PJ7)", () => {
  const where: [string, string, Path][] = [
    ["spectatorJudging", "top level", []], ["spectatorJudging", "players[]", ["players", 0]], ["spectatorJudging", "round", ["round"]],
    ["spectatorJudging", "reveal[]", ["round", "reveal", 0]], ["player", "you", ["you"]], ["host", "host", ["host"]], ["departed", "departed", []],
  ];
  for (const key of ["uid", "hostId", "scorePile", "seed", "episode", "powerUsage"]) {
    for (const [name, label, p] of where) {
      if (key === "powerUsage" && label === "you") continue; // own powerUsage is a required you field
      test(`${key} in ${name} ${label}`, () => {
        const mutated = setAt(gameViews[name], [...p, key], key === "uid" ? "u" : []);
        expect(ok(GameViewSchema, mutated)).toBe(false);
      });
    }
  }
  test("another player's powerUsage and a raw uid fail in players[]", () => {
    expect(ok(GameViewSchema, setAt(gameViews["spectatorLobby"], ["players", 1, "powerUsage"], { writeIn: false, redraw: false }))).toBe(false);
    expect(ok(GameViewSchema, setAt(gameViews["spectatorLobby"], ["players", 1, "uid"], "seat:x"))).toBe(false);
  });
});

describe("V7 enums: loose accepts unknown strings, strict rejects; literals stay exact", () => {
  const enumPaths: [string, string, Path][] = [
    ["phase", "spectatorLobby", ["phase"]], ["status in players[]", "spectatorLobby", ["players", 0, "status"]],
    ["round phase", "spectatorJudging", ["round", "phase"]], ["profanity", "spectatorLobby", ["settings", "profanity"]],
    ["you.turn", "player", ["you", "turn"]], ["you.status", "player", ["you", "status"]], ["departed reason", "departed", ["reason"]],
  ];
  for (const [label, name, p] of enumPaths) {
    test(`${label}: future value`, () => {
      const m = setAt(gameViews[name], p, "future_value");
      expect(ok(GameViewSchema, m)).toBe(false);
      expect(ok(GameViewLooseSchema, m)).toBe(true);
    });
    test(`${label}: also loose-parsed inside a ViewDoc`, () => {
      const m = setAt({ ...viewDocs["spectator"], view: gameViews[name] }, ["view", ...p], "future_value");
      expect(ok(ViewDocSchema, m)).toBe(false);
      expect(ok(ViewDocLooseSchema, m)).toBe(true);
    });
    test(`${label}: a non-string still fails loose`, () => {
      expect(ok(GameViewLooseSchema, setAt(gameViews[name], p, 5))).toBe(false);
    });
  }
  test("the audience, kind and schema literals are exact in both modes", () => {
    for (const bad of ["future", "Spectator", ""]) {
      expect(ok(GameViewLooseSchema, setAt(gameViews["spectatorLobby"], ["audience"], bad))).toBe(false);
      expect(ok(GameViewSchema, setAt(gameViews["spectatorLobby"], ["audience"], bad))).toBe(false);
    }
    expect(ok(GameViewLooseSchema, setAt(gameViews["spectatorLobby"], ["kind"], "dead"))).toBe(false);
    expect(ok(GameViewLooseSchema, setAt(gameViews["departed"], ["kind"], "live"))).toBe(false);
    expect(ok(ViewDocLooseSchema, setAt(viewDocs["spectator"], ["schema"], 2))).toBe(false);
    expect(ok(RoundDocLooseSchema, setAt(roundDocs["plain"], ["schema"], 2))).toBe(false);
    expect(ok(ViewDocSchema, setAt(viewDocs["spectator"], ["schema"], 2))).toBe(false);
  });
  test("a bad id, a wrong number and a missing key still fail loose", () => {
    expect(ok(GameViewLooseSchema, setAt(gameViews["spectatorLobby"], ["gameId"], "short"))).toBe(false);
    expect(ok(GameViewLooseSchema, setAt(gameViews["spectatorLobby"], ["version"], 1.5))).toBe(false);
  });
});

describe("V8 enum tuples", () => {
  test("YOU_TURNS are the ten LLD 2 4.4 values in order", () => {
    expect([...YOU_TURNS]).toEqual(["lobby", "write", "ready", "submit", "submitted", "judge", "wait", "sit_out", "paused", "over"]);
  });
  test("the other tuples", () => {
    expect([...PHASES]).toEqual(["LOBBY", "WRITING", "PLAYING", "FINISHED", "ENDED"]);
    expect([...PLAYER_STATUSES]).toEqual(["writing", "ready", "active", "left", "removed"]);
    expect([...ROUND_PHASES]).toEqual(["SUBMITTING", "JUDGING"]);
    expect([...DEPARTED_REASONS]).toEqual(["left", "removed", "gone"]);
  });
  test("every YouTurn parses strict in you.turn, and nothing else does", () => {
    for (const turn of YOU_TURNS) expect(ok(GameViewSchema, setAt(gameViews["player"], ["you", "turn"], turn))).toBe(true);
    expect(ok(GameViewSchema, setAt(gameViews["player"], ["you", "turn"], "sitting_out"))).toBe(false);
  });
});

describe("V9 PublicSettings is Settings minus writeCountsOverride", () => {
  const samples: Record<string, unknown[]> = {
    targetOverride: [null, 1, 2, 10, 11, 2.5, "3"],
    profanity: ["on", "off", "ON", null, 1],
    variants: [{ pitch: true, writeIn: false, redraw: true, peoplesChoice: false }, { pitch: true }, {}, null, { pitch: true, writeIn: true, redraw: true, peoplesChoice: true, x: 1 }],
    spectators: [{ enabled: true, vote: false }, { enabled: true }, null, { enabled: "y", vote: true }],
  };
  const keys = Object.keys(SettingsSchema.shape).filter((k) => k !== "writeCountsOverride");
  test("the key sets agree", () => {
    expect(Object.keys(samples).sort()).toEqual([...keys].sort());
    const s = (gameViews["spectatorJudging"] as Json)["settings"] as Json;
    expect(Object.keys(s).sort()).toEqual([...keys].sort());
    expect(ok(GameViewSchema, setAt(gameViews["spectatorJudging"], ["settings", "writeCountsOverride"], null))).toBe(false);
  });
  for (const k of keys) {
    test(`${k} accepts exactly what SettingsSchema accepts`, () => {
      const field = (SettingsSchema.shape as Record<string, { safeParse(v: unknown): { success: boolean } }>)[k]!;
      for (const v of samples[k]!) {
        // SettingsSchema's objects strip unknown keys; the strict view rejects them, so compare against the strict form of the same input
        const hasUnknown = typeof v === "object" && v !== null && "x" in v;
        const expected = hasUnknown ? false : field.safeParse(v).success;
        expect([k, JSON.stringify(v), ok(GameViewSchema, setAt(gameViews["spectatorJudging"], ["settings", k], v))]).toEqual([k, JSON.stringify(v), expected]);
      }
    });
  }
});

describe("V10 numeric and key rules", () => {
  const bad: [string, string, Path, unknown][] = [
    ["version", "spectatorLobby", ["version"], -1], ["version", "spectatorLobby", ["version"], 1.5],
    ["resolved", "spectatorLobby", ["resolved"], -1], ["target", "spectatorLobby", ["target"], 0],
    ["score", "spectatorLobby", ["players", 0, "score"], -1], ["joinOrder", "spectatorLobby", ["players", 0, "joinOrder"], -1],
    ["cardsLeft", "spectatorLobby", ["players", 0, "cardsLeft", "red"], -1], ["writeCounts", "spectatorJudging", ["writeCounts", "red"], 1.5],
    ["round.number", "spectatorJudging", ["round", "number"], 0], ["rank 0", "spectatorFinished", ["awards", "podium", 0, "rank"], 0],
    ["rank 4", "spectatorFinished", ["awards", "podium", 0, "rank"], 4], ["podium round", "spectatorFinished", ["awards", "podium", 0, "round"], 0],
    ["votes", "spectatorFinished", ["awards", "podium", 0, "votes"], -1], ["player id", "spectatorLobby", ["players", 0, "id"], "p_AAAAAAAA"],
    ["card id", "spectatorJudging", ["round", "green", "id"], "c_short"], ["gameId", "spectatorLobby", ["gameId"], "short"],
    ["myVotes key 0", "playerWithHost", ["you", "myVotes"], { "0": C(5) }], ["myVotes key text", "playerWithHost", ["you", "myVotes"], { x: C(5) }],
    ["myVotes key leading zero", "playerWithHost", ["you", "myVotes"], { "01": C(5) }], ["myVotes value", "playerWithHost", ["you", "myVotes"], { "1": "nope" }],
    ["playability.n", "host", ["host", "playability", "n"], -1], ["roomCode", "host", ["host", "roomCode"], "ABCD"],
    ["writeTarget", "playerWithHost", ["you", "writeTarget", "green"], -1], ["targetOverride range", "spectatorJudging", ["settings", "targetOverride"], 11],
  ];
  for (const [label, name, p, v] of bad) {
    test(`${label} = ${JSON.stringify(v)} fails strict and loose`, () => {
      const m = setAt(gameViews[name], p, v);
      expect(ok(GameViewSchema, m)).toBe(false);
      expect(ok(GameViewLooseSchema, m)).toBe(false);
    });
  }
  test("boundaries that are valid", () => {
    for (const [name, p, v] of [
      ["spectatorLobby", ["version"], 0], ["spectatorFinished", ["awards", "podium", 0, "rank"], 2], ["spectatorLobby", ["resolved"], 0],
      ["playerWithHost", ["you", "myVotes"], { "12": C(5) }], ["spectatorLobby", ["players", 0, "score"], 0],
    ] as [string, Path, unknown][]) {
      expect(ok(GameViewSchema, setAt(gameViews[name], p, v))).toBe(true);
    }
  });
  test("ViewDoc and RoundDoc numbers", () => {
    expect(ok(ViewDocSchema, setAt(viewDocs["spectator"], ["viewsRev"], -1))).toBe(false);
    expect(ok(ViewDocSchema, setAt(viewDocs["spectator"], ["generatedAt"], 1.5))).toBe(false);
    expect(ok(RoundDocSchema, setAt(roundDocs["plain"], ["round"], 0))).toBe(false);
    expect(ok(RoundDocSchema, setAt(roundDocs["plain"], ["resolvedAt"], -1))).toBe(false);
  });
  test("view is null only as a value, never absent; draft shapes are exact", () => {
    expect(ok(ViewDocSchema, del(viewDocs["spectatorDisabled"], ["view"]))).toBe(false);
    expect(ok(ViewDocSchema, setAt(viewDocs["playerWithDraft"], ["draft"], { red: ["a"] }))).toBe(false);
    expect(ok(ViewDocSchema, setAt(viewDocs["playerWithDraft"], ["draft"], { red: [1], green: [] }))).toBe(false);
  });
});

describe("V11 RoundDoc carries no player-keyed secrets", () => {
  for (const key of ["writeIn", "votes", "hand", "draft", "name"]) {
    test(`strict rejects ${key} at the top and in plays[]`, () => {
      expect(ok(RoundDocSchema, setAt(roundDocs["plain"], [key], 1))).toBe(false);
      expect(ok(RoundDocSchema, setAt(roundDocs["plain"], ["plays", 0, key], 1))).toBe(false);
    });
  }
  test("plays[].pitch is a string or null, text a string or null", () => {
    expect(ok(RoundDocSchema, setAt(roundDocs["plain"], ["plays", 0, "pitch"], 3))).toBe(false);
    expect(ok(RoundDocSchema, setAt(roundDocs["plain"], ["plays", 0, "text"], 3))).toBe(false);
  });
});

describe("V12 export surface", () => {
  test("the index exports the schemas, the factory and the enum tuples", () => {
    for (const n of [
      "makeViewSchemas", "GameViewSchema", "ViewDocSchema", "RoundDocSchema", "GameViewLooseSchema", "ViewDocLooseSchema", "RoundDocLooseSchema",
      "PHASES", "PLAYER_STATUSES", "ROUND_PHASES", "YOU_TURNS", "DEPARTED_REASONS", "PhaseSchema", "PlayerStatusSchema", "RoundPhaseSchema",
      "YouTurnSchema", "DepartedReasonSchema", "DraftSchema",
    ]) expect([n, n in contracts]).toEqual([n, true]);
  });
  test("the enum schemas accept exactly their tuples", () => {
    for (const [schema, tuple] of [
      [contracts.PhaseSchema, PHASES], [contracts.PlayerStatusSchema, PLAYER_STATUSES], [contracts.RoundPhaseSchema, ROUND_PHASES],
      [contracts.YouTurnSchema, YOU_TURNS], [contracts.DepartedReasonSchema, DEPARTED_REASONS],
    ] as const) {
      for (const v of tuple) expect(schema.safeParse(v).success).toBe(true);
      expect(schema.safeParse("nope").success).toBe(false);
    }
  });
  test("DraftSchema is the viewer's draft shape", () => {
    expect(contracts.DraftSchema.safeParse({ red: ["a"], green: [] }).success).toBe(true);
    expect(contracts.DraftSchema.safeParse({ red: ["a"] }).success).toBe(false);
  });
});
