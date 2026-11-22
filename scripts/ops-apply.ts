// Applies the `ops/` declaration to a project and then proves it landed (LLD 0 section 9 and P20, issue #17).
//
//   bun scripts/ops-apply.ts --project <projectId> [--channel-name dc-owner]
//
// `ops/metrics/*.yaml`, `ops/dashboards/main.json` and `ops/alerts/*.json` are the declaration: every metric, the
// dashboard and every alert policy. A run creates what is absent, updates what is present (so a second run creates
// nothing), and re-lists everything, failing and naming any declared item the project does not have. The alert policies
// refer to one notification channel by display name; it is created once by `scripts/provision-staging.sh channel`, and
// this script refuses to run without it rather than applying policies that can notify nobody.
//
// Exit codes: 0 applied and verified, 1 a declaration, the channel or an item is missing, 2 usage. No credential is
// ever printed: the Monitoring REST calls take a token from `gcloud auth print-access-token` and keep it in memory.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGcloud } from "./gcloud";
import type { Gcloud } from "./gcloud";

const OPS_DIR = join(import.meta.dir, "..", "ops");
export const DEFAULT_CHANNEL_NAME = "dc-owner";
const CHANNEL_PLACEHOLDER = "__NOTIFICATION_CHANNEL__";
/** Overridable only so a test can aim the REST calls at a local server; the deploy never sets it. */
const MONITORING_API = process.env["MONITORING_API_URL"] ?? "https://monitoring.googleapis.com";

export interface MetricDeclaration {
  id: string;
  /** The YAML file, passed to `gcloud logging metrics create|update --config-from-file` unchanged. */
  file: string;
}
export interface AlertDeclaration {
  file: string;
  displayName: string;
  /** The policy JSON with the channel placeholder still in it; rendered before it is applied. */
  text: string;
}
export interface OpsDeclarations {
  metrics: MetricDeclaration[];
  dashboardFile: string;
  dashboardDisplayName: string;
  alerts: AlertDeclaration[];
}

/** The Monitoring REST call no GA `gcloud` command covers (the channels API is beta-only). */
export interface RestRequest {
  method: "GET" | "POST";
  url: string;
  token: string;
  body?: unknown;
}
export type Rest = (request: RestRequest) => Promise<unknown>;

/** Every outward-facing effect, injected so the decision logic is tested without a cloud. */
export interface ApplyDeps {
  gcloud: Gcloud;
  token: () => Promise<string>;
  rest: Rest;
  log: (line: string) => void;
  /** A directory outside the repo for rendered configs (`verify` runs `git diff --exit-code`, P8). */
  tmpDir: () => Promise<string>;
}

export interface ApplyOptions {
  project: string;
  channelName?: string;
  deps?: Partial<ApplyDeps>;
}

export type ApplyOutcome = { ok: true; created: number; updated: number } | { ok: false; reason: string };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const lastLine = (s: string): string => s.trim().split("\n").filter(Boolean).at(-1) ?? "(no message)";
const objectOf = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const stringOf = (v: unknown): string => (typeof v === "string" ? v : "");
const listOf = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(objectOf) : []);
/** `projects/<p>/metrics/dc_x` and `projects/<p>/dashboards/123` -> `dc_x` and `123`. */
const idOf = (name: string): string => name.split("/").filter(Boolean).pop() ?? "";

/** Reads and parses the declaration; a broken file is named, so a typo fails here and not on a deploy. */
export async function readOps(dir = OPS_DIR): Promise<OpsDeclarations | string> {
  const names = async (sub: string, ext: string): Promise<string[] | string> => {
    try {
      return (await readdir(join(dir, sub))).filter((f) => f.endsWith(ext)).sort();
    } catch {
      return `ops/${sub} is missing`;
    }
  };

  const metricFiles = await names("metrics", ".yaml");
  if (typeof metricFiles === "string") return metricFiles;
  const metrics: MetricDeclaration[] = [];
  for (const name of metricFiles) {
    const file = join(dir, "metrics", name);
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(await readFile(file, "utf8"));
    } catch (e) {
      return `ops/metrics/${name} does not parse: ${message(e)}`;
    }
    const body = objectOf(parsed);
    if (typeof body["filter"] !== "string" || stringOf(body["filter"]).trim() === "") return `ops/metrics/${name} has no filter`;
    if (body["metricDescriptor"] === undefined) return `ops/metrics/${name} has no metricDescriptor`;
    metrics.push({ id: name.replace(/\.yaml$/, ""), file });
  }

  const dashboardFile = join(dir, "dashboards", "main.json");
  let dashboard: unknown;
  try {
    dashboard = JSON.parse(await readFile(dashboardFile, "utf8"));
  } catch (e) {
    return `ops/dashboards/main.json is unreadable or does not parse: ${message(e)}`;
  }
  const dashboardDisplayName = stringOf(objectOf(dashboard)["displayName"]);
  if (!dashboardDisplayName) return "ops/dashboards/main.json has no displayName";

  const alertFiles = await names("alerts", ".json");
  if (typeof alertFiles === "string") return alertFiles;
  const alerts: AlertDeclaration[] = [];
  for (const name of alertFiles) {
    const text = await readFile(join(dir, "alerts", name), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return `ops/alerts/${name} does not parse: ${message(e)}`;
    }
    const displayName = stringOf(objectOf(parsed)["displayName"]);
    if (!displayName) return `ops/alerts/${name} has no displayName`;
    if (!text.includes(CHANNEL_PLACEHOLDER)) return `ops/alerts/${name} has no ${CHANNEL_PLACEHOLDER} placeholder`;
    alerts.push({ file: join(dir, "alerts", name), displayName, text });
  }

  return { metrics, dashboardFile, dashboardDisplayName, alerts };
}

const realRest: Rest = async ({ method, url, token, body }) => {
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${url} answered HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
};

/** The resource name of the policy channel, or a reason that says how to create it. */
async function resolveChannel(deps: ApplyDeps, project: string, channelName: string): Promise<string | { reason: string }> {
  let token: string;
  try {
    token = await deps.token();
  } catch (e) {
    return { reason: `could not get an access token for the Monitoring API: ${message(e)}` };
  }
  let response: unknown;
  try {
    response = await deps.rest({ method: "GET", url: `${MONITORING_API}/v3/projects/${project}/notificationChannels`, token });
  } catch (e) {
    return { reason: `could not list the notification channels of ${project}: ${message(e)}` };
  }
  const found = listOf(objectOf(response)["notificationChannels"]).find((channel) => stringOf(channel["displayName"]) === channelName);
  if (!found) {
    return {
      reason:
        `no notification channel named ${channelName} in ${project}. Create it once with ` +
        `\`ALERT_EMAIL=<address> scripts/provision-staging.sh channel\`, then re-run this script.`,
    };
  }
  return stringOf(found["name"]);
}

/** Runs one `gcloud` call and turns a non-zero exit into a reason naming what it was doing. */
async function call(deps: ApplyDeps, doing: string, args: string[]): Promise<string | null> {
  const result = await deps.gcloud(args);
  if (result.code !== 0) return `\`gcloud ${args.slice(0, 3).join(" ")}\` (${doing}) exited ${result.code}: ${lastLine(result.stderr)}`;
  return null;
}

async function list(deps: ApplyDeps, doing: string, args: string[]): Promise<Record<string, unknown>[] | string> {
  const result = await deps.gcloud(args);
  if (result.code !== 0) return `\`gcloud ${args.slice(0, 3).join(" ")}\` exited ${result.code}: ${lastLine(result.stderr)}`;
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim() || "[]");
    if (!Array.isArray(parsed)) return `\`gcloud ${args.slice(0, 3).join(" ")}\` did not print a JSON array (${doing})`;
    return parsed.map(objectOf);
  } catch {
    return `\`gcloud ${args.slice(0, 3).join(" ")}\` did not print JSON (${doing})`;
  }
}

const listArgv = (family: string[], project: string): string[] => [...family, "list", "--project", project, "--format=json"];

export async function applyOps(o: ApplyOptions): Promise<ApplyOutcome> {
  const gcloud = o.deps?.gcloud ?? makeGcloud(process.env);
  let ownTmpDir: string | undefined;
  const deps: ApplyDeps = {
    gcloud,
    token:
      o.deps?.token ??
      (async () => {
        const result = await gcloud(["auth", "print-access-token"]);
        if (result.code !== 0) throw new Error(`\`gcloud auth print-access-token\` exited ${result.code}: ${lastLine(result.stderr)}`);
        return result.stdout.trim();
      }),
    rest: o.deps?.rest ?? realRest,
    log: o.deps?.log ?? ((line) => console.log(line)),
    tmpDir:
      o.deps?.tmpDir ??
      (async () => {
        ownTmpDir = await mkdtemp(join(tmpdir(), "dc-ops-apply-"));
        return ownTmpDir;
      }),
  };

  try {
    const declarations = await readOps();
    if (typeof declarations === "string") return { ok: false, reason: declarations };

    const channelName = o.channelName ?? DEFAULT_CHANNEL_NAME;
    const channel = await resolveChannel(deps, o.project, channelName);
    if (typeof channel !== "string") return { ok: false, reason: channel.reason };

    const dir = await deps.tmpDir();
    await mkdir(join(dir, "alerts"), { recursive: true });

    const metricArgs = listArgv(["logging", "metrics"], o.project);
    const dashboardArgs = listArgv(["monitoring", "dashboards"], o.project);
    const policyArgs = listArgv(["monitoring", "policies"], o.project);
    const beforeMetrics = await list(deps, "metrics", metricArgs);
    if (typeof beforeMetrics === "string") return { ok: false, reason: beforeMetrics };
    const beforeDashboards = await list(deps, "dashboards", dashboardArgs);
    if (typeof beforeDashboards === "string") return { ok: false, reason: beforeDashboards };
    const beforePolicies = await list(deps, "policies", policyArgs);
    if (typeof beforePolicies === "string") return { ok: false, reason: beforePolicies };

    const metricIds = new Set(beforeMetrics.map((m) => idOf(stringOf(m["name"]))));
    const dashboardByName = new Map(beforeDashboards.map((d) => [stringOf(d["displayName"]), d]));
    const policyByName = new Map(beforePolicies.map((p) => [stringOf(p["displayName"]), p]));

    deps.log(
      `ops-apply: ${declarations.metrics.length} metrics, 1 dashboard, ${declarations.alerts.length} alert policies ` +
        `into ${o.project} (channel ${channelName})`,
    );

    let created = 0;
    let updated = 0;

    for (const metric of declarations.metrics) {
      const exists = metricIds.has(metric.id);
      const failure = await call(deps, `metric ${metric.id}`, [
        "logging",
        "metrics",
        exists ? "update" : "create",
        metric.id,
        `--config-from-file=${metric.file}`,
        "--project",
        o.project,
      ]);
      if (failure) return { ok: false, reason: failure };
      created += exists ? 0 : 1;
      updated += exists ? 1 : 0;
    }

    const existingDashboard = dashboardByName.get(declarations.dashboardDisplayName);
    const dashboardBody = {
      ...objectOf(JSON.parse(await readFile(declarations.dashboardFile, "utf8"))),
      ...(existingDashboard ? { name: stringOf(existingDashboard["name"]), etag: stringOf(existingDashboard["etag"]) } : {}),
    };
    const dashboardPath = join(dir, "main.json");
    await writeFile(dashboardPath, JSON.stringify(dashboardBody, null, 2));
    // A stale or missing etag is refused by the API, so the update always carries the one this run just listed.
    const dashboardFailure = await call(deps, `dashboard ${declarations.dashboardDisplayName}`, [
      "monitoring",
      "dashboards",
      existingDashboard ? "update" : "create",
      ...(existingDashboard ? [stringOf(existingDashboard["name"])] : []),
      `--config-from-file=${dashboardPath}`,
      "--project",
      o.project,
    ]);
    if (dashboardFailure) return { ok: false, reason: dashboardFailure };
    created += existingDashboard ? 0 : 1;
    updated += existingDashboard ? 1 : 0;

    for (const alert of declarations.alerts) {
      const exists = policyByName.has(alert.displayName);
      const rendered = join(dir, "alerts", alert.file.split("/").pop() ?? "policy.json");
      await writeFile(rendered, alert.text.replaceAll(CHANNEL_PLACEHOLDER, channel));
      const existing = policyByName.get(alert.displayName);
      const failure = await call(deps, `alert policy ${alert.displayName}`, [
        "monitoring",
        "policies",
        exists ? "update" : "create",
        ...(existing ? [stringOf(existing["name"])] : []),
        `--policy-from-file=${rendered}`,
        "--project",
        o.project,
      ]);
      if (failure) return { ok: false, reason: failure };
      created += exists ? 0 : 1;
      updated += exists ? 1 : 0;
    }

    // P20: the run is not done until the project lists everything the declaration names.
    const afterMetrics = await list(deps, "metrics", metricArgs);
    if (typeof afterMetrics === "string") return { ok: false, reason: afterMetrics };
    const afterDashboards = await list(deps, "dashboards", dashboardArgs);
    if (typeof afterDashboards === "string") return { ok: false, reason: afterDashboards };
    const afterPolicies = await list(deps, "policies", policyArgs);
    if (typeof afterPolicies === "string") return { ok: false, reason: afterPolicies };

    const afterMetricIds = new Set(afterMetrics.map((m) => idOf(stringOf(m["name"]))));
    const afterDashboardNames = new Set(afterDashboards.map((d) => stringOf(d["displayName"])));
    const afterPolicyNames = new Set(afterPolicies.map((p) => stringOf(p["displayName"])));
    const missing: string[] = [];
    for (const metric of declarations.metrics) if (!afterMetricIds.has(metric.id)) missing.push(`metric ${metric.id}`);
    if (!afterDashboardNames.has(declarations.dashboardDisplayName)) missing.push(`dashboard ${declarations.dashboardDisplayName}`);
    for (const alert of declarations.alerts) if (!afterPolicyNames.has(alert.displayName)) missing.push(`alert policy ${alert.displayName}`);
    if (missing.length > 0) {
      return { ok: false, reason: `declared in ops/ but absent from ${o.project} after the run (P20): ${missing.join(", ")}` };
    }

    deps.log(`ops-apply: ${created} created, ${updated} updated; all ${created + updated} declared items are listed`);
    return { ok: true, created, updated };
  } catch (e) {
    return { ok: false, reason: message(e) };
  } finally {
    if (ownTmpDir) await rm(ownTmpDir, { recursive: true, force: true });
  }
}

const USAGE = "usage: bun scripts/ops-apply.ts --project <projectId> [--channel-name <display name>]";

/** `--project` is required; `--channel-name` defaults to `dc-owner`. Returns an error message on bad arguments. */
export function parseArgs(argv: string[]): { project: string; channelName: string } | string {
  let project = "";
  let channelName = DEFAULT_CHANNEL_NAME;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--project") {
      if (!value) return "--project needs a value";
      project = value;
      i += 1;
    } else if (flag === "--channel-name") {
      if (!value) return "--channel-name needs a value";
      channelName = value;
      i += 1;
    } else {
      return `unknown argument: ${flag}`;
    }
  }
  if (!project) return "--project is required";
  return { project, channelName };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === "string") {
    console.error(`ops-apply: ${args}\n${USAGE}`);
    process.exit(2);
  }
  const outcome = await applyOps(args);
  if (!outcome.ok) {
    console.error(`ops-apply: ${outcome.reason}`);
    process.exit(1);
  }
}
