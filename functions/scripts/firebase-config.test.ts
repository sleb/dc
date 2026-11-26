import { expect, test } from "bun:test";
import { join } from "node:path";

test("F1 firebase.json functions block points at dist and builds before deploy", async () => {
  const config = await Bun.file(join(import.meta.dir, "../../firebase.json")).json();
  expect(config.functions).toEqual([
    {
      source: "functions/dist",
      codebase: "default",
      runtime: "nodejs22",
      ignore: ["node_modules", "*.log", ".install-ok", ".env.local", ".env.*.local"],
      predeploy: ["bun run build:functions"],
    },
  ]);
});

test("W1 the build scripts exist in the root and the functions package", async () => {
  const root = await Bun.file(join(import.meta.dir, "../../package.json")).json();
  const fns = await Bun.file(join(import.meta.dir, "../package.json")).json();
  expect(root.scripts["build:functions"]).toBe("bun run --cwd functions build");
  expect(fns.scripts.build).toBe("bun scripts/build.ts");
});

test("F2 firebase.json has an emulators block with the LLD 0 section 5 ports (auth, firestore, functions, hosting)", async () => {
  const config = await Bun.file(join(import.meta.dir, "../../firebase.json")).json();
  expect(config.emulators).toEqual({
    auth: { port: 9099 },
    firestore: { port: 8080 },
    functions: { port: 5001 },
    hosting: { port: 5002 },
    ui: { enabled: true, port: 4000 },
    singleProjectMode: true,
  });
});

test("F3 test:integration rebuilds the bundle, then runs the Auth, Firestore and Functions emulators (P9)", async () => {
  const root = await Bun.file(join(import.meta.dir, "../../package.json")).json();
  expect(root.scripts["test:integration"]).toStartWith("bun run build:functions && firebase emulators:exec --only auth,firestore,functions --project demo-deepcuts ");
});

test("W2 the root test scripts match LLD 0 section 6 (#13)", async () => {
  const { scripts } = await Bun.file(join(import.meta.dir, "../../package.json")).json();
  expect(scripts.test).toBe("bun test --parallel --timings=test-timings.json --timeout 120000 packages functions/src functions/scripts scripts lint-test");
  expect(scripts["test:timings"]).toBe(`${scripts.test} --update-timings`);
  expect(scripts["test:web"]).toBe("bun test --preload ./apps/web/test/setup.ts apps/web/src");
  expect(scripts["test:rules"]).toStartWith("firebase emulators:exec --only firestore --project demo-deepcuts ");
  expect(scripts["test:e2e"]).toStartWith("echo 'test:e2e: NO SUITE");
});

test("F5 firebase.json deploys firestore.rules and firestore.indexes.json, and nothing else changed (#15)", async () => {
  const config = await Bun.file(join(import.meta.dir, "../../firebase.json")).json();
  expect(config.firestore).toEqual({ rules: "firestore.rules", indexes: "firestore.indexes.json" });
  // The functions, hosting and emulators blocks are asserted exactly by F1, F4 and F2; this pins the block set.
  expect(Object.keys(config).sort()).toEqual(["emulators", "firestore", "functions", "hosting"]);
});

test("F4 firebase.json hosting serves apps/web/dist with the SPA rewrite, cache headers and Referrer-Policy (#14)", async () => {
  const config = await Bun.file(join(import.meta.dir, "../../firebase.json")).json();
  expect(config.hosting).toEqual({
    public: "apps/web/dist",
    rewrites: [{ source: "**", destination: "/index.html" }],
    headers: [
      { source: "**", headers: [{ key: "Cache-Control", value: "no-cache" }] },
      { source: "/assets/**", headers: [{ key: "Cache-Control", value: "public,max-age=31536000,immutable" }] },
      { source: "**", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ],
  });
});

test("W3 the web scripts exist: build:web, test:hosting, and the root test also runs scripts/ (#14)", async () => {
  const { scripts } = await Bun.file(join(import.meta.dir, "../../package.json")).json();
  expect(scripts["build:web"]).toBe("bun run --cwd apps/web build --mode staging");
  expect(scripts["test:hosting"]).toBe("bun run --cwd apps/web build --mode emulator && firebase emulators:exec --only hosting --project demo-deepcuts 'bun test hosting-test'");
  expect(scripts.test).toContain(" scripts ");
  expect(scripts["test:e2e"]).toContain("#45");
  const web = await Bun.file(join(import.meta.dir, "../../apps/web/package.json")).json();
  expect(web.scripts.build).toBe("vite build");
});
