import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmp } from "../functions/scripts/fixtures";

const WEB = join(import.meta.dir, "../apps/web");
const TOKEN = "dc-test-debug-token-0f3a9c1b";
const SLOW = 90_000;

/** Runs `bun run --cwd apps/web build --mode <mode>` into a fresh outDir, with the debug token set only when given. */
async function build(mode: string, token?: string): Promise<{ code: number; out: string; log: string }> {
  const out = join(await tmp("web"), "dist");
  const env: Record<string, string | undefined> = { ...process.env };
  delete env["VITE_APPCHECK_DEBUG_TOKEN"];
  if (token !== undefined) env["VITE_APPCHECK_DEBUG_TOKEN"] = token;
  const p = Bun.spawnSync(["bun", "run", "--cwd", WEB, "build", "--mode", mode, "--outDir", out, "--emptyOutDir"], { env, stdin: "ignore" });
  return { code: p.exitCode, out, log: `${p.stdout.toString()}\n${p.stderr.toString()}` };
}

async function allText(dir: string): Promise<string> {
  const files = await readdir(dir, { recursive: true, withFileTypes: true });
  const parts = await Promise.all(files.filter((f) => f.isFile()).map((f) => readFile(join(f.parentPath, f.name), "utf8")));
  return parts.join("\n");
}

describe("web build", () => {
  test("V1 vite build --mode staging yields an index.html with the no-referrer meta tag", async () => {
    const b = await build("staging");
    expect({ code: b.code, log: b.code === 0 ? "" : b.log }).toEqual({ code: 0, log: "" });
    const html = await readFile(join(b.out, "index.html"), "utf8");
    expect(html).toMatch(/<meta\s+name="referrer"\s+content="no-referrer"\s*\/?>/);
    expect(html).toContain('id="root"');
  }, SLOW);

  test("V2 a build whose mode has no env file (production, until M8) fails instead of shipping a bundle that throws at boot", async () => {
    const b = await build("production");
    expect(b.code).not.toBe(0);
    expect(b.log).toContain("VITE_APP_ENV");
  }, SLOW);

  test("V4 a staging build with the debug token contains it, and one without does not", async () => {
    const withToken = await build("staging", TOKEN);
    expect(withToken.code).toBe(0);
    expect(await allText(withToken.out)).toContain(TOKEN);
    const without = await build("staging");
    expect(without.code).toBe(0);
    expect(await allText(without.out)).not.toContain(TOKEN);
  }, SLOW);

  test("V4 a production or emulator build with the debug token set fails and writes no token", async () => {
    for (const mode of ["production", "emulator"]) {
      const b = await build(mode, TOKEN);
      expect(b.code).not.toBe(0);
      expect(b.log).toContain("VITE_APPCHECK_DEBUG_TOKEN");
      expect(await allText(b.out).catch(() => "")).not.toContain(TOKEN);
    }
  }, SLOW);
});
