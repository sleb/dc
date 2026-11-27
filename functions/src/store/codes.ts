// Room codes and host player ids from the command seed (LLD 3 sections 2.4 and 6.1, #34). Typed stub for the red commit; the green commit implements it.
import type { PlayerId } from "@dc/contracts";

export const ROOM_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** The bytes `roomCodeFromSeed` draws from. Injecting one is the seam for the rejection-sampling test. */
export type ByteSource = (count: number) => Uint8Array;

export function roomCodeFromSeed(_seed: string, _bytes?: ByteSource): string {
  return "";
}

export function playerIdFromSeed(_seed: string): PlayerId {
  return "p_aaaaaaaa";
}
