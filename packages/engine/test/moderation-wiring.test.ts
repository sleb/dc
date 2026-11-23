// #25 (1.8): guard 8 wired into the four M1 entry points (createGame, join, saveDraft, confirmSubmission) through the real REGISTRY: V4 (M1), V5 (pitch), V6 (saveDraft), V7 (NAME_TAKEN), V8 (M2).
// `writeIn` and `importDeck` have no M1 owner (M7, M9); `finishWriting` does not re-moderate by design.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { TEXT_LIMITS } from "@dc/contracts";
import type { Command } from "@dc/contracts";
import { decide } from "../src/decide";
import { check } from "../src/moderation";
import { TERMS } from "../src/moderation/wordlist";
import type { Accepted, Actor, Ctx, Draft, Game, Rejection, Result } from "../src/types";
import { checkAll } from "./support/checks";
import { DEFAULT_SETTINGS, GAME_ID, HOST_UID, cid, ctxFor, makeGame, makePlayer, pid, seatUidOf, userActor } from "./support/factories";
import { assertProperty } from "./support/fc";
import { roundGame } from "./support/round-fixtures";
import { arbShape, buildGame } from "./support/scenario";

const cmd = (c: object): Command => c as unknown as Command;
const seat = (n: number): Actor => userActor(n === 0 ? HOST_UID : seatUidOf(GAME_ID, pid(n)));
const as = (n: number, over: Partial<Ctx> = {}): Ctx => ctxFor({ actor: seat(n), ...over });
const env = (): Record<string, string | undefined> => ({ ...process.env, FC_NUM_RUNS: process.env.FC_NUM_RUNS ?? "100" });
const run = (g: Game | null, c: object, ctx: Ctx): Result<Accepted, Rejection> => decide(g, cmd(c), ctx);
const accepted = (g: Game | null, c: object, ctx: Ctx): Accepted => {
  const r = run(g, c, ctx);
  if (!r.ok) throw new Error(`expected an acceptance of ${JSON.stringify(c)}, got ${JSON.stringify(r.error)}`);
  checkAll({ index: 0, before: g, cmd: c, result: r, actor: ctx.actor, drafts: ctx.drafts });
  return r.value;
};
const rejected = (g: Game | null, c: object, ctx: Ctx): Rejection => {
  const r = run(g, c, ctx);
  if (r.ok) throw new Error(`expected a rejection of ${JSON.stringify(c)}`);
  return r.error;
};
const settingsWith = (profanity: "on" | "off", pitch = false): Game["settings"] => ({ ...DEFAULT_SETTINGS, profanity, variants: { ...DEFAULT_SETTINGS.variants, pitch } });

type Kind = "name" | "card" | "pitch";
interface Row {
  name: string;
  kind: Kind;
  /** A blank text is not an error here (a blank pitch is no pitch). */
  blankOk: boolean;
  build(text: string, mode: "on" | "off"): { state: Game | null; cmd: object; ctx: Ctx };
  /** The text as stored by an accepted command (undefined when nothing was stored). */
  stored(v: Accepted): string | undefined;
}

const lobby = (n: number, mode: "on" | "off"): Game => makeGame({ version: 3, totalJoins: n - 1, settings: settingsWith(mode), players: Array.from({ length: n }, (_, i) => makePlayer(i)) });
const writing = (mode: "on" | "off", over: Partial<Game> = {}): Game =>
  makeGame({ phase: "WRITING", version: 5, target: 2, writeCounts: { red: 2, green: 2 }, settings: settingsWith(mode), players: [0, 1, 2].map((i) => makePlayer(i, { writeTarget: { red: 2, green: 2 } })), ...over });
const pitching = (mode: "on" | "off", on = true): Game => roundGame({ judge: 1, extra: { settings: settingsWith(mode, on) } });

const ROWS: Row[] = [
  {
    name: "createGame (host name)", kind: "name", blankOk: false,
    build: (text, mode) => ({ state: null, cmd: { type: "createGame", gameId: GAME_ID, roomCode: "BCDF", hostId: HOST_UID, hostPlayerId: pid(0), hostName: text, settings: { profanity: mode } }, ctx: as(0) }),
    stored: (v) => v.state.players[0]?.name,
  },
  {
    name: "join (name)", kind: "name", blankOk: false,
    build: (text, mode) => ({ state: lobby(3, mode), cmd: { type: "join", playerId: pid(5), name: text }, ctx: as(5) }),
    stored: (v) => v.state.players.at(-1)?.name,
  },
  {
    name: "saveDraft (card text, red)", kind: "card", blankOk: false,
    build: (text, mode) => ({ state: writing(mode), cmd: { type: "saveDraft", red: [text], green: [] }, ctx: as(1) }),
    stored: (v) => v.draftChanges[0]?.draft?.red[0],
  },
  {
    name: "saveDraft (card text, green)", kind: "card", blankOk: false,
    build: (text, mode) => ({ state: writing(mode), cmd: { type: "saveDraft", red: [], green: ["fine", text] }, ctx: as(1) }),
    stored: (v) => v.draftChanges[0]?.draft?.green[1],
  },
  {
    name: "confirmSubmission (pitch)", kind: "pitch", blankOk: true,
    build: (text, mode) => ({ state: pitching(mode), cmd: { type: "confirmSubmission", cardId: cid(200), pitch: text, expectedVersion: 5 }, ctx: as(2) }),
    stored: (v) => v.state.round?.submissions[0]?.pitch,
  },
];
const CONTENT = (reason: string): Rejection => ({ code: "CONTENT_REJECTED", detail: reason as never });
const attempt = (row: Row, text: string, mode: "on" | "off"): Result<Accepted, Rejection> => {
  const b = row.build(text, mode);
  return run(b.state, b.cmd, b.ctx);
};

describe("V4 M1: guard 8 at the four entry points, both modes", () => {
  for (const row of ROWS) {
    describe(row.name, () => {
      test("a profane text is CONTENT_REJECTED PROFANITY with the filter on and accepted with it off", () => {
        expect(attempt(row, "you zorblat", "on")).toStrictEqual({ ok: false, error: CONTENT(("PROFANITY")) });
        const off = attempt(row, "you zorblat", "off");
        expect(off.ok).toBe(true);
        if (off.ok) expect(row.stored(off.value)).toBe("you zorblat");
      });

      test("the structural rules hold in both modes: TOO_LONG, INVALID_CHARS, and EMPTY (a blank pitch is no pitch instead)", () => {
        for (const mode of ["on", "off"] as const) {
          expect(attempt(row, "c".repeat(TEXT_LIMITS[row.kind] + 1), mode)).toStrictEqual({ ok: false, error: CONTENT("TOO_LONG") });
          expect(attempt(row, "c".repeat(TEXT_LIMITS[row.kind]), mode).ok).toBe(true);
          expect(attempt(row, "bad\u0000text", mode)).toStrictEqual({ ok: false, error: CONTENT("INVALID_CHARS") });
          expect(attempt(row, "zero​width", mode)).toStrictEqual({ ok: false, error: CONTENT("INVALID_CHARS") });
          const blank = attempt(row, "   ", mode);
          if (row.blankOk) expect(blank.ok).toBe(true);
          else expect(blank).toStrictEqual({ ok: false, error: CONTENT("EMPTY") });
        }
      });

      test("the cleaned text is what is stored: NFC, trimmed, whitespace runs collapsed", () => {
        const v = attempt(row, "  café \t au   lait  ", "on");
        expect(v.ok).toBe(true);
        if (v.ok) expect(row.stored(v.value)).toBe("café au lait");
      });

      test("a rejection carries only the code and the reason: nothing of the input", () => {
        const r = attempt(row, "secret zorblat words", "on");
        expect(r.ok).toBe(false);
        expect(JSON.stringify(r)).toBe('{"ok":false,"error":{"code":"CONTENT_REJECTED","detail":"PROFANITY"}}');
      });
    });
  }

  test("P-M1: an entry point rejects a text exactly when check rejects it, with check's reason, in both modes; no entry point accepts what check rejects", () => {
    const variant = fc.tuple(fc.constantFrom(...TERMS), fc.constantFrom("", "x ", "ok then ", "\u0000", "​"), fc.constantFrom("", "!", " fine", "́")).map(([t, a, b]) => `${a}${t.term}${b}`);
    const text = fc.oneof(fc.string({ maxLength: 30 }), fc.string({ unit: "binary", maxLength: 12 }), variant, fc.string({ minLength: 70, maxLength: 150 }), fc.constantFrom("", " ", "\n"));
    assertProperty(fc.property(text, fc.constantFrom("on", "off"), fc.nat(ROWS.length - 1), (t, mode, i) => {
      const row = ROWS[i] as Row;
      const want = check(t, row.kind, mode);
      const got = attempt(row, t, mode);
      const noPitch = row.blankOk && !want.ok && want.reason === "EMPTY"; // a blank pitch is no pitch
      if (want.ok || noPitch) expect(got.ok).toBe(true);
      else expect(got).toStrictEqual({ ok: false, error: CONTENT(want.reason) });
      if (got.ok && want.ok) expect(row.stored(got.value)).toBe(want.text);
    }), env());
  });
});

describe("guard 8 sits after guard 7 and before guard 9 (5.3)", () => {
  test("createGame: a bad room code or a non-string host name is INVALID_ARGUMENT before a profane name is looked at", () => {
    const base = { type: "createGame", gameId: GAME_ID, roomCode: "BCDF", hostId: HOST_UID, hostPlayerId: pid(0), hostName: "zorblat" };
    expect(rejected(null, { ...base, roomCode: "no" }, as(0))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected(null, { ...base, hostName: 5 }, as(0))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected(null, base, as(0))).toStrictEqual(CONTENT("PROFANITY"));
  });

  test("createGame: the mode is the one the new game gets: settings.profanity off accepts, the default (on) rejects", () => {
    const base = { type: "createGame", gameId: GAME_ID, roomCode: "BCDF", hostId: HOST_UID, hostPlayerId: pid(0), hostName: "zorblat" };
    expect(rejected(null, base, as(0))).toStrictEqual(CONTENT("PROFANITY"));
    expect(rejected(null, { ...base, settings: {} }, as(0))).toStrictEqual(CONTENT("PROFANITY"));
    expect(accepted(null, { ...base, settings: { profanity: "off" } }, as(0)).state.players[0]?.name).toBe("zorblat");
  });

  test("join: a malformed id or a non-string name is INVALID_ARGUMENT first; CONTENT_REJECTED comes before NAME_TAKEN and ROOM_FULL", () => {
    const g = lobby(3, "on");
    expect(rejected(g, { type: "join", playerId: "nope", name: "zorblat" }, ctxFor({ actor: userActor(seatUidOf(GAME_ID, "nope")) }))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected(g, { type: "join", playerId: pid(5), name: "zorblat" }, as(5))).toStrictEqual(CONTENT("PROFANITY"));
    const full = makeGame({ settings: settingsWith("on"), players: Array.from({ length: 10 }, (_, i) => makePlayer(i, i === 3 ? { name: "Taken" } : {})) });
    expect(rejected(full, { type: "join", playerId: pid(20), name: "Taken" }, as(20))).toStrictEqual({ code: "NAME_TAKEN" });
    expect(rejected(full, { type: "join", playerId: pid(20), name: "   " }, as(20))).toStrictEqual(CONTENT("EMPTY"));
    expect(rejected({ ...full, totalJoins: 50 }, { type: "join", playerId: pid(20), name: "zorblat" }, as(20))).toStrictEqual(CONTENT("PROFANITY"));
  });

  test("saveDraft: too many cards (guard 7) beats a profane text; a profane text beats nothing else at guard 9", () => {
    expect(rejected(writing("on"), { type: "saveDraft", red: ["zorblat", "b", "c"], green: [] }, as(1))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected(writing("on"), { type: "saveDraft", red: ["zorblat"], green: [] }, as(1))).toStrictEqual(CONTENT("PROFANITY"));
    expect(rejected(writing("on", { phase: "PLAYING" }), { type: "saveDraft", red: ["zorblat"], green: [] }, as(2, {}))).toStrictEqual(CONTENT("PROFANITY"));
  });

  test("saveDraft: the first failing text decides the reason (red before green, in order)", () => {
    expect(rejected(writing("on"), { type: "saveDraft", red: ["ok", "bad\u0000"], green: ["zorblat"] }, as(1))).toStrictEqual(CONTENT("INVALID_CHARS"));
    expect(rejected(writing("on"), { type: "saveDraft", red: ["ok"], green: ["", "zorblat"] }, as(1))).toStrictEqual(CONTENT("EMPTY"));
  });

  test("confirmSubmission: the judge is NOT_AUTHORIZED, a missing expectedVersion INVALID_ARGUMENT and a stale one STALE, all before a profane pitch", () => {
    const g = pitching("on");
    const c = { type: "confirmSubmission", cardId: cid(200), pitch: "zorblat", expectedVersion: 5 };
    expect(rejected(g, c, as(1))).toStrictEqual({ code: "NOT_AUTHORIZED" });
    expect(rejected(g, { type: "confirmSubmission", cardId: cid(200), pitch: "zorblat" }, as(2))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected(g, { type: "confirmSubmission", cardId: cid(200), pitch: 5, expectedVersion: 5 }, as(2))).toStrictEqual({ code: "INVALID_ARGUMENT" });
    expect(rejected(g, c, as(2))).toStrictEqual(CONTENT("PROFANITY"));
  });

  test("confirmSubmission: a profane pitch is CONTENT_REJECTED before ALREADY_SUBMITTED, NOT_IN_HAND and VARIANT_UNAVAILABLE (guard 9)", () => {
    const g = pitching("on");
    expect(rejected(g, { type: "confirmSubmission", cardId: cid(9999), pitch: "zorblat", expectedVersion: 5 }, as(2))).toStrictEqual(CONTENT("PROFANITY"));
    expect(rejected(g, { type: "confirmSubmission", cardId: cid(9999), pitch: "fine", expectedVersion: 5 }, as(2))).toStrictEqual({ code: "NOT_IN_HAND" });
    expect(rejected(pitching("on", false), { type: "confirmSubmission", cardId: cid(200), pitch: "zorblat", expectedVersion: 5 }, as(2))).toStrictEqual(CONTENT("PROFANITY"));
    expect(rejected(pitching("on", false), { type: "confirmSubmission", cardId: cid(200), pitch: "fine", expectedVersion: 5 }, as(2))).toStrictEqual({ code: "VARIANT_UNAVAILABLE" });
  });
});

describe("V5 the pitch (7.1, 5.4)", () => {
  const confirm = (pitch: unknown, extra: object = {}) => ({ type: "confirmSubmission", cardId: cid(200), expectedVersion: 5, ...(pitch === undefined ? {} : { pitch }), ...extra });

  test("a blank or absent pitch is no pitch: accepted with the variant on or off, stored with no pitch key", () => {
    for (const on of [true, false]) {
      for (const p of [undefined, "", "   ", "\n\t "]) {
        const s = accepted(pitching("on", on), confirm(p), as(2)).state.round?.submissions[0];
        expect(s).toStrictEqual({ playerId: pid(2), cardId: cid(200) });
      }
    }
  });

  test("an over-long pitch is CONTENT_REJECTED TOO_LONG at guard 8 (140 code points after cleaning), with the variant on or off", () => {
    for (const on of [true, false]) {
      expect(rejected(pitching("on", on), confirm("x".repeat(141)), as(2))).toStrictEqual(CONTENT("TOO_LONG"));
      expect(rejected(pitching("on", on), confirm("\u{1F600}".repeat(141)), as(2))).toStrictEqual(CONTENT("TOO_LONG"));
    }
    expect(accepted(pitching("on"), confirm(`  ${"\u{1F600}".repeat(140)}  `), as(2)).state.round?.submissions[0]?.pitch).toBe("\u{1F600}".repeat(140));
  });

  test("guard 7 keeps the shape only: a pitch that is not a string is INVALID_ARGUMENT", () => {
    for (const bad of [5, null, {}, ["p"], true]) expect(rejected(pitching("on"), confirm(bad), as(2))).toStrictEqual({ code: "INVALID_ARGUMENT" });
  });

  test("the stored pitch is the cleaned form, and a profane pitch passes with the filter off", () => {
    expect(accepted(pitching("on"), confirm("  smooth \n  operator "), as(2)).state.round?.submissions[0]?.pitch).toBe("smooth operator");
    expect(accepted(pitching("off"), confirm("zorblat"), as(2)).state.round?.submissions[0]?.pitch).toBe("zorblat");
    expect(rejected(pitching("on"), confirm("zorblat"), as(2))).toStrictEqual(CONTENT("PROFANITY"));
  });
});

describe("V6 saveDraft: every text, every call, the cleaned form is stored", () => {
  const withSaved = (mode: "on" | "off"): Game =>
    writing(mode, { players: [0, 1, 2].map((i) => makePlayer(i, { writeTarget: { red: 2, green: 2 }, ...(i === 1 ? { writeProgress: { red: 1, green: 1 } } : {}) })) });

  test("a text-only rewrite (counts unchanged, which would not change the aggregate) is moderated too", () => {
    const g = withSaved("on");
    expect(rejected(g, { type: "saveDraft", red: ["zorblat"], green: ["fine"] }, as(1))).toStrictEqual(CONTENT("PROFANITY"));
    const ok = accepted(g, { type: "saveDraft", red: ["rewritten"], green: ["fine"] }, as(1));
    expect(ok.aggregateChanged).toBe(false);
  });

  test("a blank text is CONTENT_REJECTED EMPTY, in both modes", () => {
    for (const mode of ["on", "off"] as const) for (const blank of ["", "  ", "\n"]) {
      expect(rejected(writing(mode), { type: "saveDraft", red: [blank], green: [] }, as(1))).toStrictEqual(CONTENT("EMPTY"));
      expect(rejected(writing(mode), { type: "saveDraft", red: ["a"], green: ["b", blank] }, as(1))).toStrictEqual(CONTENT("EMPTY"));
    }
  });

  test("the draft change holds the cleaned texts, in order, and the aggregate mirrors counts only", () => {
    const v = accepted(writing("on"), { type: "saveDraft", red: ["  one   two ", "café"], green: ["\tthree\n"] }, as(1));
    expect(v.draftChanges).toEqual([{ playerId: pid(1), draft: { red: ["one two", "café"], green: ["three"] } satisfies Draft }]);
    expect(JSON.stringify(v.state)).not.toContain("one two");
  });

  test("an empty draft (no texts) is fine: nothing to moderate", () => {
    expect(accepted(withSaved("on"), { type: "saveDraft", red: [], green: [] }, as(1)).draftChanges[0]?.draft).toEqual({ red: [], green: [] });
  });

  test("a late joiner's saveDraft in PLAYING is moderated like any other", () => {
    const g = roundGame({ extra: { settings: settingsWith("on") } });
    const late = { ...g, players: [...g.players, makePlayer(4, { status: "writing", writeTarget: { red: 1, green: 8 } })] };
    expect(rejected(late, { type: "saveDraft", red: ["zorblat"], green: [] }, as(4))).toStrictEqual(CONTENT("PROFANITY"));
    expect(accepted(late, { type: "saveDraft", red: ["fine"], green: [] }, as(4)).draftChanges[0]?.draft?.red).toEqual(["fine"]);
  });
});

describe("V7 NAME_TAKEN compares the Moderation fold (12)", () => {
  const g = makeGame({ totalJoins: 2, players: [makePlayer(0, { name: "The Host" }), makePlayer(1, { name: "Ann Marie" }), makePlayer(2, { name: "Zoë" })] });
  const join = (name: string) => rejected(g, { type: "join", playerId: pid(5), name }, as(5));

  test("case, whitespace, diacritics, full-width, confusables and leet characters all collide", () => {
    for (const name of ["the host", "THEHOST", "  t h e   h o s t ", "Thé Host", "ＴＨＥ ＨＯＳＴ", "ТНЕ НОЅТ", "Th3 H0st", "ann\tmarie", "AnnMarie", "Zoe", "ZOE"]) {
      expect([name, join(name)]).toEqual([name, { code: "NAME_TAKEN" }]);
    }
  });

  test("a different name is free, and so is a digit that is not next to a letter", () => {
    for (const name of ["Ann Maria", "The Hosts", "Zoey", "Host 2", "Ann Marie 2"]) expect([name, run(g, { type: "join", playerId: pid(5), name }, as(5)).ok]).toEqual([name, true]);
  });

  test("the stored name is the cleaned one, and the host's name counts", () => {
    expect(accepted(g, { type: "join", playerId: pid(5), name: "  Ann   Maria " }, as(5)).state.players.at(-1)?.name).toBe("Ann Maria");
    expect(accepted(null, { type: "createGame", gameId: GAME_ID, roomCode: "BCDF", hostId: HOST_UID, hostPlayerId: pid(0), hostName: "  Host   Name " }, as(0)).state.players[0]?.name).toBe("Host Name");
  });

  test("the key runs the leet fold on the whitespace-stripped name, so a digit for a letter collides (impersonation protection, pinned): Team A / Team 4, Ann3 / Anne, Player I / Player 1, Bobo / Bob0", () => {
    for (const [have, want] of [["Team A", "Team 4"], ["Ann3", "Anne"], ["Player I", "Player 1"], ["Bobo", "Bob0"]] as const) {
      const h = makeGame({ totalJoins: 1, players: [makePlayer(0, { name: have }), makePlayer(1)] });
      expect([have, want, rejected(h, { type: "join", playerId: pid(5), name: want }, as(5))]).toEqual([have, want, { code: "NAME_TAKEN" }]);
    }
  });

  test("a departed seat's name is free; a seated one is not", () => {
    const gone = { ...g, players: g.players.map((p, i) => (i === 1 ? { ...p, status: "left" as const } : p)) };
    expect(run(gone, { type: "join", playerId: pid(5), name: "ann marie" }, as(5)).ok).toBe(true);
  });
});

describe("V8 M2: updateSettings{profanity} never rewrites a card; later writes follow the mode", () => {
  test("P-M2: over generated games, a profanity change leaves cards deep-equal (and so every zone)", () => {
    assertProperty(fc.property(arbShape.filter((s) => s.phase !== "FINISHED"), fc.constantFrom("on", "off"), (shape, mode) => {
      const g = buildGame(shape);
      const r = run(g, { type: "updateSettings", patch: { profanity: mode } }, ctxFor({ actor: userActor(g.hostId) }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.state.cards).toStrictEqual(g.cards);
        expect(r.value.state.settings.profanity).toBe(mode);
      }
    }), env());
  });

  test("a mid-game switch: saveDraft follows the new mode, and finishWriting stores what was saved without moderating again", () => {
    let g = writing("on", { players: [0, 1, 2].map((i) => makePlayer(i, { writeTarget: { red: 1, green: 0 } })) });
    expect(rejected(g, { type: "saveDraft", red: ["zorblat"], green: [] }, as(1))).toStrictEqual(CONTENT("PROFANITY"));
    g = accepted(g, { type: "updateSettings", patch: { profanity: "off" } }, as(0)).state;
    const saved = accepted(g, { type: "saveDraft", red: ["zorblat"], green: [] }, as(1));
    g = saved.state;
    expect(saved.draftChanges[0]?.draft?.red).toEqual(["zorblat"]);
    g = accepted(g, { type: "updateSettings", patch: { profanity: "on" } }, as(0)).state; // back on: the saved draft is not re-checked
    const done = accepted(g, { type: "finishWriting" }, as(1, { drafts: { [pid(1)]: { red: ["zorblat"], green: [] } } }));
    expect(Object.values(done.state.cards).map((c) => c.text)).toEqual(["zorblat"]);
    expect(rejected(g, { type: "saveDraft", red: ["zorblat again"], green: [] }, as(2))).toStrictEqual(CONTENT("PROFANITY")); // and the next write is checked under the mode now in force
  });

  test("the pitch follows the mode in force at the time of the command", () => {
    let g = pitching("on");
    const c = { type: "confirmSubmission", cardId: cid(200), pitch: "zorblat", expectedVersion: 5 };
    expect(rejected(g, c, as(2))).toStrictEqual(CONTENT("PROFANITY"));
    g = accepted(g, { type: "updateSettings", patch: { profanity: "off" } }, as(0)).state;
    expect(accepted(g, c, as(2)).state.round?.submissions[0]?.pitch).toBe("zorblat");
  });
});
