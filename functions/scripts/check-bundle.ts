import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const BUILTINS = new Set(builtinModules);

/** Where the bundle's exports are listed by a child process: stdout is one JSON array, last line. */
const LOAD_SCRIPT = `const m = require("./dist/index.cjs"); console.log(JSON.stringify(Object.keys(m).filter((k) => k !== "__esModule")));`;

function requireTargets(bundle: string): string[] {
  return [...bundle.matchAll(/\brequire\(\s*(["'`])([^"'`]*)\1\s*\)/g)].map((m) => m[2] ?? "");
}

function isAllowedTarget(target: string, deps: string[]): boolean {
  if (target.startsWith("node:") || BUILTINS.has(target)) return true;
  return deps.some((d) => target === d || target.startsWith(`${d}/`));
}

/**
 * Checks `<root>/dist/index.cjs` against LLD 0 section 4. Returns one message per problem; empty means the bundle is good.
 * `root` is the functions directory.
 */
export async function checkBundle(root: string): Promise<string[]> {
  const problems: string[] = [];
  const bundle = await readFile(join(root, "dist/index.cjs"), "utf8");
  const pkg = JSON.parse(await readFile(join(root, "dist/package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const deps = Object.keys(pkg.dependencies ?? {});

  if (bundle.includes("bun:")) problems.push('dist/index.cjs contains "bun:"');
  if (/\bBun\./.test(bundle)) problems.push('dist/index.cjs contains "Bun." (Bun global use)');
  if (bundle.includes("@dc/")) problems.push('dist/index.cjs contains "@dc/" (a workspace package was not bundled)');

  for (const target of new Set(requireTargets(bundle))) {
    if (!isAllowedTarget(target, deps)) problems.push(`require("${target}") is neither a Node builtin nor a dist dependency`);
  }

  const expected = JSON.parse(await readFile(join(root, "exports.json"), "utf8")) as string[];
  const load = Bun.spawnSync(["node", "-e", LOAD_SCRIPT], {
    cwd: root,
    env: { ...process.env, GCLOUD_PROJECT: "demo-deepcuts" },
    stdin: "ignore",
  });
  if (load.exitCode !== 0) {
    problems.push(`dist/index.cjs does not load under Node: ${load.stderr.toString().trim().split("\n").slice(0, 6).join(" | ")}`);
    return problems;
  }
  const lines = load.stdout.toString().trim().split("\n");
  const actual = JSON.parse(lines[lines.length - 1] ?? "[]") as string[];
  for (const name of actual) if (!expected.includes(name)) problems.push(`export "${name}" is not in exports.json`);
  for (const name of expected) if (!actual.includes(name)) problems.push(`exports.json lists "${name}" but the bundle does not export it (not exported)`);
  return problems;
}

if (import.meta.main) {
  const problems = await checkBundle(join(import.meta.dir, ".."));
  if (problems.length > 0) {
    console.error(`check-bundle failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("check-bundle: ok");
}
