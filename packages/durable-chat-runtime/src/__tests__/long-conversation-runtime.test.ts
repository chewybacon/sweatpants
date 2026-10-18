import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@sweatpants/foundation";
import { run } from "effection";
import { installConversationStore } from "@sweatpants/history-store/port";
import { describe, expect, it } from "vitest";
import { openBetterSqliteStorage } from "@sweatpants/storage-sqlite/better-sqlite3";
import type {
  ConversationHead,
  ConversationStore,
  StoredCheckpoint,
} from "@sweatpants/history-store/contract";
import {
  acceptedPublicMessageFact,
  buildConversationWindow,
  persistConversationCheckpoint,
  readAllPublicRootsForModel,
} from "../conversation-persistence.ts";
import { createProjectionTokenKeyring } from "../projection-tokens.ts";

const MESSAGE_COUNT = 10_000;
const MESSAGE_BODY_BYTES = 4 * 1024;
const CHECKPOINT_LIMIT = 8 * 1024 * 1024;
const keyring = createProjectionTokenKeyring("long-conversation-window-key-material");

describe("long conversation bounded hydration", () => {
  it("hydrates 10,000 retained 4 KiB messages with one head/checkpoint read and no archive body read", async () => {
    const root = await mkdtemp(join(tmpdir(), "long-conversation-sqlite-"));
    const handle = await run(function* () {
      return yield* openBetterSqliteStorage(join(root, "conversation.sqlite"), {
        initialize: true,
      });
    });
    try {
      await run(function* () {
        const store = handle.storage.conversationStore;
        let headReads = 0;
        let checkpointReads = 0;
        let historyReads = 0;
        const observedStore = new Proxy(store, {
          get(target, property, receiver) {
            if (property === "loadHead") {
              return function* (id: string) {
                headReads += 1;
                return yield* target.loadHead(id);
              };
            }
            if (property === "getCheckpoint") {
              return function* (pointer: { checkpointId: string }) {
                checkpointReads += 1;
                return yield* target.getCheckpoint(pointer);
              };
            }
            if (property === "readPublicHistoryBefore") {
              return function* (
                request: Parameters<ConversationStore["readPublicHistoryBefore"]>[0],
              ) {
                historyReads += 1;
                return yield* target.readPublicHistoryBefore(request);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as ConversationStore;
        yield* installConversationStore(observedStore);
        const conversationId = "long-conversation";
        const initialized = yield* store.compareAndSwapHead(conversationId, null, null, {
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
        });
        if (initialized.status !== "committed") {
          throw new Error("initialization failed");
        }

        const body = "x".repeat(MESSAGE_BODY_BYTES);
        let currentHead: ConversationHead = initialized.head;
        let currentCheckpoint: StoredCheckpoint | null = null;
        const batchSize = 200;
        for (let start = 0; start < MESSAGE_COUNT; start += batchSize) {
          const end = Math.min(MESSAGE_COUNT, start + batchSize);
          const facts = Array.from({ length: end - start }, (_, offset) => {
            const index = start + offset;
            return acceptedPublicMessageFact({
              id: `long-message-${index.toString().padStart(5, "0")}`,
              role: "user",
              content: body,
            });
          });
          const published = yield* persistConversationCheckpoint({
            conversationId,
            causeKey: `long-conversation-seed-${start}`,
            cause: { kind: "test", from: start, before: end },
            roots: facts,
            proposal: {
              state: "idle",
              activeLogicalTurnId: null,
              activeExecutionId: null,
              latestCompletedExecutionId: null,
              activeSegment: null,
              activeCommand: null,
              deletedAt: null,
              ownerTransition: { kind: "clear" },
            },
            createdAt: start + 1,
            expectedRevision: currentHead.revision,
            expectedOwnerEpoch: currentHead.ownerEpoch,
            targets: {
              spill: { maxRoots: 256, maxEncodedBytes: CHECKPOINT_LIMIT },
              segment: { maxEntries: 64, maxEncodedBytes: CHECKPOINT_LIMIT },
            },
          });
          currentHead = published.head;
          currentCheckpoint = published.checkpoint;
        }
        if (!currentCheckpoint) {
          throw new Error("long conversation was not published");
        }
        expect(BigInt(currentCheckpoint.archiveFrontierOrdinal)).toBeGreaterThan(0n);
        expect(currentCheckpoint.encodedBytes).toBeLessThanOrEqual(CHECKPOINT_LIMIT);

        // Counters were inflated by seeding through the same driver; reset
        // them so only the measured reads are observed.
        headReads = 0;
        checkpointReads = 0;
        historyReads = 0;
        const head = yield* observedStore.loadHead(conversationId);
        if (!head?.checkpoint) {
          throw new Error("long conversation head has no checkpoint");
        }
        const checkpoint = yield* observedStore.getCheckpoint(head.checkpoint);
        if (!checkpoint) {
          throw new Error("long conversation checkpoint is missing");
        }
        const window = yield* buildConversationWindow({
          conversationId,
          head,
          checkpoint,
          keyring,
          now: 10,
        });

        expect(headReads).toBe(1);
        expect(checkpointReads).toBe(1);
        expect(historyReads).toBe(0);
        expect(window.hotRoots).toHaveLength(256);
        expect(window.olderHistoryCursor).not.toBeNull();
        expect(new TextEncoder().encode(canonicalJson(window)).byteLength).toBeLessThanOrEqual(
          CHECKPOINT_LIMIT,
        );

        let budgetError: unknown;
        try {
          yield* readAllPublicRootsForModel(conversationId, checkpoint, 64 * 1024);
        } catch (error) {
          budgetError = error;
        }
        expect(budgetError).toMatchObject({ code: "model_context_limit_exceeded" });
        expect(historyReads).toBe(0);
      });
    } finally {
      await run(() => handle.close());
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
