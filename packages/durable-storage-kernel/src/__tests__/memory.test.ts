import { run } from "effection";
import { describe, expect, it } from "vitest";
import { durableKey } from "../codec.ts";
import { DurableCollections } from "../collections.ts";
import { createMemoryDurableKernel } from "../memory.ts";

describe("memory durable kernel", () => {
  it("short-circuits an existing claim before authority guards", async () => {
    const kernel = createMemoryDurableKernel();
    await run(function* () {
      const claim = {
        name: "receipt",
        collection: DurableCollections.conversationCommandReceipts,
        key: durableKey("conversation", "command"),
        fingerprint: "digest",
        value: "receipt",
      } as const;
      expect(yield* kernel.apply({ claim, ensures: [] })).toMatchObject({ status: "committed" });
      expect(
        yield* kernel.apply({
          claim,
          ensures: [],
          authority: {
            name: "head",
            collection: DurableCollections.conversationHeads,
            key: durableKey("conversation"),
            expected: { revision: "99", fence: "99" },
            next: { revision: "100", fence: "99", value: "head" },
          },
        }),
      ).toMatchObject({ status: "claim_exists", claim: "receipt" });
    });
  });

  it("rolls back ensures when authority conflicts", async () => {
    const kernel = createMemoryDurableKernel();
    await run(function* () {
      const key = durableKey("conversation");
      yield* kernel.apply({
        ensures: [],
        authority: {
          name: "head",
          collection: DurableCollections.conversationHeads,
          key,
          expected: { revision: null, fence: null },
          next: { revision: "0", fence: "0", value: "head-0" },
        },
      });
      const immutableKey = durableKey("checkpoint");
      expect(
        yield* kernel.apply({
          ensures: [
            {
              name: "checkpoint",
              collection: DurableCollections.conversationCheckpoints,
              key: immutableKey,
              fingerprint: "hash",
              value: "checkpoint",
            },
          ],
          authority: {
            name: "head",
            collection: DurableCollections.conversationHeads,
            key,
            expected: { revision: "9", fence: "0" },
            next: { revision: "10", fence: "0", value: "head-10" },
          },
        }),
      ).toMatchObject({ status: "authority_conflict", mismatch: "revision" });
      expect(
        yield* kernel.readImmutable(DurableCollections.conversationCheckpoints, immutableKey),
      ).toBeNull();
    });
  });

  it("reuses equivalent alternate identities during staging", async () => {
    const kernel = createMemoryDurableKernel();
    await run(function* () {
      const alternate = durableKey("conversation", "cause");
      yield* kernel.apply({
        ensures: [
          {
            name: "first",
            collection: DurableCollections.conversationCheckpoints,
            key: durableKey("checkpoint-1"),
            alternateKeys: [alternate],
            fingerprint: "same",
            value: "one",
          },
        ],
      });
      const outcome = yield* kernel.apply({
        ensures: [
          {
            name: "second",
            collection: DurableCollections.conversationCheckpoints,
            key: durableKey("checkpoint-2"),
            alternateKeys: [alternate],
            fingerprint: "same",
            value: "two",
          },
        ],
      });
      expect(outcome).toMatchObject({
        status: "committed",
        ensured: { second: { key: durableKey("checkpoint-1") } },
      });
      expect(
        yield* kernel.apply({
          ensures: [
            {
              name: "publication-checkpoint",
              collection: DurableCollections.conversationCheckpoints,
              key: durableKey("checkpoint-2"),
              alternateKeys: [alternate],
              fingerprint: "same",
              value: "two",
            },
          ],
          authority: {
            name: "head",
            collection: DurableCollections.conversationHeads,
            key: durableKey("conversation"),
            expected: { revision: null, fence: null },
            next: { revision: "0", fence: "0", value: "head" },
          },
        }),
      ).toMatchObject({ status: "immutable_conflict", write: "publication-checkpoint" });
    });
  });
});
