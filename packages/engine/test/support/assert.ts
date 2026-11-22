import { deepStrictEqual } from "node:assert/strict";

/** Rebuild plain objects and arrays so a null-prototype object (a JSON.parse or structuredClone artefact) compares equal to an ordinary one, as `toEqual` did. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value !== "object" || value === null) return value;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
}

/** Runner-independent deep equality for the support modules (bun:test imports are allowed only in test files, LLD 0 P7): throws an AssertionError with a readable diff. */
export function assertDeepEqual(actual: unknown, expected: unknown, message?: string): void {
  deepStrictEqual(plain(actual), plain(expected), message);
}
