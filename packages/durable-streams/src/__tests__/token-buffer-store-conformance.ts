import { run } from "effection";
import { describe, expect, it } from "vitest";

import type { TokenBufferStore } from "../types.ts";
import { appendTestTokens, completeTestBuffer } from "./test-writer.ts";

export function defineTokenBufferStoreConformance(
  name: string,
  createStore: () => TokenBufferStore<string>,
  beforeTest: (skip: (note?: string) => never) => void = () => {},
): void {
  describe(`${name} TokenBufferStore conformance`, () => {
    it("bounds batches while preserving the tail and reconnect offset", async ({ skip }) => {
      beforeTest(skip);
      const buffer = await run(() => createStore().create(`${name}-bounded-read`));
      await run(() => appendTestTokens(buffer, ["a", "b", "c", "d", "e"]));
      expect(await run(() => buffer.read(1, 2))).toEqual({ tokens: ["b", "c"], lsn: 5 });
      expect(await run(() => buffer.read(3, 2))).toEqual({ tokens: ["d", "e"], lsn: 5 });
      expect(await run(() => buffer.read(5, 2))).toEqual({ tokens: [], lsn: 5 });
    });

    it("uses 1-indexed total-length tail semantics for append/read", async ({ skip }) => {
      beforeTest(skip);
      const store = createStore();
      const buffer = await run(() => store.create(`${name}-tail-semantics`));

      expect(await run(() => appendTestTokens(buffer, ["a", "b", "c"]))).toBe(3);

      const all = await run(() => buffer.read(0));
      expect(all.tokens).toEqual(["a", "b", "c"]);
      expect(all.lsn).toBe(3);

      const fromTwo = await run(() => buffer.read(2));
      expect(fromTwo.tokens).toEqual(["c"]);
      expect(fromTwo.lsn).toBe(3);

      const pastTail = await run(() => buffer.read(10));
      expect(pastTail.tokens).toEqual([]);
      expect(pastTail.lsn).toBe(3);
    });

    it("rejects stale writer mutations after an activation replacement", async ({ skip }) => {
      beforeTest(skip);
      const store = createStore();
      const buffer = await run(() => store.create(`${name}-writer-fence`));
      const first = await run(() => buffer.claimWriter({ ownerId: "owner-a", activationEpoch: 1 }));

      expect(await run(() => first.append(["a"]))).toBe(1);
      const replacement = await run(() =>
        buffer.claimWriter({ ownerId: "owner-b", activationEpoch: 2 }),
      );

      await expect(run(() => first.append(["stale"]))).rejects.toMatchObject({
        code: "stale_token_writer",
      });
      await expect(run(() => first.complete())).rejects.toMatchObject({
        code: "stale_token_writer",
      });
      await expect(run(() => first.fail(new Error("stale")))).rejects.toMatchObject({
        code: "stale_token_writer",
      });
      expect(await run(() => replacement.append(["b"]))).toBe(2);
      expect(await run(() => buffer.read(0))).toEqual({ tokens: ["a", "b"], lsn: 2 });
    });

    it("keeps the first terminal state immutable", async ({ skip }) => {
      beforeTest(skip);
      const store = createStore();
      const completed = await run(() => store.create(`${name}-terminal-complete`));
      const completedWriter = await run(() =>
        completed.claimWriter({ ownerId: "owner", activationEpoch: 1 }),
      );
      await run(() => completedWriter.complete());
      await run(() => completedWriter.fail(new Error("must-not-replace-completion")));
      expect(await run(() => completed.isComplete())).toBe(true);
      expect(await run(() => completed.getError())).toBeNull();

      const failed = await run(() => store.create(`${name}-terminal-failed`));
      const failedWriter = await run(() =>
        failed.claimWriter({ ownerId: "owner", activationEpoch: 1 }),
      );
      await run(() => failedWriter.fail(new Error("first-failure")));
      await run(() => failedWriter.complete());
      expect((await run(() => failed.getError()))?.message).toBe("first-failure");

      const bounded = await run(() => store.create(`${name}-bounded-error`));
      const boundedWriter = await run(() =>
        bounded.claimWriter({ ownerId: "owner", activationEpoch: 1 }),
      );
      await run(() => boundedWriter.fail(new Error("x".repeat(2_000))));
      expect((await run(() => bounded.getError()))?.message).toHaveLength(1_024);
    });

    it("returns from waitForChange when the tail is already ahead of afterLSN", async ({
      skip,
    }) => {
      beforeTest(skip);
      const store = createStore();
      const buffer = await run(() => store.create(`${name}-wait-already-ahead`));

      await run(() => appendTestTokens(buffer, ["a"]));

      await run(() => buffer.waitForChange(0));
    });

    it("unblocks waitForChange when new data arrives after the current tail", async ({ skip }) => {
      beforeTest(skip);
      const store = createStore();
      const buffer = await run(() => store.create(`${name}-wait-new-data`));

      await run(() => appendTestTokens(buffer, ["a"]));
      const waitForChangePromise = run(() => buffer.waitForChange(1));

      await new Promise((resolve) => setTimeout(resolve, 20));
      await run(() => appendTestTokens(buffer, ["b"]));

      await waitForChangePromise;
      const result = await run(() => buffer.read(1));
      expect(result.tokens).toEqual(["b"]);
      expect(result.lsn).toBe(2);
    });

    it("unblocks waitForChange when the buffer completes without new data", async ({ skip }) => {
      beforeTest(skip);
      const store = createStore();
      const buffer = await run(() => store.create(`${name}-wait-complete`));

      const waitForChangePromise = run(() => buffer.waitForChange(0));

      await new Promise((resolve) => setTimeout(resolve, 20));
      await run(() => completeTestBuffer(buffer));

      await waitForChangePromise;
      expect(await run(() => buffer.isComplete())).toBe(true);
    });
  });
}
