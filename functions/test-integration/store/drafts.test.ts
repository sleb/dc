import { beforeAll, expect, test } from "bun:test";
import type { Command } from "@dc/contracts";
import { Table } from "./support/drive";
import { clear, db } from "./support/harness";
import { diff, snapshot, updateTimeOf } from "./support/inspect";
import { pid } from "./support/seed";

// I5 Draft path (LLD 3 section 5.6) and PJ10's draftSeq +1 clause against the real Store (the deferred proof recorded in #54).
beforeAll(clear);

test("I5 text-only saves touch only the drafts doc, the actor's draft region and the ledger; draftSeq +1 each; a count change bumps the version for every view; finishWriting clears", async () => {
  const t = await Table.lobby(3);
  await t.host({ type: "startGame" } as Command);
  const me = 1;
  const uid = t.uidOf(me);
  const view = () => db.doc(`games/${t.gameId}/views/${uid}`).get();
  const first = await t.as(me, { type: "saveDraft", ...(await t.fullDraft(me)) } as Command); // a count change
  expect(first.outcome.kind === "accepted" && !Object.hasOwn(first.outcome, "draftSeq")).toBe(true);
  expect((await view()).get("draftSeq")).toBe(1);
  const v = (await t.state()).version;

  const idemBefore = (await db.collection(`games/${t.gameId}/idem`).get()).size;
  let seq = 1;
  for (let i = 0; i < 30; i++) {
    const before = await snapshot(t.gameId);
    const r = await t.as(me, { type: "saveDraft", ...(await t.fullDraft(me, ` v${i}`)) } as Command);
    seq++;
    expect(r.outcome).toMatchObject({ kind: "accepted", version: v, draftSeq: seq });
    const after = await snapshot(t.gameId);
    const d = diff(before, after);
    expect(d.deleted).toEqual([]);
    expect(d.changed.sort()).toEqual([`games/${t.gameId}/drafts/${pid(me)}`, `games/${t.gameId}/views/${uid}`].sort());
    expect(d.created).toHaveLength(1); // the ledger row
    expect(d.created[0]).toContain("/idem/");
    expect(after.get(`games/${t.gameId}/views/${uid}`)?.data["draftSeq"]).toBe(seq); // PJ10: +1 per save, strictly increasing
    expect(after.get(`games/${t.gameId}/drafts/${pid(me)}`)?.data["seq"]).toBe(seq);
  }
  expect((await db.collection(`games/${t.gameId}/idem`).get()).size).toBe(idemBefore + 30);
  expect((await t.state()).version).toBe(v);

  // A count change: version +1, cardsLeft visible in every view, an events doc with events: [] (no domain event for a count change).
  const full = await t.fullDraft(me);
  const before = await snapshot(t.gameId);
  const r = await t.as(me, { type: "saveDraft", red: full.red.slice(1), green: full.green } as Command);
  expect(r.outcome).toMatchObject({ kind: "accepted", version: v + 1 });
  const after = await snapshot(t.gameId);
  const ev = after.get(`games/${t.gameId}/events/${v + 1}`);
  expect(ev?.data["events"]).toEqual([]);
  const views = [...after.entries()].filter(([p]) => p.includes("/views/") && p !== `games/${t.gameId}/views/${uid}`);
  for (const [p, d] of views) {
    expect(updateTimeOf(after, p)).not.toBe(updateTimeOf(before, p));
    const vw = d.data["view"] as { kind?: string; players?: { id: string; cardsLeft: { red: number; green: number } | null }[] } | null;
    if (vw?.players !== undefined) expect(vw.players.find((x) => x.id === pid(me))?.cardsLeft).not.toBeNull();
  }
  expect((await view()).get("draftSeq")).toBe(seq + 1);

  await t.as(me, { type: "saveDraft", ...full } as Command);
  await t.as(me, { type: "finishWriting" } as Command);
  expect((await db.doc(`games/${t.gameId}/drafts/${pid(me)}`).get()).exists).toBe(false);
  const done = await view();
  expect(done.get("draft")).toBeNull();
  expect(done.get("draftSeq")).toBe(seq + 3);
}, 180_000);
