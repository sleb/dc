// #30: the forbidden-values oracle of LLD 2 11.2. A second, independent implementation, written from gameplay.md and the table of 11.2, not from `project`: it imports no selector, no rule and
// nothing from src/project (oracle.test.ts O4 reads this file's imports). It answers two questions about one stored doc: what may this viewer see (`allowedFor`), and does the doc hold anything else
// (`checkDoc`). A finding names the detector that raised it, so the mutation matrix can switch detectors off one at a time.
import { RoundDocSchema, ViewDocSchema } from "@dc/contracts";
import type { RoundDoc } from "@dc/contracts";
import type { Game, GameDrafts, RoundRecord } from "../../src/types";

export type Detector = "cards" | "drafts" | "ownership" | "identity" | "internals" | "strictParse" | "othersData" | "writeInMarker";
export interface Finding { detector: Detector; path: string; detail: string }

/** The viewer as the oracle sees it: structural, so the real `Viewer` of src/project fits without being imported. */
export type OracleViewer =
  | { kind: "player"; uid: string; playerId: string; isHost: boolean }
  | { kind: "spectator"; uid: string | null; isHost: boolean }
  | { kind: "departed"; uid: string; playerId: string; reason: string };

export interface Allowed {
  /** Card ids (with their texts) the viewer may see. */
  ids: Set<string>;
  /** The texts of those cards, and the viewer's own draft texts. */
  texts: Set<string>;
  /** Ids that may appear without their texts: the podium, and the cards the viewer voted for. */
  idOnly: Set<string>;
  /** Pitches the viewer may see: their own, and the reveal list's. */
  pitches: Set<string>;
}
export interface Forbidden { ids: Set<string>; texts: Set<string>; pitches: Set<string>; draftTexts: Set<string> }

/** Key names that never appear in any doc (PJ7, PJ3 and the aggregate's own fields), anywhere in the tree. */
export const INTERNAL_KEYS = ["uid", "hostId", "seed", "episode", "episodeGen", "waitingSince", "reminderDueAt", "changedAtVersion", "openedAt", "createdAt", "totalJoins", "submissions", "revealOrder", "pools", "cards", "scorePile", "roster", "judgeReassigned", "played", "judgeCursor", "writeProgress", "redDeck", "redDiscard", "greenDeck", "greenDiscard"] as const;
/** Keys that belong to a player's own `you` block, or to their own draft region, and nowhere else. */
const OWN_KEYS = ["powerUsage", "myVotes", "hand", "writeTarget"] as const;
const MARKER_KEYS = ["variant", "writeIn", "isWriteIn", "writtenIn"] as const;
const WHITELIST_MARKER_PATHS = new Set(["view.settings.variants.writeIn", "view.you.powerUsage.writeIn"]);
const REVEAL_ID_PATH = /^view\.round\.reveal\[\d+\]\.submissionId$/;
const OWN_PLAY_PATH = "view.you.yourSubmission.cardId";
/** A card that was played, resolved and voted for can be dealt and played again; the voter's own `myVotes` entry names it by id, which tells them nothing about the new play (checked against their own votes). */
const OWN_VOTE_PATH = /^view\.you\.myVotes\.[1-9][0-9]*$/;

const text = (g: Game, id: string): string | undefined => (Object.hasOwn(g.cards, id) ? g.cards[id]?.text : undefined);

/** The podium's card ids, recomputed from the votes and the history: most votes, then the earlier round, then play order; at least one vote; three at most (gameplay.md, People's Choice). */
function podiumIds(g: Game): string[] {
  if ((g.phase !== "FINISHED" && g.phase !== "ENDED") || !g.settings.variants.peoplesChoice) return [];
  const plays: { id: string; round: number; votes: number }[] = [];
  for (const h of g.history) for (const p of h.plays) plays.push({ id: p.cardId, round: h.round, votes: g.votes.filter((v) => v.round === h.round && v.cardId === p.cardId).length });
  return plays.map((p, at) => ({ ...p, at })).filter((p) => p.votes > 0).sort((a, b) => b.votes - a.votes || a.round - b.round || a.at - b.at).slice(0, 3).map((p) => p.id);
}

/** What `viewer` may see of the cards (the 11.2 table): own hand, own submission, the current green card, the reveal list in JUDGING, podium ids and the ids of own votes (id only), own draft texts. Departed viewers see nothing. */
export function allowedFor(g: Game, drafts: GameDrafts, viewer: OracleViewer): Allowed {
  const a: Allowed = { ids: new Set(), texts: new Set(), idOnly: new Set(), pitches: new Set() };
  if (viewer.kind === "departed") return a;
  const r = g.round;
  if (viewer.kind === "player") {
    const me = g.players.find((p) => p.id === viewer.playerId);
    if (me !== undefined) {
      for (const id of me.hand) a.ids.add(id);
      const mine = r?.submissions.find((s) => s.playerId === me.id);
      if (mine !== undefined) { a.ids.add(mine.cardId); if (mine.pitch !== undefined) a.pitches.add(mine.pitch); }
      const d = drafts[me.id];
      if (d !== undefined) for (const t of [...d.red, ...d.green]) a.texts.add(t);
    }
  }
  if (r !== null) {
    a.ids.add(r.greenCardId);
    if (r.phase === "JUDGING") for (const id of r.revealOrder ?? []) { a.ids.add(id); const p = r.submissions.find((s) => s.cardId === id)?.pitch; if (p !== undefined) a.pitches.add(p); }
  }
  for (const id of podiumIds(g)) if (!a.ids.has(id)) a.idOnly.add(id);
  // a voter's own votes name resolved plays by card id (`you.myVotes`, PJ5): id only, never the text
  if (viewer.kind === "player") for (const v of g.votes) if (v.voter === `p:${viewer.playerId}` && !a.ids.has(v.cardId)) a.idOnly.add(v.cardId);
  for (const id of a.ids) { const t = text(g, id); if (t !== undefined) a.texts.add(t); }
  return a;
}

/** Everything the viewer must not find in their doc: registry cards outside the allowlist (ids and texts), pitches outside it, and other players' draft texts. A value the viewer may see is never forbidden. */
export function forbiddenFor(g: Game, drafts: GameDrafts, viewer: OracleViewer): Forbidden {
  const a = allowedFor(g, drafts, viewer);
  const f: Forbidden = { ids: new Set(), texts: new Set(), pitches: new Set(), draftTexts: new Set() };
  for (const [id, c] of Object.entries(g.cards)) {
    if (!a.ids.has(id) && !a.idOnly.has(id)) f.ids.add(id);
    if (!a.ids.has(id) && c.text !== "" && !a.texts.has(c.text)) f.texts.add(c.text);
  }
  for (const s of g.round?.submissions ?? []) if (s.pitch !== undefined && s.pitch !== "" && !a.pitches.has(s.pitch)) f.pitches.add(s.pitch);
  const own = viewer.kind === "player" ? viewer.playerId : null;
  for (const [pid, d] of Object.entries(drafts)) if (pid !== own) for (const t of [...d.red, ...d.green]) if (t !== "" && !a.texts.has(t)) f.draftTexts.add(t);
  return f;
}

/** Strings that identify a person or a secret: every uid, the host's, and the markers of a seat uid, a link key, a token. */
function identityStrings(g: Game, viewer: OracleViewer): string[] {
  const out = new Set<string>([g.hostId, ...g.players.map((p) => p.uid), "seat:", "#k=", "token", "secret"]);
  return [...out];
}

const esc = (s: string): string => JSON.stringify(s).slice(1, -1);
/** JSON with every object's keys sorted: equality of content, whatever the key order (the order is the key-order check's business, not the oracle's). */
export function canon(x: unknown): string {
  return JSON.stringify(x, (_k, v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}
const same = (a: unknown, b: unknown): boolean => canon(a) === canon(b);

interface Node { path: string; key: string | null; value: unknown; parent: unknown }
function walk(value: unknown, visit: (n: Node) => void, path = "", key: string | null = null, parent: unknown = null): void {
  visit({ path, key, value, parent });
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, visit, `${path}[${i}]`, String(i), value));
  else if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, visit, path === "" ? k : `${path}.${k}`, k, value);
}

/** The first path at which a string value contains `needle`, for the message. */
function where(doc: unknown, needle: string): string {
  let at = "(doc)";
  walk(doc, (n) => { if (at === "(doc)" && typeof n.value === "string" && n.value.includes(needle)) at = n.path; });
  return at;
}

const issues = (e: { issues: readonly { path: readonly PropertyKey[]; code: string }[] }): string => e.issues.slice(0, 3).map((i) => `${i.path.map(String).join(".") || "(root)"} (${i.code})`).join("; ");

function scanKeys(doc: unknown, out: Finding[], o: { internal: readonly string[]; own: readonly string[]; markers: boolean; whitelist: ReadonlySet<string>; ownAt: (path: string, key: string) => boolean }): void {
  walk(doc, (n) => {
    if (n.key === null || Array.isArray(n.parent)) return;
    if (o.internal.includes(n.key)) out.push({ detector: "internals", path: n.path, detail: `internal key ${n.key}` });
    if (o.own.includes(n.key) && !o.ownAt(n.path, n.key)) out.push({ detector: "othersData", path: n.path, detail: `own-only key ${n.key} off its path` });
    if (o.markers && (MARKER_KEYS as readonly string[]).includes(n.key) && !o.whitelist.has(n.path)) out.push({ detector: "writeInMarker", path: n.path, detail: `write-in marker key ${n.key}` });
  });
}

/**
 * How a forbidden string is looked for. `includes`: JSON substring search, for any text (the fixtures, the planted-leak tests). `tokens`: for runs whose card texts, pitches and draft texts are the sentinels of
 * inject.ts and whose card ids are `c_` plus 10 characters: every such token is extracted from the doc by regex (an occurrence embedded in a longer string is still found) and looked up in the forbidden set.
 * A forbidden value that is not token-shaped is still searched by `includes`, so the mode never weakens a check, it only avoids 500 substring scans per doc.
 */
export type ScanMode = "includes" | "tokens";
const TOKEN = /c_[0-9a-z]{10}|[RGPD][0-9]{4}x/g;
const TOKEN_SHAPE = /^(?:c_[0-9a-z]{10}|[RGPD][0-9]{4}x)$/;

function scanStrings(doc: unknown, json: string, needles: Iterable<string>, detector: Detector, label: string, out: Finding[], mode: ScanMode = "includes", found?: Set<string>): void {
  for (const s of needles) {
    if (s === "") continue;
    const hit = mode === "tokens" && TOKEN_SHAPE.test(s) ? found?.has(s) === true : json.includes(esc(s));
    if (hit) out.push({ detector, path: where(doc, s), detail: `${label} ${s.length > 24 ? `${s.slice(0, 24)}...` : s}` });
  }
}

/** Does any object hold a pending card id beside a player (a `playerId` key, or a value that is a player id)? */
function coOccurrence(doc: unknown, pending: ReadonlySet<string>, players: ReadonlySet<string>, out: Finding[]): void {
  walk(doc, (n) => {
    if (n.value === null || typeof n.value !== "object" || Array.isArray(n.value)) return;
    const vals = Object.values(n.value);
    if (vals.some((v) => typeof v === "string" && pending.has(v)) && (Object.hasOwn(n.value, "playerId") || vals.some((v) => typeof v === "string" && players.has(v)))) out.push({ detector: "ownership", path: n.path, detail: "an object holds a pending card id and a player" });
  });
}

/** What the viewer's own `you` block and draft region must say, from the aggregate. */
function ownValues(g: Game, drafts: GameDrafts, viewer: OracleViewer, doc: Record<string, unknown>, out: Finding[]): void {
  const view = (doc.view ?? null) as Record<string, unknown> | null;
  if (viewer.kind !== "player") {
    if (Object.hasOwn(doc, "draft") || Object.hasOwn(doc, "draftSeq")) out.push({ detector: "othersData", path: "draft", detail: "a draft region for a viewer with no seat" });
    return;
  }
  const me = g.players.find((p) => p.id === viewer.playerId);
  if (me === undefined) return;
  const own = drafts[me.id] ?? null;
  if (Object.hasOwn(doc, "draft") && !same(doc.draft, own)) out.push({ detector: "othersData", path: "draft", detail: "the draft region is not the viewer's own draft" });
  const you = (view?.you ?? null) as Record<string, unknown> | null;
  if (you === null) return;
  if (you.playerId !== me.id) out.push({ detector: "othersData", path: "view.you.playerId", detail: "a you block of another player" });
  if (Object.hasOwn(you, "powerUsage") && !same(you.powerUsage, me.powerUsage)) out.push({ detector: "othersData", path: "view.you.powerUsage", detail: "powerUsage is not the viewer's own" });
  const hand = Array.isArray(you.hand) ? (you.hand as { id: string }[]) : [];
  if (hand.some((c) => !me.hand.includes(c.id))) out.push({ detector: "othersData", path: "view.you.hand", detail: "a hand card that is not the viewer's own" });
  const wt = you.writeTarget ?? null;
  if (wt !== null && !same(wt, me.writeTarget)) out.push({ detector: "othersData", path: "view.you.writeTarget", detail: "writeTarget is not the viewer's own" });
  for (const [round, cardId] of Object.entries((you.myVotes ?? {}) as Record<string, string>)) if (!g.votes.some((v) => v.voter === `p:${me.id}` && String(v.round) === round && v.cardId === cardId)) out.push({ detector: "othersData", path: `view.you.myVotes.${round}`, detail: "a vote that is not the viewer's own" });
  const mine = g.round?.submissions.find((s) => s.playerId === me.id);
  const ys = (you.yourSubmission ?? null) as { cardId?: string } | null;
  if (ys !== null && ys.cardId !== mine?.cardId) out.push({ detector: "ownership", path: OWN_PLAY_PATH, detail: "yourSubmission is not the viewer's own play" });
}

/** Run every class of 11.2 over one stored doc (`parse: false` skips the strict schema parse, which the suite runs on a sample: every write through `fanOut` is parsed anyway) (`view` region plus the viewer's own `draft`). Returns every finding; empty means clean. `doc.view` null (spectators off) has nothing to find. */
export function checkDoc(g: Game, drafts: GameDrafts, viewer: OracleViewer, doc: unknown, o: { mode?: ScanMode; parse?: boolean } = {}): Finding[] {
  const mode = o.mode ?? "includes";
  const out: Finding[] = [];
  const d = doc as Record<string, unknown>;
  const json = JSON.stringify(doc);
  const found = mode === "tokens" ? new Set(json.match(TOKEN) ?? []) : undefined;
  const parsed = o.parse === false ? null : ViewDocSchema.safeParse(doc);
  if (parsed !== null && !parsed.success) out.push({ detector: "strictParse", path: "(doc)", detail: issues(parsed.error) });
  const f = forbiddenFor(g, drafts, viewer);
  scanStrings(doc, json, f.ids, "cards", "a card id outside the allowlist", out, mode, found);
  scanStrings(doc, json, f.texts, "cards", "a card text outside the allowlist", out, mode, found);
  scanStrings(doc, json, f.pitches, "cards", "a pitch outside the allowlist", out, mode, found);
  scanStrings(doc, json, f.draftTexts, "drafts", "another player's draft text", out, mode, found);
  scanStrings(doc, json, identityStrings(g, viewer), "identity", "an identity string", out);
  const hasRoomCode = viewer.kind === "player" || (viewer.kind === "spectator" && viewer.isHost);
  if (!hasRoomCode && json.includes(JSON.stringify(g.roomCode))) out.push({ detector: "identity", path: where(doc, g.roomCode), detail: "the room code in a doc that has none" });
  const isPlayer = viewer.kind === "player";
  scanKeys(doc, out, {
    internal: INTERNAL_KEYS, own: [...OWN_KEYS, "draft", "draftSeq", "you"], markers: true, whitelist: WHITELIST_MARKER_PATHS,
    ownAt: (path, key) => (key === "draft" || key === "draftSeq" ? path === key && isPlayer : key === "you" ? path === "view.you" && isPlayer : path === `view.you.${key}` && isPlayer),
  });
  const pending = new Set((g.round?.submissions ?? []).map((s) => s.cardId));
  walk(doc, (n) => {
    if (typeof n.value === "string" && pending.has(n.value) && !REVEAL_ID_PATH.test(n.path) && !OWN_VOTE_PATH.test(n.path) && n.path !== OWN_PLAY_PATH) out.push({ detector: "ownership", path: n.path, detail: "a pending card id off the two allowed paths" });
  });
  coOccurrence(doc, pending, new Set(g.players.map((p) => p.id)), out);
  ownValues(g, drafts, viewer, d, out);
  return out;
}

/** The same classes over a RoundDoc built from `record` (PJ13): the cards it may name are the record's own; no key of a vote, a hand, a draft, a marker; no uid; no pending card. */
export function checkRoundDoc(g: Game, record: RoundRecord, doc: RoundDoc, drafts: GameDrafts = {}, mode: ScanMode = "includes"): Finding[] {
  const out: Finding[] = [];
  const json = JSON.stringify(doc);
  const found = mode === "tokens" ? new Set(json.match(TOKEN) ?? []) : undefined;
  const parsed = RoundDocSchema.safeParse(doc);
  if (!parsed.success) out.push({ detector: "strictParse", path: "(doc)", detail: issues(parsed.error) });
  const own = new Set([record.green.id, ...record.playsDetail.map((p) => p.cardId)]);
  const ownTexts = new Set([record.green.text, ...record.playsDetail.map((p) => p.text)]);
  const ownPitches = new Set(record.playsDetail.flatMap((p) => (p.pitch === undefined ? [] : [p.pitch])));
  const ids = Object.keys(g.cards).filter((id) => !own.has(id));
  const texts = Object.entries(g.cards).filter(([id, c]) => !own.has(id) && !ownTexts.has(c.text)).map(([, c]) => c.text);
  const pitches = (g.round?.submissions ?? []).flatMap((s) => (s.pitch === undefined || ownPitches.has(s.pitch) ? [] : [s.pitch]));
  scanStrings(doc, json, ids, "cards", "a card id of another round or a zone", out, mode, found);
  scanStrings(doc, json, texts, "cards", "a card text of another round or a zone", out, mode, found);
  scanStrings(doc, json, pitches, "cards", "a pitch of an open round", out, mode, found);
  scanStrings(doc, json, Object.values(drafts).flatMap((x) => [...x.red, ...x.green]), "drafts", "a draft text", out, mode, found);
  scanStrings(doc, json, [g.hostId, ...g.players.map((p) => p.uid), "seat:", "#k=", "token", "secret", ...g.votes.map((v) => v.voter)], "identity", "an identity string", out);
  scanKeys(doc, out, { internal: [...INTERNAL_KEYS, "votes", "voter"], own: [...OWN_KEYS, "draft", "draftSeq", "you"], markers: true, whitelist: new Set(), ownAt: () => false });
  const pending = new Set((g.round?.submissions ?? []).map((s) => s.cardId).filter((id) => !own.has(id)));
  walk(doc, (n) => { if (typeof n.value === "string" && pending.has(n.value)) out.push({ detector: "ownership", path: n.path, detail: "a pending card id in a round doc" }); });
  coOccurrence(doc, pending, new Set(g.players.map((p) => p.id)), out);
  return out;
}
