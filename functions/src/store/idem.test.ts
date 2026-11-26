import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { idemId } from "./idem";

// U1 (LLD 3 section 2.4): base64url(sha256(actorKey \0 key)), actorKey = uid | "system".
const ref = (actorKey: string, key: string) => createHash("sha256").update(`${actorKey}\u0000${key}`).digest("base64url");

test("U1 a user's id is base64url SHA-256 of uid NUL key", () => {
  expect(idemId({ kind: "user", uid: "u1" }, "k-1")).toBe(ref("u1", "k-1"));
  expect(idemId({ kind: "user", uid: "u1" }, "k-1")).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test("U1 the system actor's key is \"system\"", () => {
  expect(idemId({ kind: "system" }, "remind:writing:5")).toBe(ref("system", "remind:writing:5"));
});

test("U1 two actors reusing one key, and the NUL boundary, cannot collide", () => {
  expect(idemId({ kind: "user", uid: "a" }, "k")).not.toBe(idemId({ kind: "user", uid: "b" }, "k"));
  expect(idemId({ kind: "user", uid: "ab" }, "c")).not.toBe(idemId({ kind: "user", uid: "a" }, "bc"));
  expect(idemId({ kind: "user", uid: "system" }, "k")).toBe(idemId({ kind: "system" }, "k"));
});

test("U1 a join's key hash is used unchanged as the key (K-C): the id derives from the hash, not a raw key", () => {
  const keyHash = createHash("sha256").update("raw-join-key").digest("hex");
  expect(idemId({ kind: "user", uid: "seat:g:p" }, keyHash)).toBe(ref("seat:g:p", keyHash));
});
