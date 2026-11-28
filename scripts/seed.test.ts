import { describe, expect, test } from "bun:test";
import { checkSeedEnv, parseSeedArgs, SeedUsageError } from "./seed";

// V2, V10 (LLD 0 P1, LLD 3 section 10.1): the seed CLI's pure checks. The emulator half (exit codes, a replaying second --all)
// is functions/test-integration/store/fixtures.test.ts, which has the emulators to talk to.

const parse = (argv: string[]) => {
  try {
    return { ok: true as const, value: parseSeedArgs(argv) };
  } catch (e) {
    return { ok: false as const, error: e };
  }
};

describe("parseSeedArgs", () => {
  test("--fixture names one buildable fixture", () => {
    expect(parseSeedArgs(["--fixture", "lobby3"])).toEqual({ kind: "one", fixture: "lobby3" });
    expect(parseSeedArgs(["--fixture", "midsize10"])).toEqual({ kind: "one", fixture: "midsize10" });
  });

  test("--all names the CI catalogue", () => {
    expect(parseSeedArgs(["--all"])).toEqual({ kind: "all" });
  });

  test("a missing selector, an unknown flag or name, both selectors and a stray argument are usage errors", () => {
    for (const argv of [[], ["--fixture"], ["--fixture", "nope"], ["--all", "--fixture", "lobby3"], ["--wat"], ["--fixture", "lobby3", "extra"]]) {
      const r = parse(argv);
      expect([argv, r.ok]).toEqual([argv, false]);
      if (!r.ok) expect(r.error).toBeInstanceOf(SeedUsageError);
    }
  });
});

describe("checkSeedEnv", () => {
  test("accepts a demo- project with the Firestore emulator host set", () => {
    expect(checkSeedEnv({ GCLOUD_PROJECT: "demo-deepcuts", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" })).toEqual({ ok: true });
  });

  test("refuses a real project: the script must never seed outside demo- (LLD 0 P1)", () => {
    const r = checkSeedEnv({ GCLOUD_PROJECT: "deepcuts-staging", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("GCLOUD_PROJECT");
  });

  test("refuses without FIRESTORE_EMULATOR_HOST, even for a demo project", () => {
    const r = checkSeedEnv({ GCLOUD_PROJECT: "demo-deepcuts" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("FIRESTORE_EMULATOR_HOST");
  });
});