import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createInMemoryBufferStore } from "@sweatpants/durable-streams";
import {
  getConversationCheckpointId,
  readLatestConversationCheckpoint,
  recordConversationCheckpoint,
} from "../conversation-index.ts";

describe("conversation checkpoint storage", () => {
  it("appends complete checkpoint versions without deleting the prior version", async () => {
    const store = createInMemoryBufferStore<string>();

    await run(function* () {
      yield* recordConversationCheckpoint(store, "conversation-1", "checkpoint-1");
      yield* recordConversationCheckpoint(store, "conversation-1", "checkpoint-2");

      const buffer = yield* store.get(getConversationCheckpointId("conversation-1"));
      expect(buffer).not.toBeNull();
      expect(yield* buffer!.read(0)).toMatchObject({
        tokens: ["checkpoint-1", "checkpoint-2"],
      });
      expect(yield* readLatestConversationCheckpoint(store, "conversation-1")).toBe("checkpoint-2");
    });
  });
});
