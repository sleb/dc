import { describe, expect, test } from "bun:test";
import { findByRoomCode } from "./find";

// U7 (LLD 3 section 6.1): one `get` of roomCodes/{code}; normalization and validation happen before any read.
function fakeDb(docs: Record<string, Record<string, unknown>>) {
  let gets = 0;
  const paths: string[] = [];
  const db = {
    doc: (path: string) => ({
      path,
      get: async () => {
        gets++;
        paths.push(path);
        const data = docs[path] ?? null;
        return { exists: data !== null, data: () => data, ref: { path } };
      },
    }),
  };
  return { db, gets: () => gets, paths };
}

describe("U7 findByRoomCode", () => {
  test("a live code returns {gameId, createdAt} with exactly one get", async () => {
    const f = fakeDb({ "roomCodes/BCDF": { gameId: "gFind00000000000001", createdAt: 1_234 } });
    await expect(findByRoomCode(f.db as never, "BCDF")).resolves.toEqual({ gameId: "gFind00000000000001", createdAt: 1_234 });
    expect(f.gets()).toBe(1);
    expect(f.paths).toEqual(["roomCodes/BCDF"]);
  });

  test("lowercase and padded input resolve to the same one get", async () => {
    for (const input of ["bcdf", " BCDF ", "\tbcdf\n"]) {
      const f = fakeDb({ "roomCodes/BCDF": { gameId: "gFind00000000000001", createdAt: 1_234 } });
      await expect(findByRoomCode(f.db as never, input)).resolves.toEqual({ gameId: "gFind00000000000001", createdAt: 1_234 });
      expect(f.gets()).toBe(1);
    }
  });

  test("a malformed code is null before any read", async () => {
    for (const input of ["AAAA", "AEIO", "BC1F", "BCDFG", "BCD", "", "   "]) {
      const f = fakeDb({});
      await expect(findByRoomCode(f.db as never, input)).resolves.toBeNull();
      expect(f.gets()).toBe(0);
    }
  });

  test("a missing doc is null after one get", async () => {
    const f = fakeDb({});
    await expect(findByRoomCode(f.db as never, "ZZZZ")).resolves.toBeNull();
    expect(f.gets()).toBe(1);
  });
});
