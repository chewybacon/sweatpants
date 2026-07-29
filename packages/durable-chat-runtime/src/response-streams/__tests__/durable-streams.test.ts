import { appendTestTokens, completeTestBuffer, failTestBuffer } from "./test-writer.ts";
/**
 * Durable Streams Tests
 *
 * These tests validate the design of the durable streams system by
 * testing the in-memory implementations and core scenarios:
 *
 * 1. Basic write/read flow
 * 2. Durable buffer-store identity
 * 3. Demand-pulled reads and reconnect offsets
 */
import { describe, it, expect } from "./vitest-effection.ts";
import type { Subscription } from "effection";
import type { TokenFrame } from "@sweatpants/durable-streams";
import { createInMemoryBuffer, createInMemoryBufferStore, createPullStream } from "./test-utils.ts";

// =============================================================================
// TESTS
// =============================================================================

describe("Durable Streams", () => {
  describe("TokenBuffer", () => {
    it("should append and read tokens", function* () {
      const buffer = createInMemoryBuffer<string>("test-1");

      yield* appendTestTokens(buffer, ["hello", "world"]);
      const { tokens, lsn } = yield* buffer.read();

      expect(tokens).toEqual(["hello", "world"]);
      expect(lsn).toBe(2);
    });

    it("should read tokens after a specific LSN", function* () {
      const buffer = createInMemoryBuffer<string>("test-2");

      yield* appendTestTokens(buffer, ["a", "b", "c", "d"]);
      const { tokens, lsn } = yield* buffer.read(2);

      expect(tokens).toEqual(["c", "d"]);
      expect(lsn).toBe(4);
    });

    it("should track completion status", function* () {
      const buffer = createInMemoryBuffer<string>("test-3");

      expect(yield* buffer.isComplete()).toBe(false);

      yield* completeTestBuffer(buffer);

      expect(yield* buffer.isComplete()).toBe(true);
    });

    it("should track error status", function* () {
      const buffer = createInMemoryBuffer<string>("test-4");

      expect(yield* buffer.getError()).toBe(null);

      const error = new Error("test error");
      yield* failTestBuffer(buffer, error);

      expect(yield* buffer.getError()).toBe(error);
    });

    it("should not allow appending after completion", function* () {
      const buffer = createInMemoryBuffer<string>("test-5");

      yield* completeTestBuffer(buffer);

      let threw = false;
      try {
        yield* appendTestTokens(buffer, ["too late"]);
      } catch {
        threw = true;
      }

      expect(threw).toBe(true);
    });
  });

  describe("TokenBufferStore", () => {
    it("should create and retrieve buffers", function* () {
      const store = createInMemoryBufferStore<string>();

      const buffer = yield* store.create("session-1");
      yield* appendTestTokens(buffer, ["test"]);

      const retrieved = yield* store.get("session-1");
      expect(retrieved).not.toBe(null);

      const { tokens } = yield* retrieved!.read();
      expect(tokens).toEqual(["test"]);
    });

    it("should return null for non-existent buffers", function* () {
      const store = createInMemoryBufferStore<string>();

      const buffer = yield* store.get("does-not-exist");
      expect(buffer).toBe(null);
    });

    it("should delete buffers", function* () {
      const store = createInMemoryBufferStore<string>();

      yield* store.create("to-delete");
      yield* store.delete("to-delete");

      const buffer = yield* store.get("to-delete");
      expect(buffer).toBe(null);
    });
  });

  describe("PullStream", () => {
    it("should read tokens as they become available", function* () {
      const buffer = createInMemoryBuffer<string>("pull-1");
      const pullStream: Subscription<TokenFrame<string>, void> = yield* createPullStream(buffer);

      // Append some tokens
      yield* appendTestTokens(buffer, ["one", "two"]);

      // Read them
      const result1 = yield* pullStream.next();
      expect(result1.done).toBe(false);
      expect((result1.value as TokenFrame<string>).token).toBe("one");

      const result2 = yield* pullStream.next();
      expect(result2.done).toBe(false);
      expect((result2.value as TokenFrame<string>).token).toBe("two");

      // Complete the buffer
      yield* completeTestBuffer(buffer);

      // Should get done
      const result3 = yield* pullStream.next();
      expect(result3.done).toBe(true);
    });

    it("should start from a specific LSN", function* () {
      const buffer = createInMemoryBuffer<string>("pull-2");

      yield* appendTestTokens(buffer, ["a", "b", "c", "d"]);
      yield* completeTestBuffer(buffer);

      // Start from LSN 2 (skip 'a', 'b')
      const pullStream: Subscription<TokenFrame<string>, void> = yield* createPullStream(buffer, 2);

      const result1 = yield* pullStream.next();
      expect((result1.value as TokenFrame<string>).token).toBe("c");

      const result2 = yield* pullStream.next();
      expect((result2.value as TokenFrame<string>).token).toBe("d");

      const result3 = yield* pullStream.next();
      expect(result3.done).toBe(true);
    });

    it("should return correct LSN with each token", function* () {
      const buffer = createInMemoryBuffer<string>("pull-lsn");

      yield* appendTestTokens(buffer, ["a", "b", "c"]);
      yield* completeTestBuffer(buffer);

      const pullStream: Subscription<TokenFrame<string>, void> = yield* createPullStream(buffer);

      const result1 = yield* pullStream.next();
      expect((result1.value as TokenFrame<string>).token).toBe("a");
      expect((result1.value as TokenFrame<string>).lsn).toBe(1);

      const result2 = yield* pullStream.next();
      expect((result2.value as TokenFrame<string>).token).toBe("b");
      expect((result2.value as TokenFrame<string>).lsn).toBe(2);

      const result3 = yield* pullStream.next();
      expect((result3.value as TokenFrame<string>).token).toBe("c");
      expect((result3.value as TokenFrame<string>).lsn).toBe(3);

      const result4 = yield* pullStream.next();
      expect(result4.done).toBe(true);
    });

    it("should return correct LSN when starting from offset", function* () {
      const buffer = createInMemoryBuffer<string>("pull-lsn-offset");

      yield* appendTestTokens(buffer, ["a", "b", "c", "d", "e"]);
      yield* completeTestBuffer(buffer);

      // Start from LSN 3 (skip 'a', 'b', 'c')
      const pullStream: Subscription<TokenFrame<string>, void> = yield* createPullStream(buffer, 3);

      const result1 = yield* pullStream.next();
      expect((result1.value as TokenFrame<string>).token).toBe("d");
      expect((result1.value as TokenFrame<string>).lsn).toBe(4);

      const result2 = yield* pullStream.next();
      expect((result2.value as TokenFrame<string>).token).toBe("e");
      expect((result2.value as TokenFrame<string>).lsn).toBe(5);
    });
  });
});
