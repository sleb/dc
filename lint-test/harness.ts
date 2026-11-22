// Test harness for the lint and TypeScript policy suite (LLD 0 section 5).
// Snippets are linted under virtual file paths (no fixture files on disk) with the real eslint.config.js.
import { ESLint, type Linter } from "eslint";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
const CONFIG = join(ROOT, "eslint.config.js");
export const configPresent = existsSync(CONFIG);

// Type-aware rules need a real file in a tsconfig, which virtual paths are not. The policy tests
// (rules that only read syntax) switch them off; the type-aware tests use `lintTyped` instead.
const SYNTAX_ONLY = {
  languageOptions: { parserOptions: { project: null, projectService: false } },
  rules: {
    "@typescript-eslint/no-floating-promises": "off",
    "@typescript-eslint/no-misused-promises": "off",
  },
} as const;

const TYPED_SERVICE = {
  files: ["**/*.ts", "**/*.tsx"],
  languageOptions: { parserOptions: { project: null, projectService: true, tsconfigRootDir: ROOT } },
} as const;

let syntaxOnly: ESLint | undefined;
let typed: ESLint | undefined;

function make(overrideConfig: Linter.Config[]): ESLint {
  return new ESLint({ cwd: ROOT, overrideConfigFile: CONFIG, overrideConfig });
}

async function run(eslint: ESLint | undefined, filePath: string, code: string): Promise<Linter.LintMessage[]> {
  // With no eslint.config.js there is no policy: report nothing, so each "reported" test fails on its
  // own assertion ("expected rule X, got nothing") instead of on a harness error.
  if (!eslint) return [];
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, filePath) });
  const messages = result?.messages ?? [];
  const broken = messages.find((m) => m.fatal || /File ignored/.test(m.message));
  if (broken) throw new Error(`harness: ${filePath}: ${broken.message}`);
  return messages;
}

export async function lint(filePath: string, code: string): Promise<Linter.LintMessage[]> {
  if (configPresent) syntaxOnly ??= make([SYNTAX_ONLY as unknown as Linter.Config]);
  return run(syntaxOnly, filePath, code);
}

/** Lints with the unmodified config. `filePath` must be a file that exists and is in a tsconfig. */
export async function lintTyped(filePath: string, code: string): Promise<Linter.LintMessage[]> {
  // The type-aware tests use the project service: with the `project` glob list, typescript-eslint's watch program kept
  // the on-disk text of the file instead of the snippet on Linux (it passed on macOS), so nothing was ever reported there.
  // The rules and their severities are still the real config's.
  if (configPresent) typed ??= make([TYPED_SERVICE as unknown as Linter.Config]);
  return run(typed, filePath, code);
}

export const ruleIds = (ms: Linter.LintMessage[]): string[] => ms.map((m) => m.ruleId ?? "(none)");
export const summarize = (ms: Linter.LintMessage[]): string[] => ms.map((m) => `${m.ruleId ?? "(none)"}: ${m.message}`);
/** The policy rules: anything else (for example a style rule) is not what these tests assert. */
export const policy = (ms: Linter.LintMessage[]): Linter.LintMessage[] => ms.filter((m) => m.ruleId?.startsWith("no-restricted-"));

export interface TscResult { code: number; out: string }

/**
 * Typechecks `code` under a throwaway tsconfig that extends `<pkgDir>/tsconfig[.test].json`.
 * The throwaway lives in the OS temp dir, so nothing is written to the repo.
 */
export async function tsc(pkgDir: string, code: string, opts: { test?: boolean } = {}): Promise<TscResult> {
  const dir = mkdtempSync(join(tmpdir(), "dc-tsc-"));
  try {
    const file = opts.test ? "x.test.ts" : "x.ts";
    writeFileSync(join(dir, file), code);
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
      extends: join(ROOT, pkgDir, opts.test ? "tsconfig.test.json" : "tsconfig.json"),
      compilerOptions: { typeRoots: [join(ROOT, "node_modules/@types")] },
      include: [file],
      exclude: [],
    }));
    const p = Bun.spawn([join(ROOT, "node_modules/.bin/tsc"), "--noEmit", "-p", join(dir, "tsconfig.json")], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err, code_] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code: code_, out: out + err };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The effective config of a package tsconfig, as tsc resolves it. */
export async function showConfig(pkgDir: string, name = "tsconfig.json"): Promise<{ compilerOptions: Record<string, unknown>; include?: string[]; exclude?: string[] } | { error: string }> {
  const p = Bun.spawn([join(ROOT, "node_modules/.bin/tsc"), "--showConfig", "-p", join(ROOT, pkgDir, name)], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, status] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (status !== 0) return { error: (out + err).trim() };
  return JSON.parse(out);
}
