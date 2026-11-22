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

test("F2 firebase.json has an emulators block with the LLD 0 section 5 ports (auth, firestore, functions)", async () => {
  const config = await Bun.file(join(import.meta.dir, "../../firebase.json")).json();
  expect(config.emulators).toEqual({
    auth: { port: 9099 },
    firestore: { port: 8080 },
    functions: { port: 5001 },
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
  expect(scripts.test).toBe("bun test packages functions/src functions/scripts lint-test");
  expect(scripts["test:web"]).toBe("bun test --preload ./apps/web/test/setup.ts apps/web/src");
  expect(scripts["test:rules"]).toStartWith("firebase emulators:exec --only firestore --project demo-deepcuts ");
  expect(scripts["test:e2e"]).toStartWith("echo 'test:e2e: NO SUITE");
});
