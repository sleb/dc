// #31: the view fixtures exported for the web client (LLD 7 section 11.1, OQ11). Every golden cell of cells.ts becomes one
// ViewDoc: the golden GameView (LLD 2 11.5) wrapped in the view region fanOut writes (LLD 2 4.1, 8.4). There is no
// draft/draftSeq: `project` never sees drafts (E8, LLD 2 11.5) and the web will compose the draft region (LLD 7 5.1/5.2). Test-side
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

/** The cell name with `/` -> `__`, the naming rule of LLD 7 section 11.1 (`writing__host-writer.json`). Cell names keep their uppercase letters (`lobby/unseatedHost`), so the viewer segment is not lower-cased. */
export const fixtureFileName = (c: Cell): string => `${c.name.replaceAll("/", "__")}.json`;

/** The one cell `fanOut` cannot reproduce: a gone player is not a viewer target, so its tombstone is an explicit doc. */
export const EXPLICIT_ONLY_CELL = "departed/gone";

/**
 * One cell's ViewDoc, view region only. `generatedAt`, `viewsRev` and `enabled` are hand-set here. `enabled` is the live-doc
 * flag: it is true for every cell here, including `departed/host-precedence`, whose game has spectators disabled but whose doc
 * is the host's live doc, not the shared spectator doc. `fanOut(null, game, { now: FIXED_NOW, storedRev: 0 })` writes 42 of the
 * 43 cells byte for byte: `departed/left` and `departed/removed` are departed targets from `viewersOf`, and
 * `departed/host-precedence` is a live host doc named for its cell. Only `departed/gone` is explicit: a gone player is not a
 * viewer target, so `fanOut` writes the seated player's live view for that docId and the tombstone exists only as a transition
 * write. `fixture-views.test.ts` proves the 42 against `fanOut` and pins `gone` field by field.
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

/** The 43 fixtures in `CELLS` order: 42 proved against `fanOut`, then the one explicit `departed/gone` doc. */
export function fixtureViews(): ViewFixture[] {
  return CELLS.map((c) => ({ name: c.name, fileName: fixtureFileName(c), doc: viewFixtureDoc(c) }));
}
