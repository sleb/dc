import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("V9 public entry point", () => {
  test("exports exactly the names that exist so far (LLD 1 section 2.1); later steps extend this list", async () => {
    const names = Object.keys(await import("./index")).sort();
    expect(names).toEqual(["EngineInvariantError", "REMINDER_INTERVAL_MS", "actorRole", "activePlayers", "decide", "makeRng", "playability", "seated", "seatUid"].sort());
  });

  test("decide is the public pipeline over the real registry: an unregistered command is INVALID_ARGUMENT", async () => {
    const { decide } = await import("./index");
    const r = decide(null, { type: "__nope__" } as never, { now: 0, rng: (await import("./rng")).makeRng("s"), mintId: () => "c_0000000000", actor: { kind: "system" }, drafts: {} });
    expect(r).toStrictEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
  });

  test("the package depends only on @dc/contracts, and src imports only relative paths or @dc/contracts (P5)", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).toEqual(["@dc/contracts"]);
    const bad: string[] = [];
    for (const file of new Glob("**/*.ts").scanSync(import.meta.dir)) {
      if (file.endsWith(".test.ts")) continue;
      const text = readFileSync(join(import.meta.dir, file), "utf8");
      for (const m of text.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1] ?? "";
        if (!spec.startsWith(".") && spec !== "@dc/contracts") bad.push(`${file}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
