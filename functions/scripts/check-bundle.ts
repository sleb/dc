import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const BUILTINS = new Set(builtinModules);

/** The child prints one JSON line: the Node version and the bundle's export names. */
const LOAD_SCRIPT = `const m = require("./dist/index.cjs"); console.log(JSON.stringify({ node: process.versions.node, exports: Object.keys(m).filter((k) => k !== "__esModule") }));`;

export type CheckOptions = { /** The node binary to load the bundle with. Default "node" from PATH. */ node?: string };

/** Targets of require(), __require() (Bun's wrapper for externals in some paths) and dynamic import(). */
function requireTargets(bundle: string): string[] {
  return [...bundle.matchAll(/(?<![\w$.])(?:__require|require|import)\(\s*(["'`])([^"'`]*)\1\s*\)/g)].map((m) => m[2] ?? "");
}

function isAllowedTarget(target: string, deps: string[]): boolean {
  if (target.startsWith("node:") || BUILTINS.has(target)) return true;
  return deps.some((d) => target === d || target.startsWith(`${d}/`));
}

/**
 * Checks `<root>/dist/index.cjs` against LLD 0 section 4. Returns one message per problem; empty means the bundle is good.
 * `root` is the functions directory.
 */
export async function checkBundle(root: string, opts: CheckOptions = {}): Promise<string[]> {
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
  let load: Bun.SyncSubprocess<"pipe", "ignore">;
  try {
    // A minimal environment: the bundle must not depend on, or see, anything else from the developer's shell.
    load = Bun.spawnSync([opts.node ?? "node", "-e", LOAD_SCRIPT], {
      cwd: root,
      env: { PATH: process.env["PATH"], HOME: process.env["HOME"], GCLOUD_PROJECT: "demo-deepcuts" },
      stdin: "ignore",
    });
  } catch (error) {
    problems.push(`could not run node to load the bundle: ${error instanceof Error ? error.message : String(error)}`);
    return problems;
  }
  if (load.exitCode !== 0) {
    problems.push(`dist/index.cjs does not load under Node: ${(load.stderr ?? "").toString().trim().split("\n").slice(0, 6).join(" | ")}`);
    return problems;
  }
  const lines = (load.stdout ?? "").toString().trim().split("\n");
  const loaded = JSON.parse(lines[lines.length - 1] ?? "{}") as { node: string; exports: string[] };
  if (!loaded.node.startsWith("22.")) problems.push(`the bundle must be checked under Node 22 (the Functions runtime), but node is ${loaded.node}`);
  const actual = loaded.exports;
  for (const name of actual) if (!expected.includes(name)) problems.push(`export "${name}" is not in exports.json`);
  for (const name of expected) if (!actual.includes(name)) problems.push(`exports.json lists "${name}" but the bundle does not export it (not exported)`);
  return problems;
}

if (import.meta.main) {
  try {
    const problems = await checkBundle(join(import.meta.dir, ".."));
    if (problems.length > 0) {
      console.error(`check-bundle failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
      process.exit(1);
    }
    console.log("check-bundle: ok");
  } catch (error) {
    console.error(`check-bundle could not run (run \`bun run build:functions\` first): ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
