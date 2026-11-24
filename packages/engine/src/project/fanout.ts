// Fan-out (LLD 2 section 8): from the state before and after a command, every view write the Store must make, in `viewersOf` order, then the tombstones. Pure and deterministic (PJ1).
// Correctness never depends on events (PJ11); skip-unchanged only removes writes whose content did not change. Every returned doc has been strict-parsed and size-capped (PJ2, PJ14).
import { VIEW_DOC_MAX_BYTES, VIEW_SCHEMA, ViewDocSchema } from "@dc/contracts";
import type { Draft, GameView, ViewDoc } from "@dc/contracts";
import { EngineInvariantError } from "../errors";
import type { Game } from "../types";
import { makeProjector } from "./projector";
import { PROJECTOR_REV } from "./rev";
import { utf8Length } from "./size";
import { viewersOf } from "./viewer";
import type { Viewer, ViewTarget } from "./viewer";

/** The view region of a doc: what a fan-out write carries. The draft region is written independently (8.4) and cannot be put here by accident. */
export type ViewDocBody = Omit<ViewDoc, "draft" | "draftSeq">;

export interface ViewWrite {
  docId: string;
  doc: ViewDocBody;
  /** The viewer stopped being a seated player: the Store also sets `draft` to null. */
  clearDraft?: true;
}

/** The `mergeFields` lists of LLD 2 8.4: the two regions of a ViewDoc, disjoint, together every key. */
export const VIEW_REGION_FIELDS = ["schema", "viewsRev", "gameId", "enabled", "version", "generatedAt", "view"] as const;
export const DRAFT_REGION_FIELDS = ["draftSeq", "draft"] as const;

/** The draft region for a draft save: a fresh copy of the draft and its counter. */
export function draftRegion(draft: Draft | null, seq: number): { draftSeq: number; draft: Draft | null } {
  return { draftSeq: seq, draft: draft === null ? null : { red: [...draft.red], green: [...draft.green] } };
}

/** The test seam: a projector factory and a revision, so a stale or leaky projector can be exercised without touching the real one. */
export interface FanOutDeps {
  project: (game: Game) => (viewer: Viewer) => GameView;
  rev: number;
}

const viewKey = (view: GameView | null): string => {
  if (view === null) return "null";
  const { version: _version, ...rest } = view;
  return JSON.stringify(rest);
};

/** Same content for a reader: the same `enabled` and the same view, ignoring only the view's top-level `version` (and so not `generatedAt` or the doc's own version). */
export function sameContent(a: Pick<ViewDoc, "enabled" | "view">, b: Pick<ViewDoc, "enabled" | "view">): boolean {
  return a.enabled === b.enabled && viewKey(a.view) === viewKey(b.view);
}

const issuesOf = (error: { issues: readonly { path: readonly PropertyKey[]; code: string }[] }): string =>
  error.issues.slice(0, 10).map((i) => `${i.path.map(String).join(".") || "(root)"} (${i.code})`).join("; ");

/**
 * Strict-parse a doc and check what the schema cannot say (PJ2, PJ10, PJ14). Throws `EngineInvariantError` whose message holds issue paths, codes and numbers only, never a value.
 * Returns nothing: the caller keeps the object it built, not a parse clone.
 */
export function assertViewDoc(doc: unknown, expect: { gameId: string; viewsRev: number }): void {
  const parsed = ViewDocSchema.safeParse(doc);
  if (!parsed.success) throw new EngineInvariantError(`view doc invalid: ${issuesOf(parsed.error)}`);
  const d = parsed.data;
  if (Object.hasOwn(d, "draft") || Object.hasOwn(d, "draftSeq")) throw new EngineInvariantError("view doc carries the draft region");
  if (d.enabled !== (d.view !== null)) throw new EngineInvariantError("view doc: enabled and view disagree");
  if (d.gameId !== expect.gameId) throw new EngineInvariantError("view doc: wrong gameId");
  if (d.viewsRev !== expect.viewsRev) throw new EngineInvariantError(`view doc: viewsRev ${d.viewsRev} is not ${expect.viewsRev}`);
  if (d.view !== null) {
    if (d.view.version !== d.version) throw new EngineInvariantError(`view doc: version ${d.version} differs from view.version ${d.view.version}`);
    if (d.view.gameId !== d.gameId) throw new EngineInvariantError("view doc: view.gameId differs from gameId");
  }
  const bytes = utf8Length(JSON.stringify(doc));
  if (bytes > VIEW_DOC_MAX_BYTES) throw new EngineInvariantError(`view doc over the hard cap: ${bytes} bytes, limit ${VIEW_DOC_MAX_BYTES}`);
}

const targetsOf = (game: Game): ViewTarget[] => {
  const targets = viewersOf(game);
  if (new Set(targets.map((t) => t.docId)).size !== targets.length) throw new EngineInvariantError("fanOut: viewersOf names a doc twice");
  return targets;
};

function bodyOf(game: Game, t: ViewTarget, at: (viewer: Viewer) => GameView, rev: number, now: number): ViewDocBody {
  const off = t.viewer.kind === "spectator" && t.viewer.uid === null && !game.settings.spectators.enabled;
  return { schema: VIEW_SCHEMA, viewsRev: rev, gameId: game.id, enabled: !off, version: game.version, generatedAt: now, view: off ? null : at(t.viewer) };
}

function tombstone(game: Game, rev: number, now: number): ViewDocBody {
  return { schema: VIEW_SCHEMA, viewsRev: rev, gameId: game.id, enabled: true, version: game.version, generatedAt: now, view: { kind: "departed", audience: "departed", gameId: game.id, version: game.version, reason: "gone" } };
}

export function fanOutWith(deps: FanOutDeps, prev: Game | null, next: Game, o: { now: number; skipUnchanged: boolean }): ViewWrite[] {
  const at = deps.project(next);
  const before = new Map((prev === null ? [] : targetsOf(prev)).map((t) => [t.docId, t]));
  const atPrev = prev === null ? null : deps.project(prev);
  const out: ViewWrite[] = [];
  const keep = (docId: string, doc: ViewDocBody, clear: boolean): void => {
    assertViewDoc(doc, { gameId: next.id, viewsRev: deps.rev });
    out.push(clear ? { docId, doc, clearDraft: true } : { docId, doc });
  };
  const live = new Set<string>();
  for (const t of targetsOf(next)) {
    live.add(t.docId);
    const body = bodyOf(next, t, at, deps.rev, o.now);
    const b = before.get(t.docId);
    if (o.skipUnchanged && b !== undefined && prev !== null && atPrev !== null && sameContent(bodyOf(prev, b, atPrev, deps.rev, o.now), body)) continue;
    keep(t.docId, body, b?.viewer.kind === "player" && t.viewer.kind !== "player");
  }
  for (const [docId, b] of before) if (!live.has(docId)) keep(docId, tombstone(next, deps.rev, o.now), b.viewer.kind === "player");
  return out;
}

/** Every view write for the step from `prev` (null at creation) to `next`. With `skipUnchanged` a view whose content is the same for its reader is not rewritten. */
export function fanOut(prev: Game | null, next: Game, o: { now: number; skipUnchanged: boolean }): ViewWrite[] {
  return fanOutWith({ project: makeProjector, rev: PROJECTOR_REV }, prev, next, o);
}
