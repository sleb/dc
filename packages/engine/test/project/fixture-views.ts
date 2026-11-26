// #31: the view fixtures exported for the web client (LLD 7 section 11.1, OQ11). Every golden cell of cells.ts becomes one
// ViewDoc: the golden GameView (LLD 2 11.5) wrapped in the view region fanOut writes (LLD 2 4.1, 8.4). There is no
// draft/draftSeq: `project` never sees drafts (E8, LLD 2 11.5) and the web composes the draft region itself. Test-side
// only: nothing here ships, and no committed contracts source imports the engine (LLD 0 P5).
import { VIEW_SCHEMA } from "@dc/contracts";
import type { GameView } from "@dc/contracts";
import { fileURLToPath } from "node:url";
import type { ViewDocBody } from "../../src/project/fanout";
import { PROJECTOR_REV } from "../../src/project/rev";
import { CELLS, goldenOf } from "./cells";
import type { Cell } from "./cells";

/** No clock and no randomness (P8): a re-run is byte-identical. */
export const FIXED_NOW = 1_700_000_000_000;

/** `packages/contracts/fixtures/views`, resolved from this file so the writer works from any working directory. */
export const VIEW_FIXTURES_DIR = fileURLToPath(new URL("../../../contracts/fixtures/views", import.meta.url));

export interface ViewFixture { name: string; fileName: string; doc: ViewDocBody }

/** The cell name with `/` -> `__`, the naming rule of LLD 7 section 11.1 (`writing__host-writer.json`). */
export const fixtureFileName = (c: Cell): string => `${c.name.replaceAll("/", "__")}.json`;

/**
 * One cell's ViewDoc, view region only. `generatedAt`, `viewsRev` and `enabled` are hand-set here (`enabled` is true for every
 * cell: all fixture games have spectators on, so no live cell is a disabled spectator doc). The four cells tagged `departed`
 * (`left`, `removed`, `gone`, `host-precedence`) are the explicit exceptions: `fanOut` writes a departed view only as a
 * tombstone for a transition, so no single state produces them. The 39 live cells are proved equal to their `fanOut` write by
 * `fixture-views.test.ts`; the departed ones are pinned field by field there.
 */
export function viewFixtureDoc(c: Cell): ViewDocBody {
  const game = c.game();
  const view = goldenOf(c) as GameView;
  return {
    schema: VIEW_SCHEMA,
    viewsRev: PROJECTOR_REV,
    gameId: game.id,
    enabled: true,
    version: game.version,
    generatedAt: FIXED_NOW,
    view,
  };
}

/** The 43 fixtures in `CELLS` order: 39 live cells, then the 4 departed ones. */
export function fixtureViews(): ViewFixture[] {
  return CELLS.map((c) => ({ name: c.name, fileName: fixtureFileName(c), doc: viewFixtureDoc(c) }));
}
