import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@ag-ui/core";
import { call, run, useScope } from "effection";
import { describe, expect, it } from "vitest";
import { createMemoryConversationStore } from "@sweatpants/history-store/memory";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { openBetterSqliteStorage } from "@sweatpants/storage-sqlite/better-sqlite3";
import type { ConversationHead, ConversationStore } from "@sweatpants/history-store/contract";
import { withConversationStore } from "./with-conversation-store.ts";
import {
  acceptedPublicMessageFact,
  buildConversationWindow,
  persistConversationCheckpoint,
} from "../conversation-persistence.ts";
import { createDurableChatEndpoints } from "../durable-handler/handler.ts";
import { createHostScopeOwner, installHostScopeOwner } from "../host/host-scope.ts";
import { installDurableStreamsOwner } from "../response-streams/owner.ts";
import { setupInMemoryDurableStreams } from "../response-streams/setup.ts";
import {
  createProjectionTokenKeyring,
  mintPublicHistoryCursor,
  verifyPublicHistoryCursor,
  verifyWindowToken,
} from "../projection-tokens.ts";

const keyring = createProjectionTokenKeyring("window-runtime-test-key-material-32-bytes");

function message(id: string, content: string): Message {
  return { id, role: "user", content };
}

function storageFor(conversationStore: ConversationStore) {
  return {
    kind: "custom" as const,
    conversationStore,
    executionStore: createMemoryExecutionStore(),
  };
}

function historyRequest(conversationId: string, cursor: string) {
  return {
    conversationId,
    request: new Request("http://localhost/history:page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cursor }),
    }),
  };
}

function* initialize(store: ConversationStore, conversationId: string) {
  const result = yield* store.compareAndSwapHead(conversationId, null, null, {
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
  if (result.status !== "committed") throw new Error("failed to initialize conversation");
  return result.head;
}

function* publish(
  store: ConversationStore,
  head: ConversationHead,
  facts: readonly ReturnType<typeof acceptedPublicMessageFact>[],
  causeKey: string,
) {
  return yield* withConversationStore(store, () =>
    persistConversationCheckpoint({
      conversationId: head.conversationId,
      causeKey,
      cause: { kind: "test", causeKey },
      roots: facts,
      proposal: {
        state: "idle",
        activeLogicalTurnId: null,
        activeExecutionId: null,
        latestCompletedExecutionId: head.latestCompletedExecutionId,
        activeSegment: null,
        activeCommand: null,
        deletedAt: null,
        ownerTransition: { kind: "clear" },
      },
      createdAt: Date.now(),
      expectedRevision: head.revision,
      expectedOwnerEpoch: head.ownerEpoch,
      targets: {
        spill: { maxRoots: 1, maxEncodedBytes: 8 * 1024 * 1024 },
        segment: { maxEntries: 8, maxEncodedBytes: 8 * 1024 * 1024 },
      },
    }),
  );
}

describe("native ConversationWindow production", () => {
  it("uses reset initially and continue with complete prior-hot and newly allocated spill catch-up", async () => {
    const root = await mkdtemp(join(tmpdir(), "conversation-window-sqlite-"));
    const handle = await run(function* () {
      return yield* openBetterSqliteStorage(join(root, "conversation.sqlite"), {
        initialize: true,
      });
    });
    try {
      await run(function* () {
        const store = handle.storage.conversationStore;
        const conversationId = "window-runtime";
        const now = Date.now();
        const initial = yield* initialize(store, conversationId);
        const first = yield* publish(
          store,
          initial,
          [acceptedPublicMessageFact(message("user-1", "one"))],
          "first",
        );
        let initialHistoryReads = 0;
        const hydrationStore = new Proxy(store, {
          get(target, property, receiver) {
            if (property === "readPublicHistoryBefore") {
              return function* (
                request: Parameters<ConversationStore["readPublicHistoryBefore"]>[0],
              ) {
                initialHistoryReads += 1;
                return yield* target.readPublicHistoryBefore(request);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as ConversationStore;
        const firstWindow = yield* withConversationStore(hydrationStore, () =>
          buildConversationWindow({
            conversationId,
            head: first.head,
            checkpoint: first.checkpoint,
            keyring,
            now,
          }),
        );
        expect(firstWindow.windowMode).toBe("reset");
        expect(initialHistoryReads).toBe(0);
        expect(firstWindow.hotRoots.map((root) => root.position)).toEqual(["0"]);
        expect(firstWindow.olderHistoryCursor).toBeNull();
        const firstBasis = yield* call(() =>
          verifyWindowToken(firstWindow.windowToken, keyring, now + 1),
        );
        expect(firstBasis).toMatchObject({
          hotRootPositions: ["0"],
          nextPublicPosition: "1",
        });

        const second = yield* publish(
          store,
          first.head,
          [
            acceptedPublicMessageFact(message("user-2", "two")),
            acceptedPublicMessageFact(message("user-3", "three")),
          ],
          "second",
        );
        const continued = yield* withConversationStore(store, () =>
          buildConversationWindow({
            conversationId,
            head: second.head,
            checkpoint: second.checkpoint,
            keyring,
            knownWindowToken: firstWindow.windowToken,
            now: now + 100,
          }),
        );
        expect(continued.windowMode).toBe("continue");
        expect(continued.hotRoots.map((root) => root.position)).toEqual(["2"]);
        expect(continued.sealedCatchupRoots.map((root) => root.position)).toEqual(["0", "1"]);
        expect(continued.olderHistoryCursor).not.toBeNull();

        const corruptStore = {
          ...store,
          *readPublicHistoryBefore() {
            return { roots: [], nextBeforePosition: null };
          },
        } as ConversationStore;
        let corruption: unknown;
        try {
          yield* withConversationStore(corruptStore, () =>
            buildConversationWindow({
              conversationId,
              head: second.head,
              checkpoint: second.checkpoint,
              keyring,
              knownWindowToken: firstWindow.windowToken,
              now: now + 101,
            }),
          );
        } catch (error) {
          corruption = error;
        }
        expect(corruption).toMatchObject({ code: "public_root_conflict" });

        const cursor = yield* call(() =>
          verifyPublicHistoryCursor(continued.olderHistoryCursor!, keyring),
        );
        expect(cursor).toMatchObject({
          lineageId: second.checkpoint.lineageId,
          beforePosition: "3",
          archiveFrontierOrdinal: "2",
        });

        const endpoints = createDurableChatEndpoints({
          storage: storageFor(store),
          projectionTokens: keyring,
          createProgramDriverJournalStore: () => ({}) as never,
          *authorizeHistoryRead() {
            return "authorized" as const;
          },
        });
        const pageResponse = yield* call(() =>
          endpoints.pageHistory(historyRequest(conversationId, continued.olderHistoryCursor!)),
        );
        expect(pageResponse.status).toBe(200);
        expect(pageResponse.headers.get("cache-control")).toBe("private, no-store");
        const pageBody = (yield* call(() => pageResponse.json())) as {
          roots: Array<{ position: string }>;
          nextOlderCursor: string | null;
        };
        expect(pageBody.roots.map((root) => root.position)).toEqual(["0", "1"]);
        expect(pageBody.nextOlderCursor).toBeNull();

        const forbidden = createDurableChatEndpoints({
          storage: storageFor(store),
          projectionTokens: keyring,
          createProgramDriverJournalStore: () => ({}) as never,
          *authorizeHistoryRead() {
            return "forbidden" as const;
          },
        });
        const forbiddenResponse = yield* call(() =>
          forbidden.pageHistory(historyRequest(conversationId, "invalid.token")),
        );
        expect(forbiddenResponse.status).toBe(403);

        const reset = yield* withConversationStore(store, () =>
          buildConversationWindow({
            conversationId,
            head: second.head,
            checkpoint: second.checkpoint,
            keyring,
            knownWindowToken: "invalid.token",
            now: now + 200,
          }),
        );
        expect(reset.windowMode).toBe("reset");
        expect(reset.sealedCatchupRoots).toEqual([]);

        let oversized = second;
        for (let batch = 0; batch < 3; batch += 1) {
          oversized = yield* publish(
            store,
            oversized.head,
            Array.from({ length: 200 }, (_, index) =>
              acceptedPublicMessageFact(
                message(`oversized-${batch}-${index}`, `batch ${batch} message ${index}`),
              ),
            ),
            `oversized-${batch}`,
          );
        }
        const oversizedWindow = yield* withConversationStore(store, () =>
          buildConversationWindow({
            conversationId,
            head: oversized.head,
            checkpoint: oversized.checkpoint,
            keyring,
            knownWindowToken: firstWindow.windowToken,
            now: now + 300,
          }),
        );
        expect(oversizedWindow.windowMode).toBe("reset");
        expect(oversizedWindow.sealedCatchupRoots).toEqual([]);
      });
    } finally {
      await run(() => handle.close());
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hydrates through the production handler with one head and checkpoint read and no archive read", async () => {
    await run(function* () {
      const store = createMemoryConversationStore();
      const conversationId = "bounded-handler-hydration";
      const initial = yield* initialize(store, conversationId);
      const published = yield* publish(
        store,
        initial,
        [
          acceptedPublicMessageFact(message("hydration-1", "one")),
          acceptedPublicMessageFact(message("hydration-2", "two")),
        ],
        "bounded-handler-hydration",
      );
      expect(BigInt(published.checkpoint.archiveFrontierOrdinal)).toBeGreaterThan(0n);
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
      const scope = yield* useScope();
      const owner = createHostScopeOwner(scope);
      yield* installHostScopeOwner(owner);
      yield* installDurableStreamsOwner(owner);
      yield* setupInMemoryDurableStreams();
      // Seeding ran through the same counting driver; reset so only the
      // handler's reads are measured.
      headReads = 0;
      checkpointReads = 0;
      historyReads = 0;
      const endpoints = createDurableChatEndpoints({
        storage: storageFor(observedStore),
        projectionTokens: keyring,
        createProgramDriverJournalStore: () => ({}) as never,
        *authorizeHistoryRead() {
          return "authorized" as const;
        },
      });
      const readChat = endpoints.readChat.withScope(scope);
      const response = yield* call(() =>
        readChat({
          conversationId,
          request: new Request("http://localhost/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              clientId: "hydration-client",
              conversationId,
            }),
          }),
        }),
      );
      expect(response.status).toBe(200);
      const frames = (yield* call(() => response.text()))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string });
      expect(frames.map((frame) => frame.type)).toEqual([
        "sweatpants.conversation-window.v1",
        "sweatpants.conversation-authority.v1",
      ]);
      expect(headReads).toBe(1);
      expect(checkpointReads).toBe(1);
      expect(historyReads).toBe(0);
    });
  });

  it("authenticates before token/store access and maps the complete history status matrix", async () => {
    await run(function* () {
      const store = createMemoryConversationStore();
      const conversationId = "history-status";
      const now = Date.now();
      const initial = yield* initialize(store, conversationId);
      const published = yield* publish(
        store,
        initial,
        [acceptedPublicMessageFact(message("user-status", "status"))],
        "status",
      );
      const validPayload = {
        lineageId: published.checkpoint.lineageId,
        basisRevision: published.head.revision,
        archiveFrontierOrdinal: published.checkpoint.archiveFrontierOrdinal,
        nextPublicPosition: published.checkpoint.nextPublicPosition,
        hotRootPositions: ["0"],
        beforePosition: published.checkpoint.nextPublicPosition,
        issuedAt: now - 1_000,
        expiresAt: now + 60_000,
      } as const;
      const validCursor = yield* call(() => mintPublicHistoryCursor(validPayload, keyring));
      let headReads = 0;
      const observedStore = new Proxy(store, {
        get(target, property, receiver) {
          if (property === "loadHead") {
            return function* (id: string) {
              headReads += 1;
              return yield* target.loadHead(id);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as ConversationStore;
      const handler = (
        authorization: "authorized" | "unauthenticated" | "forbidden",
        selectedStore: ConversationStore = observedStore,
      ) =>
        createDurableChatEndpoints({
          storage: storageFor(selectedStore),
          projectionTokens: keyring,
          createProgramDriverJournalStore: () => ({}) as never,
          *authorizeHistoryRead() {
            return authorization;
          },
        }).pageHistory;

      expect(
        (yield* call(() =>
          handler("unauthenticated")(historyRequest(conversationId, "invalid.token")),
        )).status,
      ).toBe(401);
      expect(headReads).toBe(0);
      expect(
        (yield* call(() => handler("forbidden")(historyRequest(conversationId, "invalid.token"))))
          .status,
      ).toBe(403);
      expect(headReads).toBe(0);
      expect(
        (yield* call(() => handler("authorized")(historyRequest(conversationId, "invalid.token"))))
          .status,
      ).toBe(400);
      expect(headReads).toBe(0);

      expect(
        (yield* call(() =>
          handler("authorized")(historyRequest("missing-conversation", validCursor)),
        )).status,
      ).toBe(404);

      const deletedStore = createMemoryConversationStore();
      const deletedInitial = yield* initialize(deletedStore, "deleted-conversation");
      const deleted = yield* deletedStore.compareAndSwapHead(
        "deleted-conversation",
        deletedInitial.revision,
        deletedInitial.ownerEpoch,
        {
          state: "deleted",
          checkpoint: null,
          terminalHistory: null,
          activeLogicalTurnId: null,
          activeExecutionId: null,
          latestCompletedExecutionId: null,
          activeSegment: null,
          activeCommand: null,
          deletedAt: now,
          ownerTransition: { kind: "clear" },
        },
      );
      expect(deleted.status).toBe("committed");
      expect(
        (yield* call(() =>
          handler("authorized", deletedStore)(historyRequest("deleted-conversation", validCursor)),
        )).status,
      ).toBe(410);

      const olderCursor = yield* call(() =>
        mintPublicHistoryCursor(
          { ...validPayload, issuedAt: now - 2_000, expiresAt: now - 1 },
          keyring,
        ),
      );
      const readsBeforeOlderCursor = headReads;
      expect(
        (yield* call(() => handler("authorized")(historyRequest(conversationId, olderCursor))))
          .status,
      ).toBe(200);
      expect(headReads).toBeGreaterThan(readsBeforeOlderCursor);

      const crossLineageCursor = yield* call(() =>
        mintPublicHistoryCursor({ ...validPayload, lineageId: "another-lineage" }, keyring),
      );
      expect(
        (yield* call(() =>
          handler("authorized")(historyRequest(conversationId, crossLineageCursor)),
        )).status,
      ).toBe(409);
    });
  });
});
