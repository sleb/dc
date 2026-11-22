// P5: the engine's package.json may depend only on @dc/contracts and an allowlist of pure libraries.
export const ENGINE_DEP_ALLOWLIST = ["@dc/contracts", "zod"] as const;

/** Names in `dependencies` that are not on the allowlist. */
export function disallowedDeps(pkg: { dependencies?: Record<string, string> }): string[] {
  return Object.keys(pkg.dependencies ?? {}).filter((d) => !(ENGINE_DEP_ALLOWLIST as readonly string[]).includes(d));
}
