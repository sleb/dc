// Guard 8 for the command rows (LLD 1 sections 5.3, 12): one place that turns a `check` failure into the Engine's rejection.
import { reject } from "../errors";
import { check } from "../moderation";
import type { TextKind } from "../moderation";
import type { Rejection } from "../types";

/** The rejection for `text` as `kind` under `mode`, or null when it passes. The detail is the reason code only, never the input or the matched word. Guard 7 has already made `text` a string. */
export function textRejection(text: string, kind: TextKind, mode: "on" | "off"): Rejection | null {
  const r = check(text, kind, mode);
  return r.ok ? null : reject("CONTENT_REJECTED", r.reason);
}

/** The cleaned form of a text that already passed guard 8 (NFC, trim, whitespace collapsed). */
export function cleanedText(text: string, kind: TextKind): string {
  const r = check(text, kind, "off");
  return r.ok ? r.text : text.trim(); // unreachable after guard 8; keeps the handler total
}
