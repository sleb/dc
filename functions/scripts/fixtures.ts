import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const GOOD_PKG = { name: "@dc/functions", dependencies: { "firebase-admin": "1.2.3", "firebase-functions": "4.5.6" } };

export async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `dc-${prefix}-`));
}

/** A functions-like root: package.json, src/index.ts, and any extra files (path -> content). */
export async function makeRoot(files: Record<string, string> = {}, pkg: unknown = GOOD_PKG): Promise<string> {
  const root = await tmp("root");
  const all: Record<string, string> = { "package.json": JSON.stringify(pkg), "src/index.ts": "export const ping = 1;\n", ...files };
  for (const [path, content] of Object.entries(all)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

/**
 * A fake `npm`: counts calls in <dir>/calls, and on success creates node_modules and package-lock.json in the cwd.
 * It fails (exit 1, creating nothing) while <dir>/fail exists.
 */
export async function makeNpmShim(): Promise<{ dir: string; env: Record<string, string | undefined>; calls: () => Promise<number>; failFile: string }> {
  const dir = await tmp("npm");
  const script = `#!/bin/sh\necho x >> "${dir}/calls"\n[ -e "${dir}/fail" ] && exit 1\nmkdir -p node_modules && echo '{}' > package-lock.json\nexit 0\n`;
  await writeFile(join(dir, "npm"), script);
  await chmod(join(dir, "npm"), 0o755);
  return {
    dir,
    env: { ...process.env, PATH: `${dir}:${process.env["PATH"] ?? ""}` },
    calls: async () => {
      const text = await Bun.file(join(dir, "calls")).text().catch(() => "");
      return text.split("\n").filter(Boolean).length;
    },
    failFile: join(dir, "fail"),
  };
}
