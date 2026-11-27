// Test-only (#33): an in-memory driver over the real `decide`, for the Store's unit tests and for the integration suites that seed a game built in Bun
// (a `departed40`-shaped game, a long game for removeCard). Imported only from tests, so it is never in the bundle (the entry does not reach it).
// Card text and names carry the P19 sentinels (CARD-SENTINEL-*, NAME-SENTINEL-*).
import type { Command, PlayerId } from "@dc/contracts";
import { decide, makeRng, seatUid } from "@dc/engine";
import type { Accepted, Actor, Draft, Game, GameDrafts } from "@dc/engine";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
export const pid = (n: number): PlayerId => `p_aaaaaa${B32[Math.floor(n / 32) % 32] ?? "a"}${B32[n % 32] ?? "a"}`;
export const cardText = (p: PlayerId, color: "red" | "green", k: number): string => `CARD-SENTINEL-${p}-${color}-${k}`;
export const playerName = (k: number): string => `NAME-SENTINEL-${k}`;

export interface MemStep { prev: Game; next: Game; cmd: Command; actor: Actor; accepted: Accepted; now: number; seed: string; drafts: GameDrafts }

/** A game in memory: the state, the drafts documents, a deterministic clock, seed and card-id counter. */
export class MemGame {
  game: Game;
  drafts: Record<PlayerId, Draft> = {};
  now: number;
  private n = 0;
  private card = 1;
  readonly steps: MemStep[] = [];

  private constructor(game: Game, now: number) {
    this.game = game;
    this.now = now;
  }

  static create(o: { gameId?: string; hostId?: string; roomCode?: string; now?: number; settings?: Record<string, unknown> } = {}): MemGame {
    const gameId = o.gameId ?? "gMemGame000000000001";
    const hostId = o.hostId ?? "host-uid";
    const now = o.now ?? 1_000_000;
    const cmd = { type: "createGame", gameId, roomCode: o.roomCode ?? "BCDF", hostId, hostPlayerId: pid(0), hostName: playerName(0), ...(o.settings ? { settings: o.settings } : {}) } as Command;
    const res = decide(null, cmd, { now, rng: makeRng("create"), mintId: () => "c_0000000000", actor: { kind: "user", uid: hostId }, drafts: {} });
    if (!res.ok) throw new Error(`createGame: ${res.error.code}`);
    return new MemGame(res.value.state, now);
  }

  uidOf(k: number): string {
    return k === 0 ? this.game.hostId : seatUid(this.game.id, pid(k));
  }

  mintId = (): string => `c_${(this.card++).toString(36).padStart(10, "0")}`;

  /** Runs one command; throws on a rejection unless `allowReject`. */
  run(actor: Actor, cmd: Command, o: { now?: number; allowReject?: boolean } = {}): MemStep | null {
    this.now = o.now ?? this.now + 1_000;
    const seed = `mem:${this.n++}`;
    const drafts: GameDrafts = { ...this.drafts };
    const res = decide(this.game, cmd, { now: this.now, rng: makeRng(seed), mintId: this.mintId, actor, drafts });
    if (!res.ok) {
      if (o.allowReject === true) return null;
      throw new Error(`${cmd.type} rejected: ${res.error.code}${res.error.detail ? ` ${res.error.detail}` : ""}`);
    }
    const a = res.value;
    for (const c of a.draftChanges) {
      if (c.draft === null) delete this.drafts[c.playerId];
      else this.drafts[c.playerId] = c.draft;
    }
    const step: MemStep = { prev: this.game, next: a.state, cmd, actor, accepted: a, now: this.now, seed, drafts };
    this.game = a.state;
    this.steps.push(step);
    return step;
  }

  as(k: number, cmd: Command, o?: { now?: number; allowReject?: boolean }): MemStep | null {
    return this.run({ kind: "user", uid: this.uidOf(k) }, cmd, o);
  }

  host(cmd: Command, o?: { now?: number; allowReject?: boolean }): MemStep | null {
    return this.run({ kind: "user", uid: this.game.hostId }, cmd, o);
  }

  join(k: number): MemStep | null {
    return this.as(k, { type: "join", playerId: pid(k), name: playerName(k) } as Command);
  }

  /** Seats players 1..n-1 (the host is 0). */
  joinAll(n: number): this {
    for (let k = 1; k < n; k++) this.join(k);
    return this;
  }

  start(): MemStep | null {
    return this.host({ type: "startGame" } as Command);
  }

  /** The draft a writer saves to meet their full target (sentinel texts). */
  fullDraft(p: PlayerId, tag = ""): Draft {
    const seat = this.game.players.find((x) => x.id === p);
    const t = seat?.writeTarget ?? { red: 0, green: 0 };
    return { red: Array.from({ length: t.red }, (_, k) => cardText(p, "red", k) + tag), green: Array.from({ length: t.green }, (_, k) => cardText(p, "green", k) + tag) };
  }

  /** Every writer saves the full draft and finishes. */
  writeAll(): this {
    for (const p of this.game.players.filter((x) => x.status === "writing" && x.writeTarget !== null)) {
      this.run({ kind: "user", uid: p.uid }, { type: "saveDraft", ...this.fullDraft(p.id) } as Command);
      this.run({ kind: "user", uid: p.uid }, { type: "finishWriting" } as Command);
    }
    return this;
  }

  /** Submits for everyone owed and closes the round if it is still open; leaves it JUDGING. */
  submitAll(): void {
    if (this.game.phase !== "PLAYING" || this.game.paused) return;
    for (const p of this.game.players) {
      const r = this.game.round;
      if (r === null || r.phase !== "SUBMITTING") break;
      if (p.status !== "active" || !r.roster.includes(p.id) || p.id === r.judgeId || r.submissions.some((s) => s.playerId === p.id) || p.hand.length === 0) continue;
      this.run({ kind: "user", uid: p.uid }, { type: "confirmSubmission", cardId: p.hand[0], expectedVersion: r.changedAtVersion } as Command);
    }
    const r1 = this.game.round;
    if (r1 !== null && r1.phase === "SUBMITTING") this.host({ type: "closeSubmissions", expectedVersion: r1.changedAtVersion } as Command);
  }

  /** Submits for everyone owed, closes if needed, and picks the first revealed card. Returns false when no round is open. */
  playRound(): boolean {
    if (this.game.phase !== "PLAYING" || this.game.round === null || this.game.paused) return false;
    this.submitAll();
    const r2 = this.game.round;
    if (r2 === null || r2.phase !== "JUDGING") return this.game.round !== null;
    const judge = this.game.players.find((p) => p.id === r2.judgeId);
    const pick = r2.revealOrder?.[0];
    if (judge === undefined || pick === undefined) throw new Error("playRound: no judge or no reveal");
    this.run({ kind: "user", uid: judge.uid }, { type: "pickWinner", submissionId: pick, expectedVersion: r2.changedAtVersion } as Command);
    return true;
  }

  /** A seated game of n players driven into PLAYING (round 1 open). */
  static playing(n: number, o: Parameters<typeof MemGame.create>[0] = {}): MemGame {
    const m = MemGame.create(o).joinAll(n);
    m.start();
    m.writeAll();
    if (m.game.phase !== "PLAYING") throw new Error(`playing: phase ${m.game.phase}`);
    return m;
  }

  /**
   * The `departed40` shape of LLD 3 section 10.1, in WRITING: 50 joins (the cap), 40 departed, 10 seated, the host unseated (their seat left), so
   * `viewersOf` names 52 docs: 10 seated, the unseated host, the spectator doc, 40 tombstones (LLD 3 section 5.7's worst case). Departures are after
   * `startGame` because a LOBBY leaver leaves no record.
   */
  static departed40(o: Parameters<typeof MemGame.create>[0] = {}): MemGame {
    const m = MemGame.create(o).joinAll(10);
    m.start();
    m.host({ type: "leave" } as Command);
    for (let k = 10; k < 50; k++) {
      m.join(k);
      m.as(k, { type: "leave" } as Command);
    }
    m.join(50);
    return m;
  }
}

/** A copy of `game` whose history repeats its first resolved round until it holds `rounds` entries (numbered 1..rounds), so one card is in every round. */
export function withRepeatedHistory(game: Game, rounds: number): Game {
  const first = game.history[0];
  if (first === undefined) throw new Error("withRepeatedHistory: no resolved round");
  return { ...game, history: Array.from({ length: rounds }, (_, k) => ({ ...first, round: k + 1 })) };
}

