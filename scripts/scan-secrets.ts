import { join } from "node:path";

// The P13 secret scan (LLD 0, issue #16): the pinned betterleaks over the SOURCE TREE, i.e. the files git tracks or
// would track (`git ls-files --cached --others --exclude-standard`), never build output. Built output
// (apps/web/dist) legitimately holds the public web config inlined in the bundle, which the allowlist does not cover
// (decided in #15: scan the source, not dist). Findings are redacted; exit 0 clean, 1 findings, 2 usage or tool problem.

export const BETTERLEAKS_VERSION = "1.10.1";

export interface ScanOptions {
  root: string;
  /** Path to the betterleaks binary. Default: `betterleaks` on PATH. */
  binary?: string;
}

export async function scanSecrets(o: ScanOptions): Promise<{ code: number; output: string }> {
  const binary = o.binary ?? "betterleaks";
  const install = "install it with: bash scripts/install-betterleaks.sh <dir> and put <dir> on PATH";
  let version: string;
  try {
    const v = Bun.spawnSync([binary, "version"], { stdin: "ignore" });
    version = v.stdout.toString().trim();
    if (v.exitCode !== 0) throw new Error("version failed");
  } catch {
    return { code: 2, output: `scan-secrets: cannot run ${binary}; ${install}\n` };
  }
  if (version !== BETTERLEAKS_VERSION) {
    return { code: 2, output: `scan-secrets: expected betterleaks ${BETTERLEAKS_VERSION}, found ${version}; ${install}\n` };
  }
  const ls = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: o.root, stdin: "ignore" });
  if (ls.exitCode !== 0) return { code: 2, output: `scan-secrets: git ls-files failed in ${o.root}\n` };
  const files = ls.stdout.toString().split("\0").filter(Boolean);
  if (files.length === 0) return { code: 0, output: "scan-secrets: no files to scan\n" };
  const scan = Bun.spawnSync(
    [binary, "dir", "--config", join(o.root, ".betterleaks.toml"), "--no-banner", "--no-color", "--redact", "--verbose", "--exit-code", "1", ...files],
    { cwd: o.root, stdin: "ignore" },
  );
  const output = scan.stdout.toString() + scan.stderr.toString();
  if (scan.exitCode === 0) return { code: 0, output: `scan-secrets: ok (${files.length} files, betterleaks ${version})\n${output}` };
  return { code: scan.exitCode === 1 ? 1 : 2, output };
}

if (import.meta.main) {
  const { code, output } = await scanSecrets({ root: process.cwd(), ...(process.env["BETTERLEAKS_BIN"] ? { binary: process.env["BETTERLEAKS_BIN"] } : {}) });
  process.stdout.write(output);
  process.exit(code);
}
