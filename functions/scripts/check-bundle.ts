import { builtinModules } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const BUILTINS = new Set(builtinModules);

/**
 * The child prints one JSON line: the Node version and the bundle's export names, leaving out names whose value is `undefined`. An `undefined` export
 * is skipped by firebase-functions' discovery (`extractStack` registers only functions with an `__endpoint`), so it is not deployed; it is how an
 * emulator-only function is absent outside the emulator (the key exists in the CommonJS bundle, the value does not).
 */
const LOAD_SCRIPT = `const m = require("./dist/index.cjs"); const k = Object.keys(m).filter((n) => n !== "__esModule"); console.log(JSON.stringify({ node: process.versions.node, exports: k.filter((n) => m[n] !== undefined) }));`;

/** The gate an emulator-only export reads; the Functions emulator sets it, `firebase deploy` discovery and the deployed runtime do not (#33). */
const EMULATOR_GATE = "FUNCTIONS_EMULATOR";

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
  // exports.emulator.json (optional, default []): functions exported only under the Functions emulator, never deployed (#33, LLD 0 P9).
  const emulatorOnly = JSON.parse(await readFile(join(root, "exports.emulator.json"), "utf8").catch(() => "[]")) as string[];
  for (const name of emulatorOnly) if (expected.includes(name)) problems.push(`"${name}" is in both exports.json and exports.emulator.json`);

  // The gate must be closed for deploy discovery: the CLI loads every functions/.env* (copied into dist) into it.
  for (const dir of ["", "dist/"]) {
    const files = (await readdir(join(root, dir)).catch(() => [] as string[])).filter((f) => /^\.env(\..+)?$/.test(f));
    for (const f of files) {
      const text = await readFile(join(root, dir, f), "utf8");
      if (new RegExp(`^\\s*(export\\s+)?${EMULATOR_GATE}\\s*=`, "m").test(text)) problems.push(`${dir}${f} sets ${EMULATOR_GATE}, which would open the emulator-only exports to deploy discovery`);
    }
  }

  // A minimal environment: the bundle must not depend on, or see, anything else from the developer's shell. Loaded twice: as deployed, and as the
  // Functions emulator loads it (the gate open).
  const base = { PATH: process.env["PATH"], HOME: process.env["HOME"], GCLOUD_PROJECT: "demo-deepcuts" };
  const deployed = loadBundle(root, opts, base, problems);
  if (deployed === null) return problems;
  if (!deployed.node.startsWith("22.")) problems.push(`the bundle must be checked under Node 22 (the Functions runtime), but node is ${deployed.node}`);
  const actual = deployed.exports;
  for (const name of actual) {
    if (emulatorOnly.includes(name)) problems.push(`export "${name}" is emulator-only (exports.emulator.json) but is exported outside the emulator, so it would deploy`);
    else if (!expected.includes(name)) problems.push(`export "${name}" is not in exports.json`);
  }
  for (const name of expected) if (!actual.includes(name)) problems.push(`exports.json lists "${name}" but the bundle does not export it (not exported)`);

  const emulated = loadBundle(root, opts, { ...base, [EMULATOR_GATE]: "true" }, problems);
  if (emulated === null) return problems;
  for (const name of emulated.exports) {
    if (!expected.includes(name) && !emulatorOnly.includes(name)) problems.push(`export "${name}" appears under the emulator but is not in exports.json or exports.emulator.json`);
  }
  for (const name of emulatorOnly) if (!emulated.exports.includes(name)) problems.push(`exports.emulator.json lists "${name}" but it is not exported under the emulator (${EMULATOR_GATE}=true)`);
  for (const name of expected) if (!emulated.exports.includes(name)) problems.push(`exports.json lists "${name}" but the bundle does not export it under the emulator`);
  return problems;
}

interface Loaded { node: string; exports: string[] }

function loadBundle(root: string, opts: CheckOptions, env: Record<string, string | undefined>, problems: string[]): Loaded | null {
  let load: Bun.SyncSubprocess<"pipe", "ignore">;
  try {
    load = Bun.spawnSync([opts.node ?? "node", "-e", LOAD_SCRIPT], { cwd: root, env, stdin: "ignore" });
  } catch (error) {
    problems.push(`could not run node to load the bundle: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const where = env[EMULATOR_GATE] === "true" ? ` (${EMULATOR_GATE}=true)` : "";
  if (load.exitCode !== 0) {
    problems.push(`dist/index.cjs does not load under Node${where}: ${(load.stderr ?? "").toString().trim().split("\n").slice(0, 6).join(" | ")}`);
    return null;
  }
  const lines = (load.stdout ?? "").toString().trim().split("\n");
  return JSON.parse(lines[lines.length - 1] ?? "{}") as Loaded;
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
