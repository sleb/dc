import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "./build";
import { GOOD_PKG, makeNpmShim, makeRoot } from "./fixtures";

const read = (path: string) => Bun.file(path).text();
const exists = (path: string) => stat(path).then(() => true, () => false);

let npm: Awaited<ReturnType<typeof makeNpmShim>>;
beforeEach(async () => {
  npm = await makeNpmShim();
});
const run = (root: string) => build(root, { env: npm.env, check: false });

describe("dist/package.json (B1, B2, B4)", () => {
  test("B1 lists exactly the exact-pinned RUNTIME_DEPS", async () => {
    const root = await makeRoot();
    await run(root);
    const dist = JSON.parse(await read(join(root, "dist/package.json")));
    expect(dist.dependencies).toEqual({ "firebase-admin": "1.2.3", "firebase-functions": "4.5.6" });
    expect(dist.main).toBe("index.cjs");
    expect(dist.private).toBe(true);
    expect(dist.devDependencies).toBeUndefined();
  });

  test("B2 a non-exact version throws", async () => {
    const root = await makeRoot({}, { dependencies: { "firebase-admin": "^1.2.3", "firebase-functions": "4.5.6" } });
    await expect(run(root)).rejects.toThrow("firebase-admin must be an exact version");
  });

  test("B2 an extra runtime dependency throws", async () => {
    const root = await makeRoot({}, { dependencies: { ...GOOD_PKG.dependencies, zod: "3.0.0" } });
    await expect(run(root)).rejects.toThrow("not in RUNTIME_DEPS");
  });

  test("B4 package.json is rewritten only when its content changed", async () => {
    const root = await makeRoot();
    await run(root);
    const file = join(root, "dist/package.json");
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(file, old, old);
    await run(root);
    expect((await stat(file)).mtime.getTime()).toBe(old.getTime());
    await writeFile(file, "stale");
    await run(root);
    expect(JSON.parse(await read(file)).name).toBe("deepcuts-functions");
  });
});

describe("bundle (B3, B8)", () => {
  test("B3 firebase packages and subpaths stay external; workspace imports are bundled", async () => {
    const root = await makeRoot({
      "node_modules/@dc/contracts/package.json": JSON.stringify({ name: "@dc/contracts", main: "index.ts" }),
      "node_modules/@dc/contracts/index.ts": "export const MARK = 'contracts-were-bundled';\n",
      "src/index.ts": [
        "import { initializeApp } from 'firebase-admin/app';",
        "import { getAuth } from 'firebase-admin/auth';",
        "import admin from 'firebase-admin';",
        "import { onRequest } from 'firebase-functions/v2/https';",
        "import * as functions from 'firebase-functions';",
        "import { MARK } from '@dc/contracts';",
        "export const probe = [initializeApp, getAuth, admin, onRequest, functions, MARK];",
        "",
      ].join("\n"),
    });
    await run(root);
    const bundle = await read(join(root, "dist/index.cjs"));
    for (const spec of ["firebase-admin/app", "firebase-admin/auth", "firebase-admin", "firebase-functions/v2/https", "firebase-functions"]) {
      expect(bundle).toMatch(new RegExp(`require\\(["']${spec}["']\\)`));
    }
    expect(bundle).toContain("contracts-were-bundled");
    expect(bundle).not.toContain("@dc/contracts");
  });

  test("B8 a stale dist/index.cjs is removed before building", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist/index.cjs"), "STALE-MARKER");
    await run(root);
    expect(await read(join(root, "dist/index.cjs"))).not.toContain("STALE-MARKER");
    // and a failing build must not leave the stale file behind either
    await writeFile(join(root, "dist/index.cjs"), "STALE-MARKER");
    await writeFile(join(root, "src/index.ts"), "export const = ;\n");
    await expect(run(root)).rejects.toThrow();
    expect(await exists(join(root, "dist/index.cjs"))).toBe(false);
  });
});

describe("install stamp (B5, B6)", () => {
  test("B5 installs once, then skips while stamp, node_modules and lockfile are intact", async () => {
    const root = await makeRoot();
    await run(root);
    expect(await npm.calls()).toBe(1);
    expect(await exists(join(root, "dist/.install-ok"))).toBe(true);
    await run(root);
    expect(await npm.calls()).toBe(1);
  });

  test("B5 reinstalls when node_modules, the lockfile or the stamp is missing, or the stamp is stale", async () => {
    const root = await makeRoot();
    await run(root);
    let expected = 1;
    for (const damage of [
      () => rm(join(root, "dist/node_modules"), { recursive: true }),
      () => rm(join(root, "dist/package-lock.json")),
      () => rm(join(root, "dist/.install-ok")),
      () => writeFile(join(root, "dist/.install-ok"), "not-the-hash"),
    ]) {
      await damage();
      await run(root);
      expected += 1;
      expect(await npm.calls()).toBe(expected);
    }
  });

  test("B5 reinstalls when the dependency versions change", async () => {
    const root = await makeRoot();
    await run(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "firebase-admin": "1.2.4", "firebase-functions": "4.5.6" } }));
    await run(root);
    expect(await npm.calls()).toBe(2);
  });

  test("B6 a failed install leaves no stamp and the next build reinstalls", async () => {
    const root = await makeRoot();
    await writeFile(npm.failFile, "");
    await expect(run(root)).rejects.toThrow(/npm install failed/);
    expect(await exists(join(root, "dist/.install-ok"))).toBe(false);
    await rm(npm.failFile);
    await run(root);
    expect(await npm.calls()).toBe(2);
    expect(await exists(join(root, "dist/.install-ok"))).toBe(true);
  });

  test("B6 a failed reinstall removes a previously valid stamp", async () => {
    const root = await makeRoot();
    await run(root);
    await rm(join(root, "dist/node_modules"), { recursive: true });
    await writeFile(npm.failFile, "");
    await expect(run(root)).rejects.toThrow(/npm install failed/);
    expect(await exists(join(root, "dist/.install-ok"))).toBe(false);
  });
});

describe("env mirroring (B7)", () => {
  test("B7 dist/.env* equals functions/.env* byte for byte, stale copies removed, .env.local mirrored", async () => {
    const root = await makeRoot({ ".env": "A=1\n", ".env.demo": "B=é\r\n\n", ".env.local": "C=3", "notenv": "x", ".environment": "x" });
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist/.env.gone"), "stale");
    await writeFile(join(root, "dist/.env"), "OLD");
    await run(root);
    const envs = (await readdir(join(root, "dist"))).filter((f) => /^\.env(\..+)?$/.test(f)).sort();
    expect(envs).toEqual([".env", ".env.demo", ".env.local"]);
    for (const f of envs) {
      expect(new Uint8Array(await Bun.file(join(root, "dist", f)).arrayBuffer())).toEqual(new Uint8Array(await Bun.file(join(root, f)).arrayBuffer()));
    }
    expect(await exists(join(root, "dist/notenv"))).toBe(false);
    expect(await exists(join(root, "dist/.environment"))).toBe(false);
  });
});
