// The Projector's public surface (LLD 2 section 2). `fanOutWith`, `assertViewDoc`, `sameContent` and `utf8Length` stay internal: they are test seams.
export { DRAFT_REGION_FIELDS, VIEW_REGION_FIELDS, draftRegion, fanOut } from "./fanout";
export type { ViewWrite } from "./fanout";
export { projectFeed, toRoundDoc } from "./feed";
export { makeProjector, project } from "./projector";
export { PROJECTOR_REV } from "./rev";
export { docIdOf, viewerFor, viewersOf } from "./viewer";
export type { Viewer, ViewTarget } from "./viewer";
