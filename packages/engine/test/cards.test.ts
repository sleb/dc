import { describe, expect, test } from "bun:test";
import { CardIdSchema } from "@dc/contracts";
import { EngineInvariantError } from "../src/errors";
import { MINT_ATTEMPTS, mintCardId } from "../src/rules/cards";
import { cid, counterMintId } from "./support/factories";

describe("V5 mintCardId", () => {
  test("returns the port's id when it is free", () => {
    const mint = counterMintId(7);
    expect(mintCardId({ mintId: mint }, {})).toBe(cid(7));
  });

  test("ids are c_ plus 10 characters of [a-z0-9]", () => {
    const id = mintCardId({ mintId: counterMintId(123456) }, {});
    expect(id).toMatch(/^c_[a-z0-9]{10}$/);
    expect(CardIdSchema.safeParse(id).success).toBe(true);
  });

  test("re-calls the port on a collision with the registry", () => {
    const cards = { [cid(1)]: { kind: "red" as const, text: "a" }, [cid(2)]: { kind: "green" as const, text: "b" } };
    let calls = 0;
    const mint = counterMintId(1);
    expect(mintCardId({ mintId: () => { calls++; return mint(); } }, cards)).toBe(cid(3));
    expect(calls).toBe(3);
  });

  test("gives up after 16 colliding attempts with an EngineInvariantError", () => {
    expect(MINT_ATTEMPTS).toBe(16);
    let calls = 0;
    const cards = { [cid(1)]: { kind: "red" as const, text: "a" } };
    expect(() => mintCardId({ mintId: () => { calls++; return cid(1); } }, cards)).toThrow(EngineInvariantError);
    expect(calls).toBe(16);
  });

  test("succeeds on the 16th attempt", () => {
    const cards = { [cid(1)]: { kind: "red" as const, text: "a" } };
    let calls = 0;
    expect(mintCardId({ mintId: () => (++calls < 16 ? cid(1) : cid(2)) }, cards)).toBe(cid(2));
  });

  test("a malformed id from the port is an invariant violation, not a retry", () => {
    let calls = 0;
    expect(() => mintCardId({ mintId: () => { calls++; return "nope"; } }, {})).toThrow(EngineInvariantError);
    expect(calls).toBe(1);
  });

  test("inherited object keys are not collisions", () => {
    expect(mintCardId({ mintId: counterMintId(1) }, {})).toBe(cid(1));
  });
});
