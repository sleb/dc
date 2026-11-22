import { defineInt } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import type { CallableFunction, CallableRequest } from "firebase-functions/v2/https";
import { log } from "../log";
import type { LogFields } from "../log";

// The minimal wrapper (LLD 5 section 4.2, issue #12): region, service account, App Check, an explicit `allow` with a
// presence check, REGISTRY, and error mapping plus logging. The version gate, zod input and output, `limits`,
// `gameIdOf`, `principalOf`, strict output and `sv` arrive with #38.

export type PrincipalKind = "host" | "seat" | "spectator" | "guest";

export const REGION = "us-central1";
export const FN_RUNTIME = "fn-runtime";

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
} as const;

export interface CallableSpec<O extends { ok: boolean }> {
  name: string;
  allow: readonly PrincipalKind[]; // explicit, no default (API1); "guest" lets a request without auth through
  runtime: typeof RT.command;
  handler: (c: { req: CallableRequest }) => Promise<O>;
}

export interface RegistryEntry {
  allow: readonly PrincipalKind[];
  options: Readonly<Record<string, unknown>>;
}

/** Every callable defined through defineCallable; the exports.json check and the API1 tests read this. */
export const REGISTRY = new Map<string, RegistryEntry>();

const INTERNAL_MESSAGE = "Something went wrong.";

export function defineCallable<O extends { ok: boolean }>(s: CallableSpec<O>): CallableFunction<unknown, Promise<O>> {
  const options = { region: REGION, serviceAccount: FN_RUNTIME, enforceAppCheck: true, consumeAppCheckToken: false, ...s.runtime } as const;
  REGISTRY.set(s.name, { allow: s.allow, options });
  return onCall(options, async (req) => {
    const t0 = Date.now();
    const line: LogFields = { event: "api.done", callable: s.name, principalKind: "none" }; // principalOf (#38) fills this in
    const finish = (outcome: "ok" | "rejected" | "error", reason?: string) =>
      log({ ...line, outcome, ...(reason ? { reason } : {}), latencyMs: Date.now() - t0 });
    try {
      if (!req.auth && !s.allow.includes("guest")) throw new HttpsError("unauthenticated", "Sign in required.");
      const out = await s.handler({ req });
      finish("ok");
      return out;
    } catch (e) {
      if (e instanceof HttpsError) {
        finish("error", e.code);
        throw e;
      }
      // Anything else: a fixed message, never the original message or the request data. The Error object log for
      // Error Reporting belongs to #17/#38.
      finish("error", "internal");
      throw new HttpsError("internal", INTERNAL_MESSAGE);
    }
  });
}
