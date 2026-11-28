// The fixture catalogue's names and fixed ids (LLD 3 sections 2.4 and 10.1, #37). No side effects: `scripts/seed.ts` imports this
// to parse its arguments and validate the environment before it loads the Firebase-bound fixture module.
import type { GameId, Uid } from "@dc/contracts";

export const FIXTURES = [
  "lobby3",
  "writing4",
  "submitting5",
  "judging6",
  "paused3",
  "finished6-votes",
  "ended4",
  "departed40",
  "viewsStale",
  "midsize10",
] as const;
export type FixtureName = (typeof FIXTURES)[number];

/** The CI catalogue: every fixture except the size one, whose ~900-command build is opt-in with `--fixture midsize10`. */
export const CATALOGUE: readonly FixtureName[] = FIXTURES.filter((n) => n !== "midsize10");

/** A fixed id is 20 alphanumeric characters, the shape a Firestore auto-id has (LLD 3 section 2.4, `GameIdSchema`). */
const ID_SUFFIX: Record<FixtureName, string> = {
  lobby3: "lobby3",
  writing4: "writing4",
  submitting5: "submitting5",
  judging6: "judging6",
  paused3: "paused3",
  "finished6-votes": "finished6",
  ended4: "ended4",
  departed40: "departed40",
  viewsStale: "viewsStale",
  midsize10: "midsize10",
};
const fxId = (name: FixtureName): GameId => `gFixture${ID_SUFFIX[name].padEnd(12, "0")}` as GameId;

export const FIXTURE_IDS: Record<FixtureName, GameId> = Object.fromEntries(FIXTURES.map((n) => [n, fxId(n)])) as Record<FixtureName, GameId>;
export const fixtureHostId = (name: FixtureName): Uid => `host-fixture-${name}`;
/** The host's createGame ledger key: a second build replays instead of creating another game. */
export const fixtureCreateKey = (name: FixtureName): string => `fx:${name}:create`;

/** The project every fixture client uses when the operator names none (the `emulators:exec --project` default). */
export const DEFAULT_EMULATOR_PROJECT = "demo-deepcuts";

/**
 * The one project the seed guard and every fixture client agree on (LLD 0 P1, LLD 3 section 10.1, #37): the CLI's
 * `GCLOUD_PROJECT` when it has the `demo-` prefix the guard accepts, else the suite default. A non-`demo-` value is never
 * honoured here, so a fixture can only ever write to an emulator project.
 */
export function harnessProject(env: Record<string, string | undefined> = process.env): string {
  const project = env["GCLOUD_PROJECT"];
  return project !== undefined && project.startsWith("demo-") ? project : DEFAULT_EMULATOR_PROJECT;
}