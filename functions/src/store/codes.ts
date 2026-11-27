// Room codes and host player ids from the command seed (LLD 3 sections 2.4 and 6.1, #34). Both are pure and deterministic: the attempt loop draws one
// seed, and domain-separated hashes of it give the 4-letter code and the host's `p_`+8 player id. The room code is drawn by rejection sampling over the
// 20-consonant alphabet so no letter is more likely than another (256 is not a multiple of 20).
import { createHash } from "node:crypto";
import { PlayerIdSchema, RoomCodeSchema } from "@dc/contracts";
import type { PlayerId } from "@dc/contracts";

export const ROOM_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const ROOM_CODE_LENGTH = 4;
/** The largest multiple of the alphabet size that fits a byte: bytes at or above it are skipped, not wrapped (no modulo bias). */
const ROOM_CODE_LIMIT = 240;
/** Bytes drawn per hash block: the code needs at most 4, and a skipped byte just pulls the next block. */
const BLOCK_BYTES = 16;

/** The bytes `roomCodeFromSeed` draws from. Injecting one is the seam for the rejection-sampling test. */
export type ByteSource = (count: number) => Uint8Array;

/** A deterministic stream of hash blocks: block n is sha256(label, seed, n). Same seed, same code. */
function hashedBlocks(label: string, seed: string): ByteSource {
  let block = 0;
  return (count) => {
    const digest = createHash("sha256").update(`${label}\u0000${seed}\u0000${block++}`).digest();
    return new Uint8Array(digest.subarray(0, Math.min(Math.max(count, 1), digest.length)));
  };
}

/** `roomCodeFromSeed(seed)`: 4 letters from ROOM_CODE_ALPHABET, uniform by rejection sampling, always `RoomCodeSchema`-valid. */
export function roomCodeFromSeed(seed: string, bytes: ByteSource = hashedBlocks("roomcode", seed)): string {
  let out = "";
  let buf: Uint8Array = new Uint8Array(0);
  let i = 0;
  while (out.length < ROOM_CODE_LENGTH) {
    if (i >= buf.length) {
      buf = bytes(Math.max(BLOCK_BYTES, ROOM_CODE_LENGTH - out.length));
      i = 0;
      if (buf.length === 0) throw new Error("roomCodeFromSeed: the byte source returned nothing");
    }
    const b = buf[i++] as number;
    if (b >= ROOM_CODE_LIMIT) continue;
    out += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length];
  }
  return RoomCodeSchema.parse(out);
}

const PLAYER_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** `playerIdFromSeed(seed)`: `p_` + 8 of [a-z2-7], from the first 40 bits of a domain-separated hash (32 symbols divide 256, so no rejection). */
export function playerIdFromSeed(seed: string): PlayerId {
  const digest = createHash("sha256").update(`playerId\u0000${seed}`).digest();
  let bits = 0n;
  for (let k = 0; k < 5; k++) bits = (bits << 8n) | BigInt(digest[k] as number);
  let out = "p_";
  for (let k = 0; k < 8; k++) {
    const index = Number((bits >> BigInt(5 * (7 - k))) & 31n);
    out += PLAYER_ID_ALPHABET[index];
  }
  return PlayerIdSchema.parse(out);
}
