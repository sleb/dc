// `bun scripts/seed.ts --fixture <name> | --all` (LLD 3 section 10.1, #37): build the emulator fixture catalogue through the real
// createGame and runCommand on the Node bundle. A repo script, never shipped. It refuses a project that is not `demo-` or an
// environment with no Firestore emulator (LLD 0 P1), takes one fixed id per fixture, and prints ids and counts only (P19).
// `--all` is the CI catalogue; `midsize10` is opt-in because its ~900-command build is the size fixture's own test.
import { CATALOGUE, FIXTURES } from "../functions/test-integration/store/support/fixture-names";
import type { FixtureName } from "../functions/test-integration/store/support/fixture-names";

export class SeedUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedUsageError";
  }
}

export type SeedArgs = { kind: "one"; fixture: FixtureName } | { kind: "all" };

const USAGE = `usage: bun scripts/seed.ts --fixture <${FIXTURES.join("|")}> | --all`;

/** Pure argument parsing: no Firestore, no Firebase app, so `scripts/seed.test.ts` can check it without emulators. */
export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  if (argv[0] === "--all") {
    if (argv.length !== 1) throw new SeedUsageError(`--all takes no other argument; ${USAGE}`);
    return { kind: "all" };
  }
  if (argv[0] === "--fixture") {
    if (argv.length !== 2) throw new SeedUsageError(`--fixture takes exactly one name; ${USAGE}`);
    const name = argv[1] as FixtureName;
    if (!(FIXTURES as readonly string[]).includes(name)) throw new SeedUsageError(`unknown fixture ${name}; ${USAGE}`);
    return { kind: "one", fixture: name };
  }
  throw new SeedUsageError(argv.length === 0 ? `no selector; ${USAGE}` : `unknown argument ${argv[0]}; ${USAGE}`);
}

export type SeedEnvCheck = { ok: true } | { ok: false; reason: string };

/** LLD 0 P1: a demo- project and a live Firestore emulator host, or nothing is written. */
export function checkSeedEnv(env: Record<string, string | undefined>): SeedEnvCheck {
  const project = env["GCLOUD_PROJECT"];
  if (project === undefined || !project.startsWith("demo-")) {
    return { ok: false, reason: `GCLOUD_PROJECT must start with demo- (got ${project === undefined ? "nothing" : project}); this script never seeds a real project` };
  }
  const host = env["FIRESTORE_EMULATOR_HOST"];
  if (host === undefined || host.trim() === "") {
    return { ok: false, reason: "FIRESTORE_EMULATOR_HOST must name the emulator (start it with firebase emulators:exec or emulators:start)" };
  }
  return { ok: true };
}

export async function main(argv: readonly string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  let args: SeedArgs;
  try {
    args = parseSeedArgs(argv);
  } catch (e) {
    if (e instanceof SeedUsageError) {
      console.error(`seed: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const check = checkSeedEnv(env);
  if (!check.ok) {
    console.error(`seed: refusing: ${check.reason}`);
    return 1;
  }
  // Loaded only after the guards: the module opens the Firebase client and Admin apps.
  const { seedCatalogue, seedFixture } = await import("../functions/test-integration/store/support/fixtures");
  const report = (r: { name: string; gameId: string; roomCode: string; commands: number; writes: number; replay: boolean }): void => {
    console.log(`seed: ${r.name} game=${r.gameId} code=${r.roomCode} commands=${r.commands} writes=${r.writes} replay=${r.replay}`);
  };
  if (args.kind === "all") {
    let writes = 0;
    for (const r of await seedCatalogue()) {
      report(r);
      writes += r.writes;
    }
    console.log(`seed: catalogue fixtures=${CATALOGUE.length} writes=${writes}`);
    return 0;
  }
  const started = performance.now();
  const r = await seedFixture(args.fixture);
  report(r);
  console.log(`seed: fixture ${r.name} ms=${Math.round(performance.now() - started)}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));