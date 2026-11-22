import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkBundle } from "./check-bundle";

const RUNTIME_DEPS = ["firebase-admin", "firebase-functions"] as const;

export type BuildOptions = {
  /** Environment for the `npm install` child process (tests put a fake `npm` on its PATH). */
  env?: Record<string, string | undefined>;
  /** Run check-bundle at the end. Default true. */
  check?: boolean;
};

// Exact semver: no ranges, ^ or ~, dist-tags or aliases. Prerelease and build suffixes are allowed.
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const exists = (path: string) => stat(path).then(() => true, () => false);
const isEnvFile = (name: string) => /^\.env(\..+)?$/.test(name);

/** Builds `<root>/dist` from `<root>/src` and `<root>/package.json` (LLD 0 section 4). `root` is the functions directory. */
export async function build(root: string, opts: BuildOptions = {}): Promise<void> {
  const dist = join(root, "dist");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const declared = pkg.dependencies ?? {};

  const dependencies: Record<string, string> = {};
  for (const name of RUNTIME_DEPS) {
    const v = declared[name];
    if (!v || !EXACT_VERSION.test(v)) throw new Error(`${name} must be an exact version (x.y.z, optionally -prerelease or +build; no ranges, tags or aliases), got ${v}`);
    dependencies[name] = v;
  }
  if (Object.keys(declared).some((n) => !(RUNTIME_DEPS as readonly string[]).includes(n)))
    throw new Error("functions/package.json has a runtime dependency that is not in RUNTIME_DEPS");

  await rm(join(dist, "index.cjs"), { force: true });
  await mkdir(dist, { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(root, "src/index.ts")],
    outdir: dist,
    naming: "index.cjs",
    target: "node",
    format: "cjs",
    minify: false, // readable stack traces in Error Reporting
    sourcemap: "none",
    external: [...RUNTIME_DEPS, ...RUNTIME_DEPS.map((d) => `${d}/*`)],
  });
  if (!result.success) throw new Error(`bundling failed:\n${result.logs.join("\n")}`);

  const next = JSON.stringify({ name: "deepcuts-functions", private: true, main: "index.cjs", engines: { node: "22" }, dependencies }, null, 2) + "\n";
  const pkgFile = join(dist, "package.json");
  const prev = await readFile(pkgFile, "utf8").catch(() => "");
  if (prev !== next) await writeFile(pkgFile, next);

  // The install is skipped only when a previous install of exactly this package.json succeeded.
  // The stamp is removed before installing and written only after success, so a failed or interrupted
  // install (or a deleted node_modules / package-lock.json) is retried on the next build.
  const stampFile = join(dist, ".install-ok");
  const want = createHash("sha256").update(next).digest("hex");
  const stamp = await readFile(stampFile, "utf8").catch(() => "");
  const present = (await exists(join(dist, "node_modules"))) && (await exists(join(dist, "package-lock.json")));
  if (stamp !== want || !present) {
    await rm(stampFile, { force: true });
    // Creates package-lock.json (used by Cloud Build's npm ci) and node_modules (needed locally for the
    // CLI's function discovery and the Functions emulator).
    const p = Bun.spawnSync(["npm", "install", "--omit=dev", "--no-audit", "--no-fund"], {
      cwd: dist,
      env: opts.env ?? process.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    if (p.exitCode !== 0) throw new Error(`npm install failed with exit code ${p.exitCode}`);
    await writeFile(stampFile, want);
  }

  // Function params: the CLI reads .env, .env.<projectId> and .env.local from the functions *source*
  // directory, which is dist. Mirror functions/.env* into dist exactly (stale copies removed; unchanged files are left alone).
  const sources = (await readdir(root)).filter(isEnvFile);
  for (const f of (await readdir(dist)).filter(isEnvFile)) if (!sources.includes(f)) await rm(join(dist, f));
  for (const f of sources) {
    const [from, to] = [await readFile(join(root, f)), await readFile(join(dist, f)).catch(() => null)];
    if (to === null || !from.equals(to)) await copyFile(join(root, f), join(dist, f));
  }

  if (opts.check ?? true) {
    const problems = await checkBundle(root);
    if (problems.length > 0) throw new Error(`check-bundle failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

if (import.meta.main) {
  try {
    await build(join(import.meta.dir, ".."));
    console.log("build: ok");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
