// Red stub (#33).
export interface Inc { readonly __inc: number }
export const increment = (n: number): Inc => ({ __inc: n });
export type DocWrite =
  | { op: "create" | "set" | "update"; path: string; data: Record<string, unknown> }
  | { op: "delete"; path: string }
  | { op: "merge"; path: string; data: Record<string, unknown>; fields: string[] };
export const MAX_WRITES = 0;
export class WriteSet {
  constructor(_o: { max: number }) {}
  get size(): number { return 0; }
  create(_p: string, _d: Record<string, unknown>): void {}
  set(_p: string, _d: Record<string, unknown>): void {}
  update(_p: string, _d: Record<string, unknown>): void {}
  delete(_p: string): void {}
  merge(_p: string, _d: Record<string, unknown>, _f: readonly string[]): void {}
  apply(_w: DocWrite): void {}
  writes(): DocWrite[] { return []; }
}
