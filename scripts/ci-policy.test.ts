import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// Policy test for .github/workflows/ci.yml (LLD 0 section 8, issue #16). The workflow cannot run before it is on a
// branch, so every property the LLD states (P4, P7, P8, P15 to P18 and the job graph) is asserted here over the
// parsed YAML. A mutation of the workflow that breaks one of them must turn exactly that test red.

const ROOT = join(import.meta.dir, "..");
const WORKFLOW_PATH = join(ROOT, ".github/workflows/ci.yml");

type Step = { name?: string; uses?: string; run?: string; if?: string | boolean; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = {
  if?: string | boolean;
  needs?: string | string[];
  environment?: string | { name?: string };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean | string };
  env?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  on: { pull_request?: unknown; push?: { branches?: string[]; tags?: string[] }; workflow_dispatch?: { inputs?: Record<string, { required?: boolean; type?: string }> } };
  env?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean | string };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

const raw = (() => {
  try {
    return readFileSync(WORKFLOW_PATH, "utf8");
  } catch {
    throw new Error(`${WORKFLOW_PATH} does not exist (issue #16 creates it)`);
  }
})();
const wf = Bun.YAML.parse(raw) as Workflow;
const jobs = wf.jobs;
const jobNames = Object.keys(jobs);
const job = (name: string): Job => {
  const j = jobs[name];
  if (!j) throw new Error(`job ${name} is missing`);
  return j;
};
const steps = (name: string): Step[] => job(name).steps ?? [];
const needs = (name: string): string[] => {
  const n = job(name).needs;
  return n === undefined ? [] : Array.isArray(n) ? n : [n];
};
const runs = (name: string): string[] => steps(name).flatMap((s) => (s.run ? [s.run] : []));
const envName = (name: string): string | undefined => {
  const e = job(name).environment;
  return typeof e === "string" ? e : e?.name;
};
const text = (name: string): string => JSON.stringify(job(name));
const indexOfRun = (name: string, needle: string): number => runs(name).findIndex((r) => r.includes(needle));
/** Every `firebase ...` deploy-like invocation, one per line of a run script (line continuations joined). */
const firebaseDeploys = (): string[] =>
  jobNames.flatMap((n) => runs(n).flatMap((r) => r.replace(/\\\n/g, " ").split("\n").filter((l) => /firebase\s+(deploy|hosting:channel:deploy)\b/.test(l))));

describe("C1 triggers and ref", () => {
  test("the four triggers", () => {
    expect(wf.on.pull_request).not.toBeUndefined();
    expect(wf.on.push?.branches).toEqual(["main"]);
    expect(wf.on.push?.tags).toEqual(["v*.*.*"]);
    const input = wf.on.workflow_dispatch?.inputs?.["ref"];
    expect(input?.required).toBe(true);
    expect(input?.type).toBe("string");
  });
  test("DEPLOY_REF is the dispatched tag or the event ref, and every checkout uses it", () => {
    const deployRef = wf.env?.["DEPLOY_REF"] ?? "";
    expect(deployRef).toContain("workflow_dispatch");
    expect(deployRef).toContain("inputs.ref");
    expect(deployRef).toContain("github.ref");
    // A branch push builds the pushed commit in every job, not whatever the branch points at when the job starts.
    expect(deployRef).toContain("github.sha");
    expect(deployRef).toContain("github.event_name == 'push'");
    expect(deployRef).toContain("startsWith(github.ref, 'refs/heads/')");
    const checkouts = jobNames.flatMap((n) => steps(n).filter((s) => s.uses?.startsWith("actions/checkout@")).map((s) => ({ n, s })));
    expect(checkouts.length).toBeGreaterThanOrEqual(5);
    for (const { n, s } of checkouts) expect([n, s.with?.["ref"]]).toEqual([n, "${{ env.DEPLOY_REF }}"]);
  });
  test("every job runs on a pinned runner image", () => {
    for (const n of jobNames) expect([n, (job(n) as { "runs-on"?: string })["runs-on"]]).toEqual([n, "ubuntu-24.04"]);
  });
  test("the job set is exactly the LLD 0 section 8 set", () => {
    expect([...jobNames].sort()).toEqual(["check-tag", "deploy-prod", "deploy-staging", "emulator", "preview", "verify"]);
  });
});

describe("C2 permissions (P18)", () => {
  test("the default is contents: read and nothing else", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
  });
  test("id-token: write only on preview and deploy-staging, and on both", () => {
    for (const n of jobNames) {
      const has = job(n).permissions?.["id-token"] === "write";
      expect([n, has]).toEqual([n, n === "preview" || n === "deploy-staging"]);
    }
  });
  test("no other job widens its token; only preview writes pull requests", () => {
    for (const n of jobNames) {
      const p = job(n).permissions ?? {};
      for (const [k, v] of Object.entries(p)) {
        if (k === "contents") expect([n, v]).toEqual([n, "read"]);
        else if (k === "id-token") expect(["preview", "deploy-staging"]).toContain(n);
        else if (k === "pull-requests") expect([n, v]).toEqual(["preview", "write"]);
        else throw new Error(`${n} grants ${k}: ${v}`);
      }
    }
  });
  test("secrets, the WIF variables and the staging environment appear only in preview and deploy-staging", () => {
    expect(JSON.stringify(wf.env ?? {})).not.toMatch(/\$\{\{\s*(secrets|vars)\./);
    for (const n of jobNames.filter((x) => x !== "preview" && x !== "deploy-staging")) {
      expect([n, /\$\{\{\s*(secrets\.(?!GITHUB_TOKEN)|vars\.)/.test(text(n))]).toEqual([n, false]);
      expect([n, envName(n) === "staging"]).toEqual([n, false]);
    }
  });
});

describe("C3 actions are pinned (P18)", () => {
  test("every third-party action is pinned to at least a major or a full sha", () => {
    const uses = jobNames.flatMap((n) => steps(n).flatMap((s) => (s.uses ? [s.uses] : [])));
    expect(uses.length).toBeGreaterThan(10);
    for (const u of uses) {
      if (u.startsWith("./")) continue;
      expect([u, /@(v\d+(\.\d+){0,2}|[0-9a-f]{40})$/.test(u)]).toEqual([u, true]);
    }
  });
});

describe("C4 deploy commands (P15)", () => {
  test("every firebase deploy is non-interactive, names its project and never forces", () => {
    const lines = firebaseDeploys();
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const l of lines) {
      expect([l, l.includes("--non-interactive")]).toEqual([l, true]);
      expect([l, /--project\s+deepcuts-staging\b/.test(l)]).toEqual([l, true]);
      expect([l, /--force\b|\s-f\b/.test(l)]).toEqual([l, false]);
    }
  });
  test("no step runs firebase functions:delete or a bare deploy", () => {
    for (const n of jobNames) for (const r of runs(n)) expect(r).not.toMatch(/functions:delete|firebase\s+deploy\s*$/m);
  });
});

describe("C5 deploy-staging order (P16)", () => {
  const order = [
    "--only firestore",
    "scripts/wait-indexes.ts --project deepcuts-staging",
    "--only functions",
    "--only hosting",
    "scripts/ops-apply.ts --project deepcuts-staging",
    "scripts/smoke.ts --project deepcuts-staging",
  ];
  test("firestore, wait-indexes, functions, hosting, ops-apply, smoke, each in its own step and in that order", () => {
    const idx = order.map((o) => indexOfRun("deploy-staging", o));
    for (const [i, o] of order.entries()) expect([o, idx[i]]).not.toEqual([o, -1]);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(new Set(idx).size).toBe(order.length);
  });
  test("it triggers on a push to main only, after verify and emulator", () => {
    expect(job("deploy-staging").if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(needs("deploy-staging").sort()).toEqual(["emulator", "verify"]);
    expect(envName("deploy-staging")).toBe("staging");
  });
  test("wait-indexes needs no later step: smoke gets the debug token from the environment", () => {
    const smoke = steps("deploy-staging").find((s) => s.run?.includes("scripts/smoke.ts"));
    expect(smoke?.env?.["APPCHECK_DEBUG_TOKEN"]).toBe("${{ secrets.APPCHECK_DEBUG_TOKEN }}");
  });
  test("ops-apply is one step in deploy-staging, and no other job runs it", () => {
    const holders = jobNames.flatMap((n) => runs(n).filter((r) => r.includes("ops-apply")).map((r) => [n, r.trim()] as const));
    expect(holders).toEqual([["deploy-staging", "bun scripts/ops-apply.ts --project deepcuts-staging"]]);
    // It fails the deploy when something it declared is missing (P20), so it must not be smuggled into verify.
    expect(steps("deploy-staging").filter((s) => s.run?.includes("ops-apply")).length).toBe(1);
  });
  test("deploy-staging serialises with itself and never cancels", () => {
    const c = job("deploy-staging").concurrency;
    expect(c?.group).toBe("deploy-staging");
    expect(c?.["cancel-in-progress"]).toBe(false);
  });
});

describe("C6 preview and fork safety (P4)", () => {
  test("preview runs only for same-repo pull requests, in the staging environment, after verify and emulator", () => {
    const cond = String(job("preview").if);
    expect(cond).toContain("github.event_name == 'pull_request'");
    expect(cond).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(envName("preview")).toBe("staging");
    expect(needs("preview").sort()).toEqual(["emulator", "verify"]);
  });
  test("WIF is reached through the environment, never through a claim the workflow computes", () => {
    expect(raw).not.toMatch(/assertion\./);
    const auth = steps("preview").find((s) => s.uses?.startsWith("google-github-actions/auth@"));
    expect(auth?.with?.["workload_identity_provider"]).toBe("${{ vars.WIF_PROVIDER_STAGING }}");
    expect(auth?.with?.["service_account"]).toBe("${{ vars.DEPLOYER_SA_STAGING }}");
    expect(JSON.stringify(auth)).not.toContain("event_name");
  });
  test("the provider condition the workflow relies on has no pull_request clause", () => {
    const provision = readFileSync(join(ROOT, "scripts/provision-staging.sh"), "utf8");
    const cond = provision.split("\n").find((l) => l.includes("assertion.repository =="));
    expect(cond).toContain("assertion.environment == '$ENV_NAME'");
    expect(cond).not.toContain("pull_request");
  });
  test("fork pull requests reach only verify and emulator: no credentials in either", () => {
    for (const n of ["verify", "emulator"]) {
      expect([n, job(n).if]).toEqual([n, undefined]);
      expect([n, job(n).environment]).toEqual([n, undefined]);
      expect([n, /id-token|google-github-actions\/auth/.test(text(n))]).toEqual([n, false]);
    }
  });
  test("preview comments the channel URL with the workflow token, once per pull request", () => {
    const comment = steps("preview").find((s) => /issues\/.*comments/.test(s.run ?? ""));
    expect(comment).toBeDefined();
    expect(comment?.run).toContain("dc-preview");
    expect(comment?.env?.["GH_TOKEN"]).toBe("${{ github.token }}");
    expect(job("preview").permissions?.["pull-requests"]).toBe("write");
    expect(steps("preview").find((s) => s.run?.includes("hosting:channel:deploy"))?.run).toContain("pr-${{ github.event.number }}");
  });
});

describe("C7 the App Check debug token", () => {
  test("only the preview build sets VITE_APPCHECK_DEBUG_TOKEN, on the step, never at job or workflow level", () => {
    expect(raw.match(/VITE_APPCHECK_DEBUG_TOKEN/g)?.length).toBe(1);
    const holders = jobNames.filter((n) => text(n).includes("VITE_APPCHECK_DEBUG_TOKEN"));
    expect(holders).toEqual(["preview"]);
    const step = steps("preview").find((s) => s.env?.["VITE_APPCHECK_DEBUG_TOKEN"] !== undefined);
    expect(step?.env?.["VITE_APPCHECK_DEBUG_TOKEN"]).toBe("${{ secrets.APPCHECK_DEBUG_TOKEN }}");
    expect(step?.run).toContain("build:web");
    expect(job("preview").env ?? {}).toEqual({});
  });
  test("the live build in deploy-staging does not see the secret before smoke", () => {
    for (const s of steps("deploy-staging")) {
      if (s.run?.includes("smoke.ts")) continue;
      expect([s.run, JSON.stringify(s.env ?? {}).includes("APPCHECK_DEBUG_TOKEN")]).toEqual([s.run, false]);
    }
  });
});

describe("C8 verify (P7, P8, P13)", () => {
  const v = () => runs("verify");
  test("runs lint, typecheck, bun run test (not the sketch line), test:web, build:functions, build:web, check-web-size", () => {
    for (const cmd of ["bun run lint", "bun run typecheck", "bun run test", "bun run test:web", "bun run build:functions", "bun run build:web", "bun scripts/check-web-size.ts"]) {
      expect([cmd, v().some((r) => r.trim() === cmd)]).toEqual([cmd, true]);
    }
    expect(raw).not.toContain("bun test packages functions/src");
  });
  test("git diff --exit-code is the last check after the builds", () => {
    expect(v().at(-1)?.trim()).toBe("git diff --exit-code");
    expect(indexOfRun("verify", "git diff --exit-code")).toBeGreaterThan(indexOfRun("verify", "bun run build:web"));
  });
  test("installs with a frozen lockfile and uses the pinned Bun and Node", () => {
    expect(v().some((r) => r.trim() === "bun install --frozen-lockfile")).toBe(true);
    const bun = steps("verify").find((s) => s.uses?.startsWith("oven-sh/setup-bun@"));
    expect(bun?.with?.["bun-version-file"]).toBe(".bun-version");
    const node = steps("verify").find((s) => s.uses?.startsWith("actions/setup-node@"));
    expect(String(node?.with?.["node-version"])).toBe("22");
  });
  test("the secret scan is the pinned, checksummed betterleaks over the source tree and runs before the web build", () => {
    const install = indexOfRun("verify", "scripts/install-betterleaks.sh");
    const scan = indexOfRun("verify", "scripts/scan-secrets.ts");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(scan).toBeGreaterThan(install);
    expect(scan).toBeLessThan(indexOfRun("verify", "bun run build:web"));
    expect(raw).not.toMatch(/gitleaks/i);
  });
  test("the scan is not in any job that builds web output into the scanned tree, and no job scans apps/web/dist", () => {
    expect(raw).not.toMatch(/scan-secrets\.ts\s+\S*dist/);
  });
});

describe("C9 Bun off PATH (P7)", () => {
  test("after build:functions, a step loads the bundle under Node with no Bun on PATH, before the web build", () => {
    const build = indexOfRun("verify", "bun run build:functions");
    const check = indexOfRun("verify", "scripts/check-bundle-no-bun.sh");
    expect(check).toBeGreaterThan(build);
    expect(check).toBeLessThan(indexOfRun("verify", "bun run build:web"));
  });
});

describe("C10 emulator", () => {
  const e = () => runs("emulator");
  test("Java 21, the emulator cache, rules, integration with the log sentinels, and the hosting test", () => {
    const java = steps("emulator").find((s) => s.uses?.startsWith("actions/setup-java@"));
    expect(java?.with?.["java-version"]).toBe(21);
    expect(java?.with?.["distribution"]).toBe("temurin");
    const cache = steps("emulator").find((s) => s.uses?.startsWith("actions/cache@"));
    expect(cache?.with?.["path"]).toBe("~/.cache/firebase/emulators");
    for (const cmd of ["bun run test:rules", "bun run test:integration:logs", "bun run test:hosting"]) expect([cmd, e().some((r) => r.trim() === cmd)]).toEqual([cmd, true]);
    expect(e().some((r) => /test:integration(?!:logs)\b/.test(r))).toBe(false);
  });
  test("no Playwright and no test:e2e until #45", () => {
    expect(raw).not.toMatch(/playwright|test:e2e/);
  });
  test("test:hosting overwrites apps/web/dist, so in any job that also runs build:web it comes first", () => {
    for (const n of jobNames) {
      const hosting = indexOfRun(n, "test:hosting");
      const build = indexOfRun(n, "build:web");
      if (hosting >= 0 && build >= 0) expect([n, hosting < build]).toEqual([n, true]);
    }
    expect(jobNames.filter((n) => indexOfRun(n, "test:hosting") >= 0)).toEqual(["emulator"]);
  });
});

describe("C11 tags and prod stub (P17)", () => {
  test("check-tag needs verify and emulator, runs for a tag or a dispatch, and checks the tag shape and ancestry", () => {
    expect(needs("check-tag").sort()).toEqual(["emulator", "verify"]);
    const cond = String(job("check-tag").if);
    expect(cond).toContain("refs/tags/v");
    expect(cond).toContain("workflow_dispatch");
    const r = runs("check-tag").join("\n");
    expect(r).toContain("^refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+$");
    expect(r).toContain("git merge-base --is-ancestor");
    expect(r).toContain("origin/main");
    expect(steps("check-tag").find((s) => s.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"]).toBe(0);
  });
  test("deploy-prod is a guarded stub: if false, behind check-tag, and it touches nothing of production", () => {
    expect(String(job("deploy-prod").if)).toBe("false");
    expect(needs("deploy-prod")).toEqual(["check-tag"]);
    expect(job("deploy-prod").environment).toBeUndefined();
    expect(job("deploy-prod").permissions?.["id-token"]).toBeUndefined();
    expect(text("deploy-prod")).not.toMatch(/production|firebase|google-github-actions|secrets\./);
  });
  test("no job names the production environment before M8", () => {
    for (const n of jobNames) expect([n, envName(n) === "production"]).toEqual([n, false]);
    expect(raw).not.toMatch(/environment:\s*["']?production/);
  });
});

describe("C12 concurrency", () => {
  test("the workflow group follows the ref, and only a pull request cancels", () => {
    expect(wf.concurrency?.group).toContain("inputs.ref || github.ref");
    expect(wf.concurrency?.["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
  });
  test("no job cancels in progress", () => {
    for (const n of jobNames) {
      const c = job(n).concurrency?.["cancel-in-progress"];
      expect([n, c === undefined || c === false]).toEqual([n, true]);
    }
  });
});
