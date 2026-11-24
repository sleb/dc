// #29: an in-memory stand-in for the Store of LLD 3 (M3), enough to prove PJ10 and PJ11 of LLD 2 against `fanOut`. Reusable by #30.
// It applies writes the way the real Store will (the view region replaced, the draft region left alone unless `clearDraft`), and it implements the rebuild rule of LLD 2 8.2:
// when `store.viewsRev < PROJECTOR_REV` the first command of any kind, a draft-only one included, rewrites every doc with skip-unchanged off.
import type { ViewDoc } from "@dc/contracts";
import { fanOutWith } from "../../src/project/fanout";
import type { FanOutDeps, ViewWrite } from "../../src/project/fanout";
import { viewersOf } from "../../src/project";
import type { Game } from "../../src/types";

export class SimStore {
  docs = new Map<string, ViewDoc>();
  /** `store.viewsRev` on the aggregate document; 0 before anything was written. */
  viewsRev = 0;
  /** Every write ever applied, for assertions on volume. */
  applied = 0;

  /** Apply writes; throws if a doc's (version, viewsRev) would go down (PJ10). */
  apply(writes: readonly ViewWrite[]): void {
    for (const w of writes) {
      const old = this.docs.get(w.docId);
      if (old !== undefined && (w.doc.version < old.version || (w.doc.version === old.version && w.doc.viewsRev < old.viewsRev))) {
        throw new Error(`PJ10: ${w.docId} went from (${old.version}, ${old.viewsRev}) to (${w.doc.version}, ${w.doc.viewsRev})`);
      }
      const doc = structuredClone(w.doc) as ViewDoc;
      if (old !== undefined && old.draft !== undefined) { doc.draft = old.draft; if (old.draftSeq !== undefined) doc.draftSeq = old.draftSeq; }
      if (w.clearDraft === true) doc.draft = null;
      this.docs.set(w.docId, doc);
      this.applied++;
    }
  }
}

/** One command's fan-out under the Store contract of LLD 2 8.2 and LLD 3. Returns what was written. */
export function commit(store: SimStore, deps: FanOutDeps, prev: Game | null, next: Game, o: { aggregateChanged: boolean; now: number }): ViewWrite[] {
  const stale = store.viewsRev < deps.rev;
  if (!o.aggregateChanged && !stale) return [];
  const writes = fanOutWith(deps, prev, next, { now: o.now, skipUnchanged: !stale });
  store.apply(writes);
  store.viewsRev = deps.rev;
  return writes;
}

const withoutVersion = (view: unknown): string => {
  if (view === null || typeof view !== "object") return JSON.stringify(view);
  const { version: _v, ...rest } = view as Record<string, unknown>;
  return JSON.stringify(rest);
};

/**
 * PJ11: what is wrong with the store after the commit that produced `next`, by the oracle `project` (a full rewrite). `gone` is every docId that has ever vanished from `viewersOf`,
 * tracked by the caller independently of `fanOut`. Empty when the store is exactly right.
 */
export function divergence(store: SimStore, next: Game, project: FanOutDeps["project"], gone: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const at = project(next);
  const targets = viewersOf(next);
  const live = new Set(targets.map((t) => t.docId));
  const expectedIds = new Set([...live, ...[...gone].filter((id) => !live.has(id))]);
  for (const id of store.docs.keys()) if (!expectedIds.has(id)) problems.push(`${id}: a doc that should not exist`);
  for (const id of expectedIds) if (!store.docs.has(id)) problems.push(`${id}: a missing doc`);
  for (const t of targets) {
    const doc = store.docs.get(t.docId);
    if (doc === undefined) continue;
    const spectatorOff = t.viewer.kind === "spectator" && t.viewer.uid === null && !next.settings.spectators.enabled;
    const want = spectatorOff ? null : at(t.viewer);
    if (doc.enabled !== !spectatorOff) problems.push(`${t.docId}: enabled is ${doc.enabled}`);
    if (withoutVersion(doc.view) !== withoutVersion(want)) problems.push(`${t.docId}: the stored view differs from the projection`);
    if (doc.view !== null && doc.version !== doc.view.version) problems.push(`${t.docId}: doc.version != view.version`);
    if (doc.version > next.version) problems.push(`${t.docId}: version ahead of the state`);
  }
  for (const id of gone) {
    if (live.has(id)) continue;
    const doc = store.docs.get(id);
    if (doc !== undefined && !(doc.view?.kind === "departed" && doc.view.reason === "gone")) problems.push(`${id}: a vanished id without a gone tombstone`);
  }
  return problems;
}

/** The docIds that were in `viewersOf(prev)` and are not in `viewersOf(next)`, computed without `fanOut`. */
export function vanished(prev: Game | null, next: Game): string[] {
  if (prev === null) return [];
  const now = new Set(viewersOf(next).map((t) => t.docId));
  return viewersOf(prev).map((t) => t.docId).filter((id) => !now.has(id));
}
