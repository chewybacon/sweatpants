import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createInMemoryBuffer } from "../in-memory-store.ts";
import { createPullStream } from "../pull-stream.ts";
import type { TokenBuffer } from "../types.ts";

describe("pull stream batches", () => {
  it("bounds catch-up work and does no reads until demand arrives", async () => {
    await run(function* () {
      const buffer = createInMemoryBuffer<number>("backlog");
      const writer = yield* buffer.claimWriter({ ownerId: "test", activationEpoch: 1 });
      yield* writer.append(Array.from({ length: 10_000 }, (_, i) => i));
      yield* writer.complete();
      const reads: number[] = [];
      const observed: TokenBuffer<number> = {
        ...buffer,
        *read(cursor, limit) {
          expect(limit).toBeGreaterThan(0);
          expect(limit).toBeLessThanOrEqual(256);
          const result = yield* buffer.read(cursor, limit);
          reads.push(result.tokens.length);
          return result;
        },
      };
      const reader = yield* createPullStream(observed, 123);
      expect(reads).toEqual([]);
      for (let i = 123; i < 10_000; i++) {
        expect(yield* reader.next()).toEqual({ done: false, value: { token: i, lsn: i + 1 } });
        if (i === 124) expect(reads).toEqual([256]);
      }
      expect((yield* reader.next()).done).toBe(true);
      expect(reads.reduce((sum, count) => sum + count, 0)).toBe(9_877);
      expect(reads.length).toBeLessThanOrEqual(41);
    });
  });

  it("does not lose a final append racing with an empty read", async () => {
    await run(function* () {
      const buffer = createInMemoryBuffer<string>("terminal-race");
      const writer = yield* buffer.claimWriter({ ownerId: "test", activationEpoch: 1 });
      let firstRead = true;
      const raced: TokenBuffer<string> = {
        ...buffer,
        *read(cursor, limit) {
          const result = yield* buffer.read(cursor, limit);
          if (firstRead) {
            firstRead = false;
            yield* writer.append(["last"]);
            yield* writer.complete();
          }
          return result;
        },
      };
      const reader = yield* createPullStream(raced);
      expect(yield* reader.next()).toEqual({ done: false, value: { token: "last", lsn: 1 } });
      expect((yield* reader.next()).done).toBe(true);
    });
  });

  it("delivers buffered and newly appended tokens before reporting failure", async () => {
    await run(function* () {
      const buffer = createInMemoryBuffer<string>("failure");
      const writer = yield* buffer.claimWriter({ ownerId: "test", activationEpoch: 1 });
      yield* writer.append(["a", "b"]);
      const reader = yield* createPullStream(buffer);
      expect((yield* reader.next()).value).toEqual({ token: "a", lsn: 1 });
      yield* writer.append(["c"]);
      yield* writer.fail(new Error("source failed"));
      expect((yield* reader.next()).value).toEqual({ token: "b", lsn: 2 });
      expect((yield* reader.next()).value).toEqual({ token: "c", lsn: 3 });
      let failure: unknown;
      try {
        yield* reader.next();
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ name: "Error", message: "source failed" });
    });
  });
});
