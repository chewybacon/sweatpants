import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest, uuidv7 } from "@sweatpants/foundation";
import { createMemoryConversationStore } from "@sweatpants/history-store/memory";
import type {
  ConversationHeadProposal,
  ConversationStore,
} from "@sweatpants/history-store/contract";
import { openBetterSqliteStorage } from "@sweatpants/storage-sqlite/better-sqlite3";
import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  acceptedPublicMessageFact,
  persistConversationCheckpoint,
  type ConversationCheckpointRequest,
} from "../conversation-persistence.ts";
import { withConversationStore } from "./with-conversation-store.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const idle: ConversationHeadProposal = {
  state: "idle",
  checkpoint: null,
  terminalHistory: null,
  activeLogicalTurnId: null,
  activeExecutionId: null,
  latestCompletedExecutionId: null,
  activeSegment: null,
  activeCommand: null,
  deletedAt: null,
  ownerTransition: { kind: "clear" },
};

function request(causeKey = "first"): ConversationCheckpointRequest {
  return {
    conversationId: "checkpoint-identity",
    causeKey,
    cause: { kind: "test", causeKey },
    roots: [acceptedPublicMessageFact({ id: "message-1", role: "user", content: "Pick a card" })],
    proposal: idle,
    createdAt: 1,
  };
}

describe("conversation checkpoint identity", () => {
  it("reuses the committed UUID after a lost acknowledgement and keeps content integrity separate", async () => {
    const store = createMemoryConversationStore();
    let loseAcknowledgement = true;
    const unreliable: ConversationStore = {
      ...store,
      *commitConversation(command) {
        const result = yield* store.commitConversation(command);
        if (loseAcknowledgement && result.status === "committed") {
          loseAcknowledgement = false;
          throw new Error("checkpoint acknowledgement lost");
        }
        return result;
      },
    };
    await run(function* () {
      yield* store.compareAndSwapHead("checkpoint-identity", null, null, idle);
      let failure: unknown;
      try {
        yield* withConversationStore(unreliable, () => persistConversationCheckpoint(request()));
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ message: "checkpoint acknowledgement lost" });
      const acceptedHead = yield* store.loadHead("checkpoint-identity");
      if (!acceptedHead?.checkpoint) {
        throw new Error("checkpoint was not committed");
      }
      const accepted = yield* store.getCheckpoint(acceptedHead.checkpoint);
      if (!accepted) {
        throw new Error("committed checkpoint is absent");
      }
      expect(accepted.checkpointId).toMatch(uuidPattern);
      expect(accepted.lineageId).toMatch(uuidPattern);
      expect(accepted.contentHash).toBe(canonicalDigest(accepted.payload));

      const retry = yield* withConversationStore(store, () =>
        persistConversationCheckpoint({ ...request(), createdAt: 2 }),
      );
      expect(retry.checkpoint).toEqual(accepted);
      expect(retry.head.checkpoint).toEqual(acceptedHead.checkpoint);

      const next = yield* withConversationStore(store, () =>
        persistConversationCheckpoint(request("second")),
      );
      expect(next.checkpoint.checkpointId).toMatch(uuidPattern);
      expect(next.checkpoint.checkpointId).not.toBe(accepted.checkpointId);
      expect(next.checkpoint.lineageId).toBe(accepted.lineageId);
      expect(next.checkpoint.contentHash).toBe(accepted.contentHash);
    });
  });

  it("returns the canonical checkpoint when another attempt has already staged the same cause", async () => {
    const store = createMemoryConversationStore();
    const acceptedId = uuidv7();
    const acceptedLineage = uuidv7();
    const staged: ConversationStore = {
      ...store,
      *commitConversation(command) {
        if (!command.checkpoint) {
          throw new Error("checkpoint is missing");
        }
        yield* store.putCheckpoint({
          ...command.checkpoint,
          checkpointId: acceptedId,
          lineageId: acceptedLineage,
          createdAt: 0,
        });
        return yield* store.commitConversation(command);
      },
    };
    await run(function* () {
      yield* store.compareAndSwapHead("checkpoint-identity", null, null, idle);
      const persisted = yield* withConversationStore(staged, () =>
        persistConversationCheckpoint(request()),
      );
      expect(persisted.head.checkpoint).toEqual({ checkpointId: acceptedId });
      expect(persisted.checkpoint).toMatchObject({
        checkpointId: acceptedId,
        lineageId: acceptedLineage,
        createdAt: 0,
      });
      expect(persisted.checkpoint).toEqual(
        yield* store.getCheckpoint({ checkpointId: acceptedId }),
      );
    });
  });

  it("restores checkpoint and lineage UUIDs after reopening SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "checkpoint-identity-"));
    const path = join(directory, "conversation.sqlite");
    const first = await run(() => openBetterSqliteStorage(path, { initialize: true }));
    try {
      const accepted = await run(function* () {
        yield* first.storage.conversationStore.compareAndSwapHead(
          "checkpoint-identity",
          null,
          null,
          idle,
        );
        return yield* withConversationStore(first.storage.conversationStore, () =>
          persistConversationCheckpoint(request()),
        );
      });
      await run(() => first.close());
      const reopened = await run(() => openBetterSqliteStorage(path));
      try {
        await run(function* () {
          const store = reopened.storage.conversationStore;
          const retry = yield* withConversationStore(store, () =>
            persistConversationCheckpoint(request()),
          );
          expect(retry.checkpoint).toEqual(accepted.checkpoint);
          const next = yield* withConversationStore(store, () =>
            persistConversationCheckpoint(request("second")),
          );
          expect(next.checkpoint.checkpointId).not.toBe(accepted.checkpoint.checkpointId);
          expect(next.checkpoint.lineageId).toBe(accepted.checkpoint.lineageId);
          expect(yield* store.getCheckpoint(next.head.checkpoint!)).toEqual(next.checkpoint);
        });
      } finally {
        await run(() => reopened.close());
      }
    } finally {
      await run(() => first.close());
      await rm(directory, { recursive: true, force: true });
    }
  });
});
