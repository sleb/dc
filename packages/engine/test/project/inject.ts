// #30: what the scenario generators cannot produce on their own. `writeIn`, `redraw` and `castVote` are unregistered (guard 0 rejects them, LLD 1 15.1), so no driver can reach a write-in submission,
// a spent redraw or a vote. This module (1) rewrites the texts a driver types to unique fixed-width sentinels (H2), and (2) decorates an after-state with the shapes of LLD 1 section 3 that already
// exist in types.ts (H4): `Submission.writeIn`, `powerUsage`, valid `Vote`s. A decorated state is checked, never fed back into `decide`, except by the tests that say so.
// When M7 registers the three commands the generators reach these states by themselves and the injector can be switched off (steps 7.2 to 7.4).
import type { Command } from "@dc/contracts";
import type { Game, Player, Vote } from "../../src/types";
import type { Driver } from "../support/scenario";

const KINDS = { R: "red card", G: "green card", P: "pitch" } as const;
export type SentinelKind = keyof typeof KINDS;

/** `R0007x`: a letter for the kind, four digits, `x`. Fixed width, so none is a substring of another, and Moderation leaves each of them as it is (checked for all 30000 in inject.test.ts). */
export function sentinel(kind: SentinelKind, n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 9999) throw new Error(`sentinel ${kind} ${n} out of range`);
  return `${kind}${String(n).padStart(4, "0")}x`;
}

/**
 * A driver whose commands carry sentinel texts: every `saveDraft` text and every `confirmSubmission` pitch is replaced by the next unused sentinel of its kind. Names keep the driver's
 * (they are public). One instance per scenario: the counters start at zero, so a scenario replays.
 */
export function sentinelDriver(inner: Driver): Driver {
  const next = { R: 0, G: 0, P: 0 };
  const take = (k: SentinelKind): string => sentinel(k, next[k]++);
  return (state, drafts, i) => {
    const e = inner(state, drafts, i);
    if (e === undefined) return e;
    const c = e.cmd as Command;
    if (c.type === "saveDraft") return { actor: e.actor, cmd: { ...c, red: c.red.map(() => take("R")), green: c.green.map(() => take("G")) } };
    if (c.type === "confirmSubmission" && c.pitch !== undefined) return { actor: e.actor, cmd: { ...c, pitch: take("P") } };
    return e;
  };
}

export type VariantKind = "writeIn" | "redraw" | "votes";
export interface Variant { game: Game; kinds: VariantKind[] }

/** A small deterministic mixer (no entropy source): the same (salt, k) always gives the same number. */
const mix = (salt: number, k: number): number => {
  let x = (Math.imul(salt + 1, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca6b)) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0;
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39) >>> 0;
  return (x ^ (x >>> 15)) >>> 0;
};

const seated = (p: Player): boolean => p.status === "writing" || p.status === "ready" || p.status === "active";

/**
 * The after-state with the variants decorated, or null when none applies. Write-in: a marker on some of the open round's submissions (at least one), their owners' `powerUsage.writeIn`, the variant switched on.
 * Redraw: `powerUsage.redraw` on some seated players. Votes: valid `Vote`s on resolved plays by players and one spectator (not for a voter's own play), People's Choice and spectator voting switched on.
 * Pure in (game, salt); the input is not touched.
 */
export function decorate(game: Game, salt: number): Variant | null {
  const g = structuredClone(game);
  const kinds: VariantKind[] = [];
  const playing = g.phase === "PLAYING" || g.phase === "FINISHED" || g.phase === "ENDED";
  if (g.phase === "PLAYING" && g.round !== null && g.round.submissions.length > 0) {
    const subs = g.round.submissions;
    const first = mix(salt, 1) % subs.length;
    subs.forEach((s, i) => {
      if (i !== first && mix(salt, 10 + i) % 2 === 0) return;
      s.writeIn = true;
      const owner = g.players.find((p) => p.id === s.playerId);
      if (owner !== undefined) owner.powerUsage = { ...owner.powerUsage, writeIn: true };
    });
    g.settings = { ...g.settings, variants: { ...g.settings.variants, writeIn: true } };
    kinds.push("writeIn");
  }
  if (playing && salt % 2 === 0) {
    const who = g.players.filter(seated);
    if (who.length > 0) {
      const first = mix(salt, 2) % who.length;
      who.forEach((p, i) => {
        if (i === first || mix(salt, 30 + i) % 2 === 0) p.powerUsage = { ...p.powerUsage, redraw: true };
      });
      g.settings = { ...g.settings, variants: { ...g.settings.variants, redraw: true } };
      kinds.push("redraw");
    }
  }
  if (playing && salt % 3 !== 2 && g.history.length > 0) {
    const added: Vote[] = [];
    const voters = [...g.players.map((p) => `p:${p.id}`), `s:spec-${salt % 5}`, `s:spec-${(salt + 1) % 5}`];
    const has = (voter: string, round: number): boolean => [...g.votes, ...added].some((v) => v.voter === voter && v.round === round);
    let n = 0;
    for (const h of g.history) {
      for (const [pi, play] of h.plays.entries()) {
        const voter = voters[mix(salt, 100 + n++) % voters.length] as string;
        if (has(voter, h.round) || voter === `p:${play.playerId}`) continue;
        if (added.length > 0 && mix(salt, 200 + pi + h.round) % 3 === 0) continue;
        added.push({ round: h.round, voter, cardId: play.cardId });
      }
    }
    if (added.length > 0) {
      g.votes = [...g.votes, ...added];
      g.settings = { ...g.settings, variants: { ...g.settings.variants, peoplesChoice: true }, spectators: { enabled: true, vote: true } };
      kinds.push("votes");
    }
  }
  return kinds.length === 0 ? null : { game: g, kinds };
}
