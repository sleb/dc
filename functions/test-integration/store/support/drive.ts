// A view-free driver for the store suites: every command goes through the harness (the production path in the Node bundle); the aggregate is read
// back with the Admin SDK only to choose the next command. Card text and names carry the P19 sentinels.
import type { Command } from "@dc/contracts";
import type { Actor, Game } from "@dc/engine";
import { cardText, playerName } from "../../../src/store/test-support";
import { create, db, run } from "./harness";
import type { RunRequest, RunResult } from "./harness";
import { seedCraftedGame } from "./crafted";
import type { CraftedOptions } from "./crafted";
import { HOST_NAME, newKey, pid, seatUid } from "./ids";

export class Table {
  private constructor(readonly gameId: string, readonly hostId: string) {}

  /** Writes a crafted state (the helper in `crafted.ts`) and drives it from there. */
  static async seed(game: Game, o: CraftedOptions = {}): Promise<Table> {
    await seedCraftedGame(db, game, o);
    return new Table(game.id, game.hostId);
  }

  /** Attach to a game seeded elsewhere (the cascade fixture writes its own aggregate and side rows). */
  static attach(gameId: string, hostId: string): Table {
    return new Table(gameId, hostId);
  }

  /** A fresh LOBBY game from the production createGame (#34), and n - 1 players joined through the harness. */
  static async lobby(n: number, o: { settings?: Record<string, unknown> } = {}): Promise<Table> {
    const hostId = `host-${crypto.randomUUID()}`;
    const created = await create({ hostId, hostName: HOST_NAME, idemKey: newKey(), ...(o.settings === undefined ? {} : { settings: o.settings }) });
    if (created.outcome.kind !== "accepted") throw new Error(`createGame rejected: ${JSON.stringify(created.outcome)}`);
    const t = new Table(created.outcome.gameId, hostId);
    for (let k = 1; k < n; k++) await t.join(k);
    return t;
  }

  /** A table of n driven through startGame and every player's writing into round 1. */
  static async playing(n: number): Promise<Table> {
    const t = await Table.lobby(n);
    await t.host({ type: "startGame" } as Command);
    await t.writeAll();
    return t;
  }

  async state(): Promise<Game> {
    const snap = await db.doc(`games/${this.gameId}`).get();
    const { store: _store, ...game } = snap.data() as Game & { store: unknown };
    return game as Game;
  }

  uidOf(k: number): string {
    return k === 0 ? this.hostId : seatUid(this.gameId, pid(k));
  }

  async run(actor: Actor, cmd: Command, extra: Partial<RunRequest> = {}): Promise<RunResult> {
    return run({ gameId: this.gameId, cmd, actor, idemKey: newKey(), ...extra });
  }

  /** Runs and requires an accept. */
  async ok(actor: Actor, cmd: Command, extra: Partial<RunRequest> = {}): Promise<RunResult> {
    const r = await this.run(actor, cmd, extra);
    if (r.outcome.kind !== "accepted") throw new Error(`${cmd.type} not accepted: ${JSON.stringify(r.outcome)}`);
    return r;
  }

  as(k: number, cmd: Command, extra?: Partial<RunRequest>): Promise<RunResult> {
    return this.ok({ kind: "user", uid: this.uidOf(k) }, cmd, extra);
  }

  host(cmd: Command, extra?: Partial<RunRequest>): Promise<RunResult> {
    return this.ok({ kind: "user", uid: this.hostId }, cmd, extra);
  }

  join(k: number, extra?: Partial<RunRequest>): Promise<RunResult> {
    return this.as(k, { type: "join", playerId: pid(k), name: playerName(k) } as Command, extra);
  }

  /** The full draft for one player's target (sentinel texts), with an optional tag. */
  async draftFor(p: { id: string; writeTarget: { red: number; green: number } | null }, tag = ""): Promise<{ red: string[]; green: string[] }> {
    const t = p.writeTarget ?? { red: 0, green: 0 };
    return {
      red: Array.from({ length: t.red }, (_, i) => cardText(p.id, "red", i) + tag),
      green: Array.from({ length: t.green }, (_, i) => cardText(p.id, "green", i) + tag),
    };
  }

  /** The full draft for the k-th joined seat (the host's seat has a createGame-derived id, so use `draftFor` for it). */
  async fullDraft(k: number, tag = ""): Promise<{ red: string[]; green: string[] }> {
    const p = (await this.state()).players.find((x) => x.id === pid(k));
    return this.draftFor(p ?? { id: pid(k), writeTarget: null }, tag);
  }

  /** Every writer saves a full draft and finishes; addressed by uid, so the host's derived player id works too. */
  async writeAll(): Promise<void> {
    for (const p of (await this.state()).players.filter((x) => x.status === "writing" && x.writeTarget !== null)) {
      await this.ok({ kind: "user", uid: p.uid }, { type: "saveDraft", ...(await this.draftFor(p)) } as Command);
      await this.ok({ kind: "user", uid: p.uid }, { type: "finishWriting" } as Command);
    }
  }

  indexOf(playerId: string): number {
    for (let k = 0; k < 64; k++) if (pid(k) === playerId) return k;
    throw new Error(`unknown player ${playerId}`);
  }

  /** Everyone owed submits their first hand card; closes the round if still open. */
  async submitAll(): Promise<void> {
    for (;;) {
      const g = await this.state();
      const r = g.round;
      if (g.phase !== "PLAYING" || g.paused || r === null || r.phase !== "SUBMITTING") return;
      const p = g.players.find((x) => x.status === "active" && r.roster.includes(x.id) && x.id !== r.judgeId && !r.submissions.some((s) => s.playerId === x.id) && x.hand.length > 0);
      if (p === undefined) {
        await this.host({ type: "closeSubmissions", expectedVersion: r.changedAtVersion } as Command);
        return;
      }
      await this.ok({ kind: "user", uid: p.uid }, { type: "confirmSubmission", cardId: p.hand[0], expectedVersion: r.changedAtVersion } as Command);
    }
  }

  /** The judge picks the first revealed card. */
  async pick(): Promise<RunResult> {
    const g = await this.state();
    const r = g.round;
    const judge = g.players.find((p) => p.id === r?.judgeId);
    if (r === null || r.phase !== "JUDGING" || judge === undefined) throw new Error("pick: not judging");
    return this.ok({ kind: "user", uid: judge.uid }, { type: "pickWinner", submissionId: r.revealOrder?.[0], expectedVersion: r.changedAtVersion } as Command);
  }

  async playRound(): Promise<RunResult> {
    await this.submitAll();
    return this.pick();
  }
}
