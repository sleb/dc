// #30 (LLD 2 11.4): leaky projectors, each a few lines around the real one, that the anonymity suite must kill. Test code only: nothing here is exported from the Engine. Every mutant records the fixed
// seed and run count it is killed at (so detection is not probabilistic across CI runs) and the detectors that must kill it ALONE (mutants.test.ts K1). Where the LLD's mutant adds a key, the strict schema
// parse would kill it by itself and prove nothing about the other detectors; those are run with the parse off, and M-order, M-time, M-shape and M-keyorder are shape-valid on purpose.
// Views share arrays and objects with the real projector's base: a mutant builds new objects and never writes into one.
import type { GameView, RoundDoc } from "@dc/contracts";
import { toRoundDoc } from "../../src/project";
import type { Game, GameDrafts, Player } from "../../src/types";
import { REAL } from "./anonymity";
import type { Detector, ProjectorUnderTest } from "./anonymity";
import { reverseKeys } from "./keyorder";

export interface Mutant { impl: ProjectorUnderTest; seed: number; numRuns: number; killedBy: Detector[] }
type Live = Extract<GameView, { kind: "live" }>;

const SEED = 20_260_131;
const RUNS = 30;

const wrapView = (f: (view: Live, g: Game, drafts: GameDrafts) => GameView): ProjectorUnderTest => ({
  ...REAL,
  project: (g, v, d) => { const view = REAL.project(g, v, d); return view.kind === "live" ? f(view, g, d) : view; },
});
const player = (g: Game, id: string): Player | undefined => g.players.find((p) => p.id === id);
const ownerOf = (g: Game, cardId: string): string | undefined => g.round?.submissions.find((s) => s.cardId === cardId)?.playerId;
const withReveal = (view: Live, reveal: NonNullable<Live["round"]>["reveal"]): GameView => (view.round === null ? view : { ...view, round: { ...view.round, reveal } });

export const MUTANTS: Record<string, Mutant> = {
  // other players' hand and pile in players[]
  "M-hands": { seed: SEED, numRuns: RUNS, killedBy: ["cards", "internals", "othersData"], impl: wrapView((view, g) => ({ ...view, players: view.players.map((p) => ({ ...p, hand: [...(player(g, p.id)?.hand ?? [])], scorePile: [...(player(g, p.id)?.scorePile ?? [])] })) }) as unknown as GameView) },
  // the owner beside each revealed card
  "M-owner": { seed: SEED, numRuns: RUNS, killedBy: ["ownership"], impl: wrapView((view, g) => withReveal(view, view.round?.reveal?.map((c) => ({ ...c, owner: ownerOf(g, c.submissionId) })) as never ?? null)) },
  // reveal in submission order (shape-valid)
  "M-order": { seed: SEED, numRuns: RUNS, killedBy: ["order", "N2"], impl: wrapView((view, g) => {
    const at = (id: string): number => g.round?.submissions.findIndex((s) => s.cardId === id) ?? -1;
    return withReveal(view, view.round?.reveal === null || view.round?.reveal === undefined ? null : [...view.round.reveal].sort((a, b) => at(a.submissionId) - at(b.submissionId)));
  }) },
  // submittedBy in the order the cards were played (shape-valid)
  "M-time": { seed: SEED, numRuns: RUNS, killedBy: ["time", "N2"], impl: wrapView((view, g) => (view.round === null || g.round === null ? view : { ...view, round: { ...view.round, submittedBy: g.round.submissions.map((s) => s.playerId) } })) },
  // every player's powerUsage in players[]
  "M-power": { seed: SEED, numRuns: RUNS, killedBy: ["othersData", "N3"], impl: wrapView((view, g) => ({ ...view, players: view.players.map((p) => ({ ...p, powerUsage: player(g, p.id)?.powerUsage })) }) as GameView) },
  // a write-in marker on the reveal entry and on the matching RoundDoc play (on states the injector decorated)
  "M-writein": { seed: SEED, numRuns: RUNS, killedBy: ["writeInMarker", "N6"], impl: {
    ...wrapView((view, g) => withReveal(view, view.round?.reveal?.map((c) => (g.round?.submissions.find((s) => s.cardId === c.submissionId)?.writeIn === true ? { ...c, writeIn: true } : c)) as never ?? null)),
    toRoundDoc: (rec, before) => {
      const doc = toRoundDoc(rec);
      return { ...doc, plays: doc.plays.map((p) => (before.round?.submissions.find((s) => s.cardId === p.cardId)?.writeIn === true ? { ...p, writeIn: true } : p)) } as RoundDoc;
    },
  } },
  // other players' draft texts in players[].cardsLeft
  "M-draft": { seed: SEED, numRuns: RUNS, killedBy: ["drafts"], impl: ((): ProjectorUnderTest => ({
    ...REAL,
    project: (g, v, d) => {
      const view = REAL.project(g, v, d);
      if (view.kind !== "live") return view;
      return { ...view, players: view.players.map((p) => { const dr = d[p.id]; return dr === undefined ? p : { ...p, cardsLeft: { red: p.cardsLeft?.red ?? 0, green: p.cardsLeft?.green ?? 0, draft: [...dr.red, ...dr.green] } }; }) } as GameView;
    },
  }))() },
  // uid and hostId
  "M-uid": { seed: SEED, numRuns: RUNS, killedBy: ["identity"], impl: wrapView((view, g) => ({ ...view, hostId: g.hostId, players: view.players.map((p) => ({ ...p, uid: player(g, p.id)?.uid })) }) as unknown as GameView) },
  // a `you` block in the spectator view
  "M-spec": { seed: SEED, numRuns: RUNS, killedBy: ["subset"], impl: ((): ProjectorUnderTest => ({
    ...REAL,
    project: (g, v, d) => {
      const view = REAL.project(g, v, d);
      if (view.kind !== "live" || view.audience !== "spectator") return view;
      const first = g.players.find((p) => p.status === "active" || p.status === "writing" || p.status === "ready");
      if (first === undefined) return view;
      const mine = REAL.project(g, { kind: "player", uid: first.uid, playerId: first.id, isHost: first.uid === g.hostId }, d);
      return mine.kind === "live" && mine.audience === "player" ? ({ ...view, you: mine.you } as unknown as GameView) : view;
    },
  }))() },
  // pool sizes and the top card of the red deck
  "M-deck": { seed: SEED, numRuns: RUNS, killedBy: ["cards"], impl: wrapView((view, g) => ({ ...view, pools: { redDeck: g.pools.redDeck.length, redDiscard: g.pools.redDiscard.length, greenDeck: g.pools.greenDeck.length, greenDiscard: g.pools.greenDiscard.length, top: g.pools.redDeck[0] ?? g.pools.redDiscard[0] ?? g.pools.greenDeck[0] } }) as unknown as GameView) },
  // a round doc, with the owners, written while the round is still in JUDGING
  "M-resolve": { seed: SEED, numRuns: RUNS, killedBy: ["roundDocs"], impl: {
    ...REAL,
    roundDocs: (prev, next, recs) => {
      const real = recs.map((r) => REAL.toRoundDoc(r, prev));
      const r = next.round;
      if (r === null || r.phase !== "JUDGING" || prev.round?.phase === "JUDGING" || r.judgeId === null) return real;
      const first = r.submissions[0];
      if (first === undefined) return real;
      const early: RoundDoc = {
        schema: real[0]?.schema ?? toRoundDoc({ round: 1, judgeId: r.judgeId, greenCardId: r.greenCardId, plays: [], winnerCardId: first.cardId, winnerId: first.playerId, green: { id: r.greenCardId, text: "" }, playsDetail: [], absent: [], resolvedAt: 0 }).schema,
        round: r.number, judgeId: r.judgeId, winnerId: first.playerId, winnerCardId: first.cardId, green: { id: r.greenCardId, text: next.cards[r.greenCardId]?.text ?? null },
        plays: r.submissions.map((s) => ({ playerId: s.playerId, cardId: s.cardId, text: next.cards[s.cardId]?.text ?? null, pitch: s.pitch ?? null })),
        absent: [], resolvedAt: 0, redacted: false,
      };
      return [...real, early];
    },
  } },
  // who voted for what, in the finished game's views (the tallies are public, the voters are not)
  "M-votes": { seed: SEED, numRuns: RUNS, killedBy: ["internals", "identity", "N5"], impl: wrapView((view, g) => (g.phase === "FINISHED" || g.phase === "ENDED" ? ({ ...view, votes: g.votes.map((x) => ({ round: x.round, voter: x.voter, cardId: x.cardId })) } as unknown as GameView) : view)) },
  // keys in reverse order everywhere (shape-valid; the only way to see it is the key-order check)
  "M-keyorder": { seed: SEED, numRuns: RUNS, killedBy: ["keyOrder"], impl: {
    ...REAL,
    project: (g, v, d) => reverseKeys(REAL.project(g, v, d)),
    toRoundDoc: (rec, before) => reverseKeys(REAL.toRoundDoc(rec, before)),
  } },
  // reveal ordered by the owner's join order (shape-valid, and a plausible way to "sort for display")
  "M-shape": { seed: SEED, numRuns: RUNS, killedBy: ["order", "N2"], impl: wrapView((view, g) => {
    const rank = (id: string): number => player(g, ownerOf(g, id) ?? "")?.joinOrder ?? 0;
    return withReveal(view, view.round?.reveal === null || view.round?.reveal === undefined ? null : [...view.round.reveal].sort((a, b) => rank(a.submissionId) - rank(b.submissionId)));
  }) },
};
