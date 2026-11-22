// The one spelling of "run gcloud" for the repo-level scripts (issue #17): `wait-indexes.ts` and `ops-apply.ts` share
// this, and a test replaces the binary by putting a fake `gcloud` first on PATH (fixtures/fake-gcloud.sh). `gcloud`
// takes its credentials from the ambient ADC or the active user login; nothing here prints or stores a credential.

export type GcloudResult = { code: number; stdout: string; stderr: string };
/** Runs `gcloud <args>`; the tests replace it with a fake `gcloud` on PATH. */
export type Gcloud = (args: string[]) => Promise<GcloudResult>;

/** A `gcloud` that runs the real CLI, with the given environment. */
export function makeGcloud(env: Record<string, string | undefined>): Gcloud {
  return async (args) => {
    const child = Bun.spawn(["gcloud", ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  };
}
