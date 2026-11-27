import { defineInt } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import type { CallableFunction, CallableRequest } from "firebase-functions/v2/https";
import { log, logError } from "../log";
import type { LogFields } from "../log";

// The minimal wrapper (LLD 5 section 4.2, issue #12): region, service account, App Check, an explicit `allow` with a
// presence check, REGISTRY, and error mapping plus logging. The version gate, zod input and output, `limits`,
// `gameIdOf`, `principalOf`, strict output and `sv` arrive with #38.

export type PrincipalKind = "host" | "seat" | "spectator" | "guest";

export const REGION = "us-central1";
// The `firebase-tools` deploy rejects a bare account name (`fn-runtime`) and resolves this project-relative form to
// `fn-runtime@<projectId>.iam.gserviceaccount.com` (proven by the first deploy, #15); the project id stays out of the
// code (P2).
export const FN_RUNTIME = "fn-runtime@";

/** Runtime shapes (LLD 5 section 3.2). `command` here is the shape under test (decision #6); the real `command` differs (512MiB, 40). */
export const RT = {
  command: {
    memory: "256MiB",
    cpu: 1,
    timeoutSeconds: 10,
    minInstances: defineInt("COMMAND_MIN_INSTANCES", { default: 0 }),
    maxInstances: 3,
    concurrency: 80,
  },
  /** The emulator-only store harness (#33, never deployed): the command shape with room for contention backoff (8 attempts) in the integration suites. */
  harness: {
    memory: "256MiB",
    cpu: 1,
    timeoutSeconds: 300,
    minInstances: 0,
    maxInstances: 3,
    concurrency: 80,
  },
} as const;
export type RuntimeShape = (typeof RT)[keyof typeof RT];

export interface CallableSpec<O extends { ok: boolean }> {
  name: string;
  allow: readonly PrincipalKind[]; // explicit, no default (API1); "guest" lets a request without auth through
  runtime: RuntimeShape;
  handler: (c: { req: CallableRequest }) => Promise<O>;
}

export interface RegistryEntry {
  allow: readonly PrincipalKind[];
  options: Readonly<Record<string, unknown>>;
}

/** Every callable defined through defineCallable; the exports.json check and the API1 tests read this. */
export const REGISTRY = new Map<string, RegistryEntry>();

// HttpsError codes that are the caller's doing: logged as `rejected` (INFO), not `error`.
const CLIENT_FAULTS = new Set(["unauthenticated", "invalid-argument", "not-found", "permission-denied", "failed-precondition", "already-exists", "out-of-range"]);
const INTERNAL_MESSAGE = "Something went wrong.";

export function defineCallable<O extends { ok: boolean }>(s: CallableSpec<O>): CallableFunction<unknown, Promise<O>> {
  const options = { region: REGION, serviceAccount: FN_RUNTIME, enforceAppCheck: true, consumeAppCheckToken: false, ...s.runtime } as const;
  if (REGISTRY.has(s.name)) throw new Error(`defineCallable: duplicate callable name ${s.name}`);
  REGISTRY.set(s.name, { allow: s.allow, options });
  return onCall(options, async (req) => {
    const t0 = Date.now();
    // principalKind is omitted until principalOf exists (#38); a wrong value would be worse than none.
    const line: LogFields = { event: "api.done", callable: s.name };
    const finish = (outcome: "ok" | "rejected" | "error", reason?: string) => {
      try {
        log({ ...line, outcome, ...(reason ? { reason } : {}), latencyMs: Date.now() - t0 });
      } catch {
        // Logging must never change the result of a call.
      }
    };
    let out: O;
    try {
      if (!req.auth && !s.allow.includes("guest")) throw new HttpsError("unauthenticated", "Sign in required.");
      out = await s.handler({ req });
    } catch (e) {
      if (e instanceof HttpsError) {
        finish(CLIENT_FAULTS.has(e.code) ? "rejected" : "error", e.code);
        throw e;
      }
      // Anything else: the cause (message and stack, never the request data) goes to the log for Error Reporting;
      // the client gets a fixed message.
      logError(e);
      finish("error", "internal");
      throw new HttpsError("internal", INTERNAL_MESSAGE);
    }
    finish("ok");
    return out;
  });
}
