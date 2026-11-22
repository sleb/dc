import type { DETAIL_BY_CODE, ErrorCode } from "@dc/contracts";
import type { Rejection } from "./types";

type DetailOf<C extends ErrorCode> = C extends keyof typeof DETAIL_BY_CODE ? (typeof DETAIL_BY_CODE)[C][number] : never;

/** The only thing `decide` throws: a bug in the Engine or a broken port (for example the green deck empty). The app maps it to an internal error and nothing commits. */
export class EngineInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineInvariantError";
  }
}

/** Build a rejection. The detail is typed per code from `DETAIL_BY_CODE`; codes absent from it take none. No `detail` key when there is none. */
export function reject<C extends ErrorCode>(code: C, ...detail: [DetailOf<C>] extends [never] ? [] : [detail?: DetailOf<C>]): Rejection {
  const d = detail[0];
  return d === undefined ? { code } : { code, detail: d };
}
