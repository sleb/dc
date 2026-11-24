// #30 N1 to N8: the non-interference test (LLD 2 11.3). A view is a function of only what its viewer may know: apply a transformation the viewer cannot observe and the bytes must not move.
// Each transformation is a pure `(game, drafts, viewer) => (game', drafts') | null` (null: not applicable here). `nonInterference` compares the viewer's view before and after and, on a
// difference, returns the transformation's name and the first JSON path that moved (N8).
import type { Command, GameView } from "@dc/contracts";
import { decide } from "../../src/decide";
import type { Game, GameDrafts, RoundRecord, Submission } from "../../src/types";
import { ctxFor } from "../support/factories";
import { allowedFor } from "./oracle";
import type { OracleViewer } from "./oracle";

export type NName = "N1" | "N2" | "N3" | "N4" | "N5" | "N6";
export interface Applied { game: Game; drafts: GameDrafts }
export interface Transformation { id: NName; name: string; apply(g: Game, d: GameDrafts, v: OracleViewer): Applied | null }
export interface NIResult { id: NName; name: string; path: string }

const own = (v: OracleViewer): string | null => (v.kind === "player" ? v.playerId : null);
/** A shallow copy: the transformations replace whole fields of the copy and never write into a shared one (a deep copy of every state at every step would cost more than the checks). */
const clone = <T>(x: T): T => (Array.isArray(x) ? [...x] : x !== null && typeof x === "object" ? { ...x } : x) as T;

/** The first JSON path at which two values differ (`round.reveal[0].submissionId`), or null when equal. */
export function firstDiff(a: unknown, b: unknown, path = ""): string | null {
  if (a === b) return null;
  const here = path === "" ? "(root)" : path;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = firstDiff(a[i], b[i], `${path}[${i}]`); if (d !== null) return d; }
    return null;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) { const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path === "" ? k : `${path}.${k}`); if (d !== null) return d; }
    return null;
  }
  return Object.is(a, b) ? null : here;
}

/** Rename card ids across every zone, the registry, the open round, the history and the votes; `retext` is applied to the text of every card whose id is a key of `ids` (an id mapped to itself is re-texted only). */
export function renameCards(g: Game, ids: ReadonlyMap<string, string>, retext: (old: string) => string): Game {
  const r = (id: string): string => ids.get(id) ?? id;
  return {
    ...g,
    cards: Object.fromEntries(Object.entries(g.cards).map(([id, c]) => [r(id), ids.has(id) ? { kind: c.kind, text: retext(c.text) } : c])),
    pools: { redDeck: g.pools.redDeck.map(r), redDiscard: g.pools.redDiscard.map(r), greenDeck: g.pools.greenDeck.map(r), greenDiscard: g.pools.greenDiscard.map(r) },
    players: g.players.map((p) => ({ ...p, hand: p.hand.map(r), scorePile: p.scorePile.map(r) })),
    round: g.round === null ? null : { ...g.round, greenCardId: r(g.round.greenCardId), submissions: g.round.submissions.map((s) => ({ ...s, cardId: r(s.cardId) })), revealOrder: g.round.revealOrder === null ? null : g.round.revealOrder.map(r) },
    history: g.history.map((h) => ({ ...h, greenCardId: r(h.greenCardId), winnerCardId: r(h.winnerCardId), plays: h.plays.map((p) => ({ playerId: p.playerId, cardId: r(p.cardId) })) })),
    votes: g.votes.map((v) => ({ ...v, cardId: r(v.cardId) })),
  };
}

const N1: Transformation = {
  id: "N1", name: "N1 re-mint ids and texts of every card outside allowed(t)",
  apply(g, d, v) {
    const a = allowedFor(g, d, v);
    const ids = new Map<string, string>();
    let n = 0;
    for (const id of Object.keys(g.cards)) {
      if (a.ids.has(id)) continue;
      ids.set(id, a.idOnly.has(id) ? id : `c_zz${(n++).toString(36).padStart(8, "0")}`);
    }
    if (ids.size === 0) return null;
    let k = 0;
    return { game: renameCards(g, ids, () => `Z${String(k++).padStart(5, "0")}x`), drafts: d };
  },
};

const others = (g: Game, v: OracleViewer): Submission[] => (g.round?.submissions ?? []).filter((s) => s.playerId !== own(v));
const swapped = (g: Game, v: OracleViewer, f: (a: Submission, b: Submission) => [Submission, Submission]): Game | null => {
  const eligible = others(g, v);
  if (g.round === null || eligible.length < 2) return null;
  const a = eligible[0] as Submission;
  const b = eligible[eligible.length - 1] as Submission;
  const [na, nb] = f(a, b);
  const out = clone(g);
  out.round = { ...clone(g.round), submissions: g.round.submissions.map((s) => (s === a ? na : s === b ? nb : s)) };
  return out;
};
const core = (s: Submission): Omit<Submission, "playerId"> => { const { playerId: _p, ...rest } = s; return clone(rest); };

const N2a: Transformation = { id: "N2", name: "N2a swap the cards (id, pitch, marker) of two other submissions", apply: (g, d, v) => { const o = swapped(g, v, (a, b) => [{ playerId: a.playerId, ...core(b) }, { playerId: b.playerId, ...core(a) }]); return o === null ? null : { game: o, drafts: d }; } };
const N2b: Transformation = { id: "N2", name: "N2b swap the owners of two other submissions", apply: (g, d, v) => { const o = swapped(g, v, (a, b) => [{ ...clone(a), playerId: b.playerId }, { ...clone(b), playerId: a.playerId }]); return o === null ? null : { game: o, drafts: d }; } };
const N2c: Transformation = { id: "N2", name: "N2c swap the positions (time order) of two other submissions", apply: (g, d, v) => { const o = swapped(g, v, (a, b) => [clone(b), clone(a)]); return o === null ? null : { game: o, drafts: d }; } };

const N3: Transformation = {
  id: "N3", name: "N3 replace others' drafts, uids and powerUsage; reorder the four pools",
  apply(g, d, v) {
    const out = clone(g);
    const keepUid = new Set([g.hostId, ...(v.uid === null ? [] : [v.uid])]);
    out.players = g.players.map((p, i) => {
      if (p.id === own(v)) return clone(p);
      return { ...clone(p), uid: keepUid.has(p.uid) ? p.uid : `rewritten-${i}-${p.uid.length}`, powerUsage: { writeIn: !p.powerUsage.writeIn, redraw: !p.powerUsage.redraw } };
    });
    out.pools = { redDeck: [...g.pools.redDeck].reverse(), redDiscard: [...g.pools.redDiscard].reverse(), greenDeck: [...g.pools.greenDeck].reverse(), greenDiscard: [...g.pools.greenDiscard].reverse() };
    let k = 0;
    const nd: Record<string, { red: string[]; green: string[] }> = {};
    for (const [pid, draft] of Object.entries(d)) nd[pid] = pid === own(v) ? clone(draft) : { red: draft.red.map(() => `D${String(k++).padStart(5, "0")}x`), green: draft.green.map(() => `D${String(k++).padStart(5, "0")}x`) };
    return { game: out, drafts: nd };
  },
};

const N4: Transformation = {
  id: "N4", name: "N4 change createdAt, openedAt, waitingSince, reminderDueAt, episode, episodeGen, changedAtVersion, totalJoins (never hostId)",
  apply(g, d) {
    const out = clone(g);
    out.createdAt = g.createdAt + 13_579;
    out.waitingSince = g.waitingSince === null ? null : g.waitingSince + 777;
    out.reminderDueAt = g.reminderDueAt === null ? null : g.reminderDueAt + 777;
    out.episode = g.episode === null ? null : `${g.episode}#changed`;
    out.episodeGen = g.episodeGen + 5;
    out.totalJoins = g.totalJoins + 3;
    if (g.round !== null) out.round = { ...clone(g.round), openedAt: g.round.openedAt + 999, changedAtVersion: g.round.changedAtVersion + 17 };
    return { game: out, drafts: d };
  },
};

const N5: Transformation = {
  id: "N5", name: "N5 change other players' and spectators' votes while the game is not FINISHED or ENDED",
  apply(g, d, v) {
    if (g.phase === "FINISHED" || g.phase === "ENDED") return null;
    const out = clone(g);
    const play = g.history.flatMap((h) => h.plays.map((p) => ({ round: h.round, cardId: p.cardId })));
    const mine = own(v) === null ? null : `p:${own(v)}`;
    out.votes = g.votes.map((x, i) => (x.voter === mine ? x : { ...x, cardId: play[(i + 1) % Math.max(1, play.length)]?.cardId ?? "c_zzzzzzzzzz" }));
    out.votes.push({ round: play[0]?.round ?? 1, voter: "s:ni-extra", cardId: play[0]?.cardId ?? "c_zzzzzzzzzz" });
    return { game: out, drafts: d };
  },
};

const N6: Transformation = {
  id: "N6", name: "N6 turn a write-in submission not owned by t into a hand-card one, and the reverse",
  apply(g, d, v) {
    const eligible = others(g, v);
    if (g.round === null || eligible.length === 0) return null;
    const out = clone(g);
    const flip = new Map(eligible.map((s) => [s.playerId, s.writeIn !== true]));
    out.round = { ...clone(g.round), submissions: g.round.submissions.map((s) => {
      if (!flip.has(s.playerId)) return clone(s);
      const { writeIn: _w, ...rest } = clone(s);
      return flip.get(s.playerId) === true ? { ...rest, writeIn: true as const } : rest;
    }) };
    out.players = g.players.map((p) => (flip.has(p.id) ? { ...clone(p), powerUsage: { ...p.powerUsage, writeIn: flip.get(p.id) === true } } : clone(p)));
    return { game: out, drafts: d };
  },
};

export const TRANSFORMATIONS: readonly Transformation[] = [N1, N2a, N2b, N2c, N3, N4, N5, N6];

/** N7: transformations the viewer CAN observe. If a "non-interference" check passed only because the projector ignored everything, these would pass too; they must move the view. */
export const SENSITIVITY: readonly { name: string; apply(g: Game, d: GameDrafts, v: OracleViewer): Applied | null }[] = [
  { name: "own hand text", apply: (g, d, v) => { const me = g.players.find((p) => p.id === own(v)); const id = me?.hand[0]; if (id === undefined) return null; const out = clone(g); out.cards = { ...g.cards, [id]: { kind: "red", text: `${g.cards[id]?.text ?? ""}!` } }; return { game: out, drafts: d }; } },
  { name: "green text", apply: (g, d) => { if (g.round === null) return null; const id = g.round.greenCardId; const out = clone(g); out.cards = { ...g.cards, [id]: { kind: "green", text: `${g.cards[id]?.text ?? ""}!` } }; return { game: out, drafts: d }; } },
  { name: "reveal order", apply: (g, d) => { if (g.round === null || g.round.revealOrder === null || g.round.revealOrder.length < 2) return null; const out = clone(g); out.round = { ...clone(g.round), revealOrder: [...(g.round.revealOrder ?? [])].reverse() }; return { game: out, drafts: d }; } },
  { name: "own powerUsage", apply: (g, d, v) => { const me = g.players.find((p) => p.id === own(v)); if (me === undefined) return null; const out = clone(g); out.players = g.players.map((p) => (p.id === me.id ? { ...clone(p), powerUsage: { ...p.powerUsage, writeIn: !p.powerUsage.writeIn } } : clone(p))); return { game: out, drafts: d }; } },
];

/** The view of `viewer` before and after each transformation in `ids`; the first that moved it, or null. `onApplied` is told of each transformation that applied (the suite's coverage counters). */
export function nonInterference(impl: { project(g: Game, v: never, d: GameDrafts): GameView }, g: Game, d: GameDrafts, viewer: OracleViewer, ids: ReadonlySet<NName>, onApplied?: (id: NName) => void): NIResult | null {
  if (viewer.kind === "departed") return null;
  const project = impl.project as (g: Game, v: OracleViewer, d: GameDrafts) => GameView;
  let base: string | null = null;
  for (const t of TRANSFORMATIONS) {
    if (!ids.has(t.id)) continue;
    const out = t.apply(g, d, viewer);
    if (out === null) continue;
    onApplied?.(t.id);
    base ??= JSON.stringify(project(g, viewer, d));
    let after: string;
    try { after = JSON.stringify(project(out.game, viewer, out.drafts)); } catch (e) { return { id: t.id, name: t.name, path: `threw ${e instanceof Error ? e.message.slice(0, 80) : String(e)}` }; }
    if (after !== base) return { id: t.id, name: t.name, path: firstDiff(JSON.parse(base), JSON.parse(after)) ?? "(root)" };
  }
  return null;
}

/** What a real command produces from `g` through the projector under test: the round docs and the records behind them. Null when the command is rejected. */
export function resolveWith<D>(impl: { toRoundDoc(rec: RoundRecord, before: Game): D }, g: Game, cmd: Command, uid: string): { docs: D[]; records: RoundRecord[] } | null {
  const r = decide(g, cmd, ctxFor({ actor: { kind: "user", uid } }));
  return r.ok ? { docs: r.value.roundRecords.map((rec) => impl.toRoundDoc(rec, g)), records: r.value.roundRecords } : null;
}

/** N6 on RoundDocs: the docs a real `pickWinner` produces from `a` and from `b` (the same state with write-in markers toggled). Null when the command is rejected in either. */
export function roundDocsAcrossToggle<D>(impl: { toRoundDoc(rec: RoundRecord, before: Game): D }, a: Game, b: Game, cmd: Command, uid: string): { a: D[]; b: D[] } | null {
  const ra = resolveWith(impl, a, cmd, uid);
  const rb = resolveWith(impl, b, cmd, uid);
  return ra === null || rb === null ? null : { a: ra.docs, b: rb.docs };
}
