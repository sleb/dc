import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { tmp } from "../functions/scripts/fixtures";
import { accessToken, applyOps, monitoringApi, parseArgs, readOps } from "./ops-apply";
import type { Rest } from "./ops-apply";
import type { Gcloud } from "./gcloud";

// LLD 0 section 9 and P20 (issue #17): `ops/` is the declaration, `scripts/ops-apply.ts` applies it idempotently and
// then fails if anything it declared is still absent. OB1 to OB4 check the tree itself by reading the files, so a typo
// in a YAML or JSON file fails here rather than on a deploy; OB5 to OB10 check the script with injected effects and,
// for OB10, a real child process against fake `gcloud`/REST.

const ROOT = join(import.meta.dir, "..");
const OPS = join(ROOT, "ops");
const PROJECT = "deepcuts-staging";
const CHANNEL = `projects/${PROJECT}/notificationChannels/1234567890`;

/** The 20 metrics of LLD 0 section 9 plus `dc_api_error_total` (the function-failure row's metric). */
const METRIC_IDS = [
  "dc_api_error_total",
  "dc_api_invalid_total",
  "dc_api_latency_ms",
  "dc_api_total",
  "dc_appcheck_denied_total",
  "dc_client_outdated_total",
  "dc_command_latency_ms",
  "dc_command_total",
  "dc_idem_replay_total",
  "dc_notify_dedupe_total",
  "dc_notify_latency_ms",
  "dc_notify_poison_total",
  "dc_push_invalid_argument_total",
  "dc_push_pruned_total",
  "dc_push_total",
  "dc_ratelimit_total",
  "dc_reminder_push_total",
  "dc_reminder_sent_total",
  "dc_roomcode_collision_total",
  "dc_txn_retry_total",
];

/** One policy per alert row of section 9 (the Budget row is Cloud Billing's, V2, not a Monitoring policy). */
const ALERT_NAMES = [
  "dc api detail stripped",
  "dc api invalid share",
  "dc appcheck denials",
  "dc client outdated",
  "dc command error rate",
  "dc command latency p95",
  "dc function failure",
  "dc identity purge partial",
  "dc identity revoke retries",
  "dc ip unresolved",
  "dc notification poison",
  "dc notify latency p95",
  "dc outbox redrive volume",
  "dc push health",
  "dc push invalid argument",
  "dc ratelimit code ip spike",
  "dc reminder sweep missed",
  "dc store size",
  "dc stuck deletion",
  "dc transaction contention",
];

const filesIn = async (dir: string, ext: string): Promise<string[]> => {
  try {
    return (await readdir(join(OPS, dir))).filter((f) => f.endsWith(ext)).sort();
  } catch {
    throw new Error(`ops/${dir} does not exist (issue #17 creates it)`);
  }
};
const readOPS = async (path: string): Promise<string> => readFile(join(OPS, path), "utf8");
const objectOf = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

/** The declared metric ids, dashboard display name and alert display names, read straight from the files. */
async function declared(): Promise<{ metrics: string[]; dashboard: string; alerts: string[] }> {
  const metrics = (await filesIn("metrics", ".yaml")).map((f) => f.replace(/\.yaml$/, ""));
  const dashboard = String(objectOf(JSON.parse(await readOPS("dashboards/main.json")))["displayName"]);
  const alerts = await Promise.all((await filesIn("alerts", ".json")).map(async (f) => String(objectOf(JSON.parse(await readOPS(`alerts/${f}`)))["displayName"])));
  return { metrics: metrics.sort(), dashboard, alerts: alerts.sort() };
}

/** Every `logging.googleapis.com/user/<id>` an alert condition refers to, plus every other metric type it names. */
function metricRefs(condition: Record<string, unknown>): { user: string[]; other: string[] } {
  const text = JSON.stringify(condition);
  const user = [...text.matchAll(/logging\.googleapis\.com\/user\/([a-z0-9_]+)/g)].map((m) => m[1] ?? "");
  const other = [...text.matchAll(/"((?:run|cloudfunctions|firestore|compute)\.googleapis\.com\/[a-z0-9/._]+)"/g)].map((m) => m[1] ?? "");
  return { user: [...new Set(user)], other: [...new Set(other)] };
}

// --- OB1 to OB4: the declared tree ---------------------------------------------------------------

describe("OB1 the ops tree parses and is well formed", () => {
  test("every metric file is a dc_* counter or distribution with a filter and consistent labels", async () => {
    const names = await filesIn("metrics", ".yaml");
    expect(names.length).toBe(20);
    for (const name of names) {
      const id = name.replace(/\.yaml$/, "");
      expect([name, /^dc_[a-z0-9_]+$/.test(id)]).toEqual([name, true]);
      const m = objectOf(Bun.YAML.parse(await readOPS(`metrics/${name}`)));
      expect([name, typeof m["description"]]).toEqual([name, "string"]);
      expect([name, typeof m["filter"], String(m["filter"]).trim().length > 0]).toEqual([name, "string", true]);
      const descriptor = objectOf(m["metricDescriptor"]);
      expect([name, descriptor["metricKind"]]).toEqual([name, "DELTA"]);
      const valueType = descriptor["valueType"];
      expect([name, ["INT64", "DISTRIBUTION"].includes(String(valueType))]).toEqual([name, true]);
      // A counter counts matching entries; a distribution has to say which field it extracts.
      if (valueType === "DISTRIBUTION") expect([name, typeof m["valueExtractor"]]).toEqual([name, "string"]);
      else expect([name, m["valueExtractor"]]).toEqual([name, undefined]);
      const extractors = objectOf(m["labelExtractors"]);
      expect([name, Object.keys(extractors).length <= 10]).toEqual([name, true]);
      for (const value of Object.values(extractors)) expect([name, String(value).startsWith("EXTRACT(")]).toEqual([name, true]);
      // Every label carries an extractor and every extractor declares a label: a mismatch is rejected by the API.
      const labels = (Array.isArray(descriptor["labels"]) ? descriptor["labels"] : []).map((l) => String(objectOf(l)["key"])).sort();
      expect([name, labels]).toEqual([name, Object.keys(extractors).sort()]);
    }
  });

  test("every alert file is one policy with one condition and exactly one channel placeholder", async () => {
    const names = await filesIn("alerts", ".json");
    expect(names.length).toBe(20);
    for (const name of names) {
      const text = await readOPS(`alerts/${name}`);
      expect([name, (text.match(/__NOTIFICATION_CHANNEL__/g) ?? []).length]).toEqual([name, 1]);
      const p = objectOf(JSON.parse(text));
      expect([name, String(p["displayName"]).startsWith("dc ")]).toEqual([name, true]);
      expect([name, p["combiner"]]).toEqual([name, "OR"]);
      expect([name, objectOf(p["userLabels"])["managed_by"]]).toEqual([name, "ops-apply"]);
      expect([name, p["notificationChannels"]]).toEqual([name, ["__NOTIFICATION_CHANNEL__"]]);
      const conditions = p["conditions"];
      expect([name, Array.isArray(conditions), (conditions as unknown[]).length]).toEqual([name, true, 1]);
      const c = objectOf((conditions as unknown[])[0]);
      const kinds = ["conditionThreshold", "conditionAbsent", "conditionPrometheusQueryLanguage", "conditionMatchedLog"].filter((k) => c[k] !== undefined);
      expect([name, kinds.length]).toEqual([name, 1]);
      const body = objectOf(c[kinds[0] ?? ""]);
      // Every kind needs a filter or a query; the three that evaluate over time need a duration too.
      const text_ = String(body["filter"] ?? body["query"] ?? "").trim();
      expect([name, text_.length > 0]).toEqual([name, true]);
      if (kinds[0] !== "conditionMatchedLog") expect([name, typeof body["duration"]]).toEqual([name, "string"]);
      if (kinds[0] === "conditionThreshold") {
        expect([name, typeof body["thresholdValue"]]).toEqual([name, "number"]);
        expect([name, String(body["comparison"]).startsWith("COMPARISON_")]).toEqual([name, true]);
      }
      expect([name, typeof c["displayName"]]).toEqual([name, "string"]);
    }
  });

  test("every threshold that spans more than an hour carries a matching duration", async () => {
    // `duration: "0s"` fires on a single alignment window. That is intended for a "more than 5 in the last hour"
    // row; on a 24 h window it means "any one call in the last day", which is what the client-outdated alert says it
    // must not do (LLD 5 section 9: nonzero for more than 24 h).
    const seconds = (duration: unknown): number => Number(String(duration).replace(/s$/, ""));
    for (const name of await filesIn("alerts", ".json")) {
      const condition = objectOf((objectOf(JSON.parse(await readOPS(`alerts/${name}`)))["conditions"] as unknown[])[0]);
      const threshold = condition["conditionThreshold"];
      if (threshold === undefined) continue;
      const body = objectOf(threshold);
      const windows = (Array.isArray(body["aggregations"]) ? body["aggregations"] : []).map((a) => seconds(objectOf(a)["alignmentPeriod"]));
      if (seconds(body["duration"]) > 0) continue;
      for (const window of windows) expect([name, window <= 3600]).toEqual([name, true]);
    }
  });

  test("the dashboard is dc main with the nine widgets section 9 lists", async () => {
    const dashboard = objectOf(JSON.parse(await readOPS("dashboards/main.json")));
    expect(dashboard["displayName"]).toBe("dc main");
    const layout = objectOf(dashboard["mosaicLayout"]);
    expect(layout["columns"]).toBe(12);
    const tiles = (Array.isArray(layout["tiles"]) ? layout["tiles"] : []).map(objectOf);
    expect(tiles.length).toBe(9);
    const titles = tiles.map((t) => String(objectOf(t["widget"])["title"]));
    for (const title of titles) expect(title.length).toBeGreaterThan(0);
    const topics: [string, RegExp][] = [
      ["command rate", /command rate/i],
      ["rejection rate by reason", /rejection.*reason/i],
      ["p50/p95/p99 by commandType", /p50.*p95.*p99.*commandtype/i],
      ["transaction retry ratio", /retry/i],
      ["function instance count", /instance count/i],
      ["cold starts for command", /cold start/i],
      ["push sent/failed/pruned", /push/i],
      ["reminders per sweep", /reminder/i],
      ["Firestore reads/writes", /firestore/i],
    ];
    for (const [label, re] of topics) expect([label, titles.some((t) => re.test(t))]).toEqual([label, true]);
    for (const tile of tiles) expect(JSON.stringify(objectOf(tile["widget"]))).toContain("timeSeriesQuery");
  });
});

describe("OB1 readOps rejects a broken declaration, naming the file", () => {
  const METRIC = 'description: "d"\nfilter: "jsonPayload.event=\\"txn.retry\\""\nmetricDescriptor:\n  metricKind: DELTA\n  valueType: INT64\n';
  const DASHBOARD = JSON.stringify({ displayName: "dc main" });
  const ALERT = JSON.stringify({ displayName: "dc test", notificationChannels: ["__NOTIFICATION_CHANNEL__"] });
  const BASELINE = { "metrics/dc_txn_retry_total.yaml": METRIC, "dashboards/main.json": DASHBOARD, "alerts/test.json": ALERT };

  /** A throwaway `ops` tree; the keys are paths under it, so a test states exactly what the declaration holds. */
  async function tempOps(files: Record<string, string>): Promise<string> {
    const dir = await tmp("ops-tree");
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    return dir;
  }
  const reasonOf = async (files: Record<string, string>): Promise<string> => {
    const outcome = await readOps(await tempOps(files));
    return typeof outcome === "string" ? outcome : "readOps accepted it";
  };
  const without = (path: string): Record<string, string> =>
    Object.fromEntries(Object.entries(BASELINE).filter(([key]) => key !== path));

  test("the baseline tree is accepted", async () => {
    const outcome = await readOps(await tempOps(BASELINE));
    expect(typeof outcome).toBe("object");
    expect(typeof outcome === "string" ? [] : outcome.metrics.map((m) => m.id)).toEqual(["dc_txn_retry_total"]);
  });

  test("a missing metrics directory", async () => {
    expect(await reasonOf(without("metrics/dc_txn_retry_total.yaml"))).toContain("ops/metrics is missing");
  });

  test("a missing alerts directory", async () => {
    expect(await reasonOf(without("alerts/test.json"))).toContain("ops/alerts is missing");
  });

  test("a metric that does not parse", async () => {
    expect(await reasonOf({ ...BASELINE, "metrics/dc_txn_retry_total.yaml": "a: b: c\n" })).toContain("does not parse");
  });

  test("a metric with no filter", async () => {
    const reason = await reasonOf({ ...BASELINE, "metrics/dc_txn_retry_total.yaml": 'description: "d"\nmetricDescriptor:\n  metricKind: DELTA\n' });
    expect(reason).toContain("dc_txn_retry_total.yaml has no filter");
  });

  test("a metric with no metricDescriptor", async () => {
    const reason = await reasonOf({ ...BASELINE, "metrics/dc_txn_retry_total.yaml": 'description: "d"\nfilter: "x"\n' });
    expect(reason).toContain("dc_txn_retry_total.yaml has no metricDescriptor");
  });

  test("an unreadable dashboard", async () => {
    expect(await reasonOf({ ...BASELINE, "dashboards/main.json": "{" })).toContain("ops/dashboards/main.json is unreadable");
  });

  test("a dashboard with no displayName", async () => {
    expect(await reasonOf({ ...BASELINE, "dashboards/main.json": "{}" })).toContain("has no displayName");
  });

  test("an alert that does not parse", async () => {
    expect(await reasonOf({ ...BASELINE, "alerts/test.json": "{" })).toContain("alerts/test.json does not parse");
  });

  test("an alert with no displayName", async () => {
    const reason = await reasonOf({ ...BASELINE, "alerts/test.json": JSON.stringify({ notificationChannels: ["__NOTIFICATION_CHANNEL__"] }) });
    expect(reason).toContain("alerts/test.json has no displayName");
  });

  test("an alert with no channel placeholder", async () => {
    const reason = await reasonOf({ ...BASELINE, "alerts/test.json": JSON.stringify({ displayName: "dc test", notificationChannels: [] }) });
    expect(reason).toContain("has no __NOTIFICATION_CHANNEL__ placeholder");
  });
});

describe("OB2 to OB4 the tree matches the LLD", () => {
  test("OB2 every declared metric is named by LLD 0 section 9, LLD 5 section 9 or LLD 6 section 7.3", async () => {
    const lld = async (path: string, from: RegExp, to: RegExp): Promise<string> => {
      const body = (await readFile(join(ROOT, "docs/lld", path), "utf8")).split("\n");
      const start = body.findIndex((line) => from.test(line));
      const end = body.findIndex((line, i) => i > start && to.test(line));
      return body.slice(start, end === -1 ? undefined : end).join("\n");
    };
    const sections = [
      await lld("00-platform-build-deploy.md", /^## 9\. Observability/, /^## 10\./),
      await lld("05-command-api-contracts.md", /^## 9\. Observability/, /^## 10\./),
      await lld("06-notifications-scheduler.md", /^### 7\.3 /, /^### 7\.4 /),
    ].join("\n");
    for (const metric of await filesIn("metrics", ".yaml")) {
      const id = metric.replace(/\.yaml$/, "");
      expect([id, sections.includes(id)]).toEqual([id, true]);
    }
  });

  test("OB3 every metric the LLD declares has a file, and there are no extras", async () => {
    const declaredMetrics = (await filesIn("metrics", ".yaml")).map((f) => f.replace(/\.yaml$/, "")).sort();
    expect(declaredMetrics).toEqual([...METRIC_IDS].sort());
  });

  test("OB4 no percentile is reduced with REDUCE_SUM", async () => {
    // A percentile is already an aggregate over one series. Summing per-series p95 values doubles the number whenever
    // two revisions overlap (a deploy), so a p95 alert or chart must take the max of them.
    const aggregationOf = (value: unknown): Record<string, unknown>[] => {
      const body = objectOf(value);
      const direct = body["aggregation"];
      const listed = body["aggregations"];
      const found = [...(direct === undefined ? [] : [objectOf(direct)]), ...(Array.isArray(listed) ? listed.map(objectOf) : [])];
      return found;
    };
    const check = (where: string, aggregation: Record<string, unknown>) => {
      if (!String(aggregation["perSeriesAligner"] ?? "").startsWith("ALIGN_PERCENTILE_")) return;
      expect([where, aggregation["crossSeriesReducer"]]).toEqual([where, "REDUCE_MAX"]);
    };
    for (const name of await filesIn("alerts", ".json")) {
      const condition = objectOf((objectOf(JSON.parse(await readOPS(`alerts/${name}`)))["conditions"] as unknown[])[0]);
      for (const kind of ["conditionThreshold", "conditionAbsent"]) {
        for (const aggregation of aggregationOf(condition[kind])) check(`${name}:${kind}`, aggregation);
      }
    }
    const layout = objectOf(objectOf(JSON.parse(await readOPS("dashboards/main.json")))["mosaicLayout"]);
    for (const tile of (Array.isArray(layout["tiles"]) ? layout["tiles"] : []).map(objectOf)) {
      const chart = objectOf(objectOf(tile["widget"])["xyChart"]);
      for (const dataset of (Array.isArray(chart["dataSets"]) ? chart["dataSets"] : []).map(objectOf)) {
        const query = objectOf(objectOf(dataset["timeSeriesQuery"])["timeSeriesFilter"]);
        for (const aggregation of aggregationOf(query)) check(`dashboard:${String(objectOf(tile["widget"])["title"])}`, aggregation);
      }
    }
  });

  test("OB4 every alert condition references a declared metric or a documented built-in, and every row has a policy", async () => {
    const declaredMetrics = new Set((await filesIn("metrics", ".yaml")).map((f) => f.replace(/\.yaml$/, "")));
    // Documented Google built-ins an alert may legitimately reference (none today; the dashboard uses its own).
    const BUILTINS = new Set<string>();
    const seen: string[] = [];
    for (const file of await filesIn("alerts", ".json")) {
      const policy = objectOf(JSON.parse(await readOPS(`alerts/${file}`)));
      seen.push(String(policy["displayName"]));
      for (const condition of (Array.isArray(policy["conditions"]) ? policy["conditions"] : []).map(objectOf)) {
        const refs = metricRefs(condition);
        for (const id of refs.user) expect([file, declaredMetrics.has(id)]).toEqual([file, true]);
        for (const builtin of refs.other) expect([file, BUILTINS.has(builtin)]).toEqual([file, true]);
        // A condition that names neither is a log-matched condition (it alerts on the log line itself).
        if (refs.user.length === 0 && refs.other.length === 0) expect([file, condition["conditionMatchedLog"] !== undefined]).toEqual([file, true]);
      }
    }
    expect(seen.sort()).toEqual([...ALERT_NAMES].sort());
    // The Budget row of section 9 is Cloud Billing's (V2), never a Monitoring policy.
    for (const file of await filesIn("alerts", ".json")) expect([file, /budget/i.test(await readOPS(`alerts/${file}`))]).toEqual([file, false]);
  });
});

// --- OB5 to OB10: ops-apply ----------------------------------------------------------------------

interface State {
  metrics: Set<string>;
  dashboards: Map<string, string>;
  policies: Map<string, string>;
}
const emptyState = (): State => ({ metrics: new Set(), dashboards: new Map(), policies: new Map() });

const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

/**
 * A gcloud that answers the three list calls from `state`, records every argv, and mutates `state` on create and
 * update, so the re-list after the apply sees what the run wrote. `hide` keeps an item out of the listings, which is
 * how P20's verification is tested.
 */
function fakeGcloud(state: State, hide: string[] = []): { gcloud: Gcloud; calls: string[][]; rendered: { file: string; body: Record<string, unknown> }[] } {
  const calls: string[][] = [];
  const rendered: { file: string; body: Record<string, unknown> }[] = [];
  const hidden = new Set(hide);
  const gcloud: Gcloud = async (args) => {
    calls.push(args);
    const family = args.slice(0, 2).join(" ");
    const verb = args[2] ?? "";
    const path = args.find((a) => a.startsWith("--config-from-file=") || a.startsWith("--policy-from-file="))?.split("=")[1] ?? "";
    const config = async (): Promise<Record<string, unknown>> => {
      const body = objectOf(JSON.parse(await readFile(path, "utf8")));
      rendered.push({ file: path, body });
      return body;
    };
    if (family === "logging metrics" && verb === "list") {
      return ok([...state.metrics].filter((id) => !hidden.has(id)).map((id) => ({ name: `projects/${PROJECT}/metrics/${id}` })));
    }
    if (family === "monitoring dashboards" && verb === "list") {
      return ok([...state.dashboards].filter(([displayName]) => !hidden.has(displayName)).map(([displayName, etag], i) => ({ name: `projects/${PROJECT}/dashboards/${i + 1}`, displayName, etag })));
    }
    if (family === "monitoring policies" && verb === "list") {
      return ok([...state.policies.keys()].filter((d) => !hidden.has(d)).map((displayName, i) => ({ name: `projects/${PROJECT}/alertPolicies/${i + 1}`, displayName })));
    }
    if (family === "logging metrics" && (verb === "create" || verb === "update")) {
      state.metrics.add(args[3] ?? "");
      return ok(null);
    }
    if (family === "monitoring dashboards" && verb === "create") {
      state.dashboards.set(String((await config())["displayName"]), "ETAG-FROM-CREATE");
      return ok(null);
    }
    if (family === "monitoring dashboards" && verb === "update") {
      const body = await config();
      state.dashboards.set(String(body["displayName"]), String(body["etag"]));
      return ok(null);
    }
    if (family === "monitoring policies" && (verb === "create" || verb === "update")) {
      const body = await config();
      state.policies.set(String(body["displayName"]), `projects/${PROJECT}/alertPolicies/${state.policies.size + 1}`);
      return ok(null);
    }
    return { code: 1, stdout: "", stderr: `fake gcloud: unexpected arguments: ${args.join(" ")}` };
  };
  return { gcloud, calls, rendered };
}

/** The Monitoring REST surface ops-apply uses: only the notification-channel list. */
const channelsRest = (channels = [{ name: CHANNEL, displayName: "dc-owner", type: "email" }]): Rest => async ({ method, url }) => {
  if (method === "GET" && url.endsWith(`/v3/projects/${PROJECT}/notificationChannels`)) return { notificationChannels: channels };
  throw new Error(`unexpected REST call ${method} ${url}`);
};

const applyWith = (state: State, options: { hide?: string[]; rest?: Rest; tmpDir?: () => Promise<string> } = {}) => {
  const fake = fakeGcloud(state, options.hide);
  const run = () =>
    applyOps({
      project: PROJECT,
      deps: { gcloud: fake.gcloud, token: async () => "fake-access-token", rest: options.rest ?? channelsRest(), log: () => {}, tmpDir: options.tmpDir ?? (() => tmp("ops-apply-tmp")) },
    });
  return { fake, run };
};

test("OB5 create when absent, update when present, and the dashboard update carries the fetched etag", async () => {
  const state = emptyState();
  const first = applyWith(state);
  const out1 = await first.run();
  expect(out1).toEqual({ ok: true, created: 41, updated: 0 });

  const creates = first.fake.calls.filter((c) => c[2] === "create");
  expect(creates.length).toBe(41);
  const metricCreate = creates.find((c) => c[0] === "logging");
  expect(metricCreate?.slice(0, 3)).toEqual(["logging", "metrics", "create"]);
  expect(metricCreate?.slice(4)).toEqual([expect.stringMatching(/^--config-from-file=\S+dc_[a-z0-9_]+\.yaml$/), "--project", PROJECT]);
  const dashboardCreate = creates.find((c) => c[1] === "dashboards");
  expect(dashboardCreate?.slice(0, 3)).toEqual(["monitoring", "dashboards", "create"]);
  const policyCreate = creates.find((c) => c[1] === "policies");
  expect(policyCreate?.slice(0, 3)).toEqual(["monitoring", "policies", "create"]);
  // The placeholder never reaches the API: the rendered policy carries the resolved channel.
  const renderedPolicies = first.fake.rendered.filter((r) => r.body["notificationChannels"] !== undefined);
  expect(renderedPolicies.length).toBe(20);
  for (const r of renderedPolicies) expect(r.body["notificationChannels"]).toEqual([CHANNEL]);
  for (const r of first.fake.rendered) expect(JSON.stringify(r.body)).not.toContain("__NOTIFICATION_CHANNEL__");

  const second = applyWith(state);
  const out2 = await second.run();
  expect(out2).toEqual({ ok: true, created: 0, updated: 41 });
  expect(second.fake.calls.some((c) => c[2] === "create")).toBe(false);
  const dashboardUpdate = second.fake.calls.find((c) => c[1] === "dashboards" && c[2] === "update");
  expect(dashboardUpdate?.slice(0, 4)).toEqual(["monitoring", "dashboards", "update", `projects/${PROJECT}/dashboards/1`]);
  const renderedDashboard = second.fake.rendered.find((r) => r.file.endsWith("main.json"));
  expect(renderedDashboard?.body["etag"]).toBe("ETAG-FROM-CREATE");
  expect(renderedDashboard?.body["name"]).toBe(`projects/${PROJECT}/dashboards/1`);
  expect(renderedDashboard?.body["displayName"]).toBe("dc main");
  // The rendered dashboard lives outside the repo, so `git diff --exit-code` in `verify` stays clean (P8).
  expect(renderedDashboard?.file.startsWith(ROOT)).toBe(false);
});

test("OB6 a second run creates nothing and exits 0", async () => {
  const state = emptyState();
  await applyWith(state).run();
  const again = applyWith(state);
  expect(await again.run()).toEqual({ ok: true, created: 0, updated: 41 });
  expect(again.fake.calls.filter((c) => c[2] === "create")).toEqual([]);
});

test("OB7 a declared item missing after the run fails and names it (P20)", async () => {
  const missing = ["dc_push_total", "dc main", "dc push invalid argument"];
  const { fake, run } = applyWith(emptyState(), { hide: missing });
  const out = await run();
  expect(out.ok).toBe(false);
  const reason = out.ok ? "" : out.reason;
  for (const name of missing) expect([name, reason.includes(name)]).toEqual([name, true]);
  // The verification re-lists instead of trusting what the run saw first: three lists before, three after.
  expect(fake.calls.filter((c) => c[2] === "list").length).toBe(6);
});

test("OB8 no resolvable dc-owner channel exits 1 before any write, pointing at the provisioning step", async () => {
  const { fake, run } = applyWith(emptyState(), { rest: channelsRest([]) });
  const out = await run();
  expect(out.ok).toBe(false);
  expect(out.ok ? "" : out.reason).toContain("scripts/provision-staging.sh channel");
  expect(fake.calls).toEqual([]);
});

test("OB9 bad usage is refused before anything is applied", () => {
  const missing = parseArgs([]);
  expect(typeof missing).toBe("string");
  expect(String(missing)).toContain("--project");
  expect(String(parseArgs(["--project"]))).toContain("--project");
  expect(String(parseArgs(["--project", PROJECT, "--nope"]))).toContain("--nope");
  expect(parseArgs(["--project", PROJECT])).toEqual({ project: PROJECT, channelName: "dc-owner" });
});

/** Puts the fake `gcloud` on PATH and the fake curl-style REST answers in place for a CLI run. */
async function cliFixture(lists: "empty-then-present" | "present", extra: Record<string, string> = {}): Promise<{ env: Record<string, string>; state: string }> {
  const base = await tmp("ops-apply-cli");
  const bin = join(base, "bin");
  await mkdir(bin, { recursive: true });
  await copyFile(join(import.meta.dir, "fixtures/fake-gcloud.sh"), join(bin, "gcloud"));
  await chmod(join(bin, "gcloud"), 0o755);
  const state = join(base, "state");
  await mkdir(state, { recursive: true });
  const { metrics, dashboard, alerts } = await declared();
  const listings = {
    "metrics-list": metrics.map((id) => ({ name: `projects/${PROJECT}/metrics/${id}` })),
    "dashboards-list": [{ name: `projects/${PROJECT}/dashboards/1`, displayName: dashboard, etag: "ETAG-CLI" }],
    "policies-list": alerts.map((displayName, i) => ({ name: `projects/${PROJECT}/alertPolicies/${i + 1}`, displayName })),
  };
  for (const [kind, body] of Object.entries(listings)) {
    if (lists === "present") await writeFile(join(state, `${kind}.json`), JSON.stringify(body));
    else {
      await writeFile(join(state, `${kind}.1.json`), "[]");
      await writeFile(join(state, `${kind}.2.json`), JSON.stringify(body));
    }
  }
  for (const [name, content] of Object.entries(extra)) await writeFile(join(state, name), content);
  const env = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, FAKE_GCLOUD_STATE: state, CLOUDSDK_CORE_DISABLE_PROMPTS: "1" };
  return { env: env as Record<string, string>, state };
}

test("OB5 a non-zero gcloud exit fails the run, naming the command and its stderr", async () => {
  const gcloud: Gcloud = async () => ({ code: 1, stdout: "", stderr: "PERMISSION_DENIED: caller lacks logging.metrics.list" });
  const out = await applyOps({ project: PROJECT, deps: { gcloud, token: async () => "t", rest: channelsRest(), log: () => {}, tmpDir: () => tmp("ops-apply-fail") } });
  expect(out.ok).toBe(false);
  const reason = out.ok ? "" : out.reason;
  expect(reason).toContain("logging metrics list");
  expect(reason).toContain("PERMISSION_DENIED");
});

test("OB5 a listing that is not JSON fails instead of being read as an empty project", async () => {
  const gcloud: Gcloud = async () => ({ code: 0, stdout: "ERROR: (gcloud.logging.metrics) something", stderr: "" });
  const out = await applyOps({ project: PROJECT, deps: { gcloud, token: async () => "t", rest: channelsRest(), log: () => {}, tmpDir: () => tmp("ops-apply-parse") } });
  expect(out.ok).toBe(false);
  expect(out.ok ? "" : out.reason).toContain("did not print JSON");
});

test("OB8 a Monitoring REST failure fails the run with the endpoint", async () => {
  const rest: Rest = async () => {
    throw new Error("GET https://monitoring.googleapis.com/v3/projects/x/notificationChannels answered HTTP 403: Permission denied.");
  };
  const out = await applyWith(emptyState(), { rest }).run();
  expect(out.ok).toBe(false);
  expect(out.ok ? "" : out.reason).toContain("notification channels");
  expect(out.ok ? "" : out.reason).toContain("403");
});

test("OB8 the channel lookup follows nextPageToken, so a channel past the first page resolves", async () => {
  const asked: string[] = [];
  const rest: Rest = async ({ url }) => {
    asked.push(url);
    if (url.includes("pageToken=page-2")) return { notificationChannels: [{ name: CHANNEL, displayName: "dc-owner", type: "email" }] };
    return { notificationChannels: [], nextPageToken: "page-2" };
  };
  const out = await applyWith(emptyState(), { rest }).run();
  expect(out.ok).toBe(true);
  expect(asked.length).toBe(2);
  expect(asked[1]).toContain("pageToken=page-2");
});

test("OB9 the access token comes from the user login, falling back to application-default", async () => {
  const calls: string[][] = [];
  const gcloud = (answers: Record<string, { code: number; stdout?: string }>): Gcloud => {
    return async (args) => {
      calls.push(args);
      const answer = answers[args.join(" ")] ?? { code: 1 };
      return { code: answer.code, stdout: answer.stdout ?? "", stderr: answer.code === 0 ? "" : "ERROR: no credential" };
    };
  };

  const both = gcloud({
    "auth print-access-token": { code: 0, stdout: "user-token\n" },
    "auth application-default print-access-token": { code: 0, stdout: "adc-token\n" },
  });
  expect(await accessToken(both)).toBe("user-token");
  expect(calls.length).toBe(1);

  calls.length = 0;
  const adc = gcloud({ "auth application-default print-access-token": { code: 0, stdout: "adc-token\n" } });
  expect(await accessToken(adc)).toBe("adc-token");
  expect(calls.map((c) => c.join(" "))).toEqual(["auth print-access-token", "auth application-default print-access-token"]);

  await expect(accessToken(gcloud({}))).rejects.toThrow(/application-default/);
});

test("OB9 MONITORING_API_URL is honoured only for a loopback host", () => {
  expect(monitoringApi(undefined)).toBe("https://monitoring.googleapis.com");
  expect(monitoringApi("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  expect(monitoringApi("http://localhost:8080/")).toBe("http://localhost:8080");
  expect(monitoringApi("http://[::1]:8080")).toBe("http://[::1]:8080");
  expect(() => monitoringApi("https://monitoring.evil.example")).toThrow(/loopback/);
});

test("OB10 the CLI exits 1 when a gcloud call fails, and 2 for a non-loopback MONITORING_API_URL", async () => {
  // The channel lookup needs an answer before the gcloud lists run, so a local server stands in for it; the async spawn
  // keeps this process free to answer.
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ notificationChannels: [{ name: CHANNEL, displayName: "dc-owner", type: "email" }] }) });
  try {
    const broken = await cliFixture("present", { "metrics-list.exit": "1" });
    const child = Bun.spawn(["bun", "scripts/ops-apply.ts", "--project", PROJECT], {
      cwd: ROOT,
      env: { ...broken.env, MONITORING_API_URL: `http://127.0.0.1:${server.port}` },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect([code, stderr.slice(0, 200)]).toEqual([1, expect.stringContaining("logging metrics list")]);
    expect(stdout).not.toContain("created");
  } finally {
    await server.stop(true);
  }

  // A usage error is decided before anything is read or sent, so it needs no server.
  const refused = Bun.spawnSync(["bun", "scripts/ops-apply.ts", "--project", PROJECT], {
    cwd: ROOT,
    env: { ...(await cliFixture("present")).env, MONITORING_API_URL: "https://monitoring.evil.example" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(refused.exitCode).toBe(2);
  expect(refused.stderr.toString()).toContain("loopback");
});

test("OB10 the real argv shapes, through the CLI against a fake gcloud on PATH", async () => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === `/v3/projects/${PROJECT}/notificationChannels`) {
        seen.push(request.headers.get("authorization") ?? "");
        return Response.json({ notificationChannels: [{ name: CHANNEL, displayName: "dc-owner", type: "email" }] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    // Async spawn: the local Monitoring server answers in this same process, so a blocking spawn would deadlock.
    const cli = async (env: Record<string, string>) => {
      const child = Bun.spawn(["bun", "scripts/ops-apply.ts", "--project", PROJECT], { cwd: ROOT, env: { ...env, MONITORING_API_URL: `http://127.0.0.1:${server.port}` }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, out: `${stdout}${stderr}` };
    };
    const argvOf = async (state: string, kind: string): Promise<string[]> =>
      (await readFile(join(state, `${kind}.argv`), "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean);

    // An empty project: every item is created.
    const empty = await cliFixture("empty-then-present");
    const created = await cli(empty.env);
    expect(created.code).toBe(0);
    expect(created.out).not.toContain("fake-access-token");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((header) => header === "Bearer fake-access-token")).toBe(true);
    const metricCreate = (await argvOf(empty.state, "metrics-create"))[0] ?? "";
    expect(metricCreate).toMatch(new RegExp(`^logging metrics create dc_[a-z0-9_]+ --config-from-file=\\S+ --project ${PROJECT}$`));
    const dashboardCreate = (await argvOf(empty.state, "dashboards-create"))[0] ?? "";
    expect(dashboardCreate).toMatch(new RegExp(`^monitoring dashboards create --config-from-file=\\S+ --project ${PROJECT}$`));
    const policyCreate = (await argvOf(empty.state, "policies-create"))[0] ?? "";
    expect(policyCreate).toMatch(new RegExp(`^monitoring policies create --policy-from-file=\\S+ --project ${PROJECT}$`));
    expect((await argvOf(empty.state, "metrics-create")).length).toBe(20);
    expect((await argvOf(empty.state, "policies-create")).length).toBe(20);

    // A project that already has everything: every item is updated, in place.
    const present = await cliFixture("present");
    const updated = await cli(present.env);
    expect(updated.code).toBe(0);
    const metricUpdate = (await argvOf(present.state, "metrics-update"))[0] ?? "";
    expect(metricUpdate).toMatch(new RegExp(`^logging metrics update dc_[a-z0-9_]+ --config-from-file=\\S+ --project ${PROJECT}$`));
    const dashboardUpdate = (await argvOf(present.state, "dashboards-update"))[0] ?? "";
    expect(dashboardUpdate).toMatch(new RegExp(`^monitoring dashboards update projects/${PROJECT}/dashboards/1 --config-from-file=\\S+ --project ${PROJECT}$`));
    const policyUpdate = (await argvOf(present.state, "policies-update"))[0] ?? "";
    expect(policyUpdate).toMatch(new RegExp(`^monitoring policies update projects/${PROJECT}/alertPolicies/\\d+ --policy-from-file=\\S+ --project ${PROJECT}$`));
    expect((await argvOf(present.state, "metrics-create")).length).toBe(0);
  } finally {
    await server.stop(true);
  }
});
