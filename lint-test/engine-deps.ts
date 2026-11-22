// P5: the engine's package.json may depend only on @dc/contracts and an allowlist of pure libraries.
export const ENGINE_DEP_ALLOWLIST = ["@dc/contracts", "zod", "fast-check"] as const;
const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

type Pkg = Partial<Record<(typeof FIELDS)[number], Record<string, string>>>;

/** Names in any dependency field that are not on the allowlist. */
export function disallowedDeps(pkg: Pkg): string[] {
  return FIELDS.flatMap((f) => Object.keys(pkg[f] ?? {})).filter((d) => !(ENGINE_DEP_ALLOWLIST as readonly string[]).includes(d));
}
