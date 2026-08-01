import { run, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import {
  createInMemoryBufferStore,
  type TokenBuffer,
  type TokenBufferStore,
} from "@sweatpants/durable-streams";
import {
  getConversationCheckpointAlternateId,
  getConversationCheckpointId,
  readLatestConversationCheckpoint,
  recordConversationCheckpoint,
} from "../conversation-index.ts";

function pointer(buffer: TokenBuffer<string>): Operation<string> {
  return (function* () {
    let latest: { token: string | undefined; lsn: number };
    if (buffer.readLatest) {
      latest = yield* buffer.readLatest();
    } else {
      const { tokens } = yield* buffer.read(0);
      latest = { token: tokens.at(-1), lsn: 0 };
    }
    if (!latest.token) {
      throw new Error("checkpoint pointer is empty");
    }
    return latest.token;
  })();
}

describe("conversation checkpoint storage", () => {
  it("publishes immutable versions and compacts the previous pointer", async () => {
    const store = createInMemoryBufferStore<string>();

    await run(function* () {
      yield* recordConversationCheckpoint(store, "conversation-1", "checkpoint-1");
      yield* recordConversationCheckpoint(store, "conversation-1", "checkpoint-2");

      expect(yield* readLatestConversationCheckpoint(store, "conversation-1")).toBe("checkpoint-2");
      expect(yield* store.get(getConversationCheckpointId("conversation-1"))).toBeNull();
      const alternate = yield* store.get(getConversationCheckpointAlternateId("conversation-1"));
      expect(alternate).not.toBeNull();
      const versionId = JSON.parse(yield* pointer(alternate!)).versionId as string;
      const version = yield* store.get(versionId);
      expect(version).not.toBeNull();
      expect(yield* version!.read(0)).toMatchObject({ tokens: ["checkpoint-2"] });
    });
  });

  it("deletes and recreates an errored incomplete pointer buffer", async () => {
    const base = createInMemoryBufferStore<string>();
    const checkpointId = getConversationCheckpointId("conversation-errored");
    let first = true;
    let deletes = 0;
    const errored: TokenBuffer<string> = {
      id: checkpointId,
      *claimWriter(): Operation<never> {
        throw new Error("errored pointer must be replaced before claiming");
      },
      *read(): Operation<{ tokens: string[]; lsn: number }> {
        return { tokens: [], lsn: 0 };
      },
      *isComplete(): Operation<boolean> {
        return false;
      },
      *getError(): Operation<Error | null> {
        return new Error("pointer write failed");
      },
      *waitForChange(): Operation<void> {},
    };
    const store: TokenBufferStore<string> = {
      *get(id) {
        if (first && id === checkpointId) {
          return errored;
        }
        return yield* base.get(id);
      },
      *create(id) {
        return yield* base.create(id);
      },
      *delete(id) {
        if (id === checkpointId) {
          first = false;
          deletes += 1;
        }
        yield* base.delete(id);
      },
    };

    await run(function* () {
      yield* recordConversationCheckpoint(store, "conversation-errored", "checkpoint-recovered");
      expect(deletes).toBe(1);
      expect(yield* readLatestConversationCheckpoint(store, "conversation-errored")).toBe(
        "checkpoint-recovered",
      );
    });
  });
});
