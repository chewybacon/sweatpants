/**
 * Durable Chat Handler Tests
 *
 * Black-box tests for the durable chat handler.
 * Tests the complete request lifecycle:
 *
 *   Client Request → Handler → SessionRegistry → LLM Writer → Buffer → Response
 *
 * These tests verify:
 * - New session creation and streaming
 * - Session info emission
 * - Text streaming with LSN
 * - Tool calling and execution
 * - Reconnection from LSN
 * - Error handling
 */
import { describe, it, expect } from "./vitest-effection.ts";
import { call } from "effection";
import { z } from "zod";
import {
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  setupDurableStreams,
} from "@sweatpants/durable-chat-runtime/response-streams";
import type { RetentionPolicy } from "@sweatpants/durable-streams";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { createMemoryHistoryStore } from "@sweatpants/history-store/memory";
import type { HistoryStore } from "@sweatpants/history-store/contract";
import type { Json } from "@sweatpants/foundation";
import { assertPendingResumeConsistency } from "../handler.ts";
import type { ChatHandlerSetup } from "../types.ts";
import { registerInterruptsFromRunFinished } from "@sweatpants/durable-chat-runtime/interrupts";
import { resetPrivateModelContextRegistry } from "@sweatpants/durable-chat-runtime/model-context";
type LegacyTestTool = any;
import type { Message } from "@sweatpants/chat-core";
import {
  createMockProvider,
  createMockTool,
  createTestDurableChatHandler,
  consumeDurableResponse,
  createChatRequest,
  getEventsByType,
  setupMockModelProvider,
  setupMockTools,
} from "./test-utils.ts";

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create request setup for testing.
 */
function createTestHooks(
  provider: ReturnType<typeof createMockProvider>,
  tools: LegacyTestTool[] = [],
  options: { retentionPolicy?: RetentionPolicy } = {},
): ChatHandlerSetup {
  const bufferStore = createInMemoryBufferStore<string>();
  const registryStore = createInMemoryRegistryStore();

  return function* setup() {
    yield* setupDurableStreams({
      bufferStore,
      registryStore,
      ...(options.retentionPolicy ? { retentionPolicy: options.retentionPolicy } : {}),
    });
    yield* setupMockModelProvider(provider);
    yield* setupMockTools(tools);
  };
}

/**
 * Helper to make a chat request and consume the response.
 */
async function makeRequest(
  handler: (req: Request) => Promise<Response>,
  messages: Message[],
  options: {
    sessionId?: string;
    conversationId?: string;
    lastLSN?: number;
    enabledTools?: boolean | string[];
    systemPrompt?: string;
  } = {},
) {
  const { request } = createChatRequest(messages, options);
  const response = await handler(request);
  const result = await consumeDurableResponse(response);
  const sessionId = response.headers.get("X-Session-Id");
  return { response, result, sessionId };
}

// =============================================================================
// TESTS
// =============================================================================

describe("Durable Chat Handler", () => {
  describe("New Session: Basic Streaming", () => {
    it("should hydrate conversationId GET from snapshots instead of replaying terminal text events", function* () {
      const provider = createMockProvider({ responses: "Hello from durable world" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider, [], {
          retentionPolicy: { mode: "retain_forever" },
        }),
      });

      const conversationId = "durable-plain-thread";

      yield* call(() =>
        makeRequest(
          handler,
          [{ id: "user:durable-handler", role: "user", content: "Hi durable handler" }],
          {
            conversationId,
          },
        ),
      );

      const { request } = createChatRequest([], {
        method: "GET",
        conversationId,
      });
      const response = yield* call(() => handler(request));
      const replay = yield* call(() => consumeDurableResponse(response));

      const snapshots = getEventsByType(replay, "MESSAGES_SNAPSHOT") as Array<{
        type: "MESSAGES_SNAPSHOT";
        messages: Array<{ role: string; content?: string }>;
      }>;

      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots[0]?.messages).toMatchObject([
        { role: "user", content: "Hi durable handler" },
        { role: "assistant", content: "Hello from durable world" },
      ]);
      expect(getEventsByType(replay, "TEXT_MESSAGE_CONTENT")).toEqual([]);
      expect(replay.text).toBe("");
    });

    it("should hydrate from a stored conversation checkpoint even after the raw session is deleted", function* () {
      const provider = createMockProvider({ responses: "Checkpoint survives" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const conversationId = `thread-checkpoint-${Date.now()}`;

      yield* call(() =>
        makeRequest(handler, [{ id: "user:checkpoint", role: "user", content: "Persist me" }], {
          conversationId,
        }),
      );

      const { request } = createChatRequest([], {
        method: "GET",
        conversationId,
      });
      const response = yield* call(() => handler(request));
      const replay = yield* call(() => consumeDurableResponse(response));

      expect(response.status).toBe(200);
      expect(response.headers.get("Stream-Next-Offset")).toBe("0000000000000000");
      const snapshots = getEventsByType(replay, "MESSAGES_SNAPSHOT") as Array<{
        type: "MESSAGES_SNAPSHOT";
        messages: Array<{ role: string; content?: string }>;
      }>;
      expect(snapshots[0]?.messages).toMatchObject([
        { role: "user", content: "Persist me" },
        { role: "assistant", content: "Checkpoint survives" },
      ]);
      expect(replay.text).toBe("");

      const { request: echoCursorRequest } = createChatRequest([], {
        method: "GET",
        conversationId,
        offset: 0,
      });
      const echoCursorResponse = yield* call(() => handler(echoCursorRequest));
      const echoCursorReplay = yield* call(() => consumeDurableResponse(echoCursorResponse));
      expect(echoCursorResponse.headers.get("Stream-Cursor-Reset")).toBeNull();
      expect(echoCursorResponse.headers.get("Stream-Up-To-Date")).toBe("true");
      expect(echoCursorReplay.events).toEqual([]);
    });

    it("should persist a conversation checkpoint even if the client disconnects before stream completion", function* () {
      const provider = createMockProvider({
        responses: "Disconnect and finish",
        tokenDelayMs: 50,
      });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const conversationId = `thread-disconnect-${Date.now()}`;
      const { request: initialRequest } = createChatRequest(
        [{ id: "user:disconnect", role: "user", content: "Keep going" }],
        { conversationId },
      );
      const initialResponse = yield* call(() => handler(initialRequest));
      yield* call(async () => {
        await initialResponse.body?.cancel();
      });

      yield* call(() => new Promise((resolve) => setTimeout(resolve, 250)));

      const { request } = createChatRequest([], {
        method: "GET",
        conversationId,
      });
      const response = yield* call(() => handler(request));
      const replay = yield* call(() => consumeDurableResponse(response));

      const snapshots = getEventsByType(replay, "MESSAGES_SNAPSHOT") as Array<{
        type: "MESSAGES_SNAPSHOT";
        messages: Array<{ role: string; content?: string }>;
      }>;
      expect(snapshots[0]?.messages).toMatchObject([
        { role: "user", content: "Keep going" },
        { role: "assistant", content: "Disconnect and finish" },
      ]);
    });

    it("should return checkpoint metadata for HEAD conversation reads after raw session deletion", function* () {
      const provider = createMockProvider({ responses: "Checkpoint head" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const conversationId = `thread-checkpoint-head-${Date.now()}`;
      yield* call(() =>
        makeRequest(handler, [{ id: "user:head", role: "user", content: "Persist head" }], {
          conversationId,
        }),
      );

      const { request } = createChatRequest([], {
        method: "HEAD",
        conversationId,
      });
      const response = yield* call(() => handler(request));

      expect(response.status).toBe(200);
      expect(response.headers.get("Stream-Next-Offset")).toBe("0000000000000000");
      expect(response.headers.get("Stream-Up-To-Date")).toBe("true");
      expect(yield* call(() => response.text())).toBe("");
    });

    it("should normalize divergent body threadId to the durable conversationId", function* () {
      const provider = createMockProvider({ responses: "normalized" });
      const handler = createTestDurableChatHandler({ setup: createTestHooks(provider) });
      const conversationId = `thread-normalized-${Date.now()}`;

      const response = yield* call(() =>
        handler(
          new Request(
            `http://localhost/chat?conversationId=${encodeURIComponent(conversationId)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                threadId: "divergent-client-thread-id",
                messages: [{ id: "user:normalize", role: "user", content: "normalize" }],
              }),
            },
          ),
        ),
      );
      const result = yield* call(() => consumeDurableResponse(response));
      const runStarted = getEventsByType(result, "RUN_STARTED") as Array<{
        type: "RUN_STARTED";
        threadId: string;
      }>;
      expect(runStarted[0]?.threadId).toBe(conversationId);
    });

    it("enforces identity law: conversationId durable, threadId alias, runId ephemeral, stream id separate", function* () {
      const provider = createMockProvider({ responses: "identity-law" });
      const handler = createTestDurableChatHandler({ setup: createTestHooks(provider) });
      const conversationId = `identity-law-${Date.now()}`;

      // No client runId: server must mint one, never reuse X-Session-Id.
      const first = yield* call(() =>
        handler(
          new Request("http://localhost/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversationId,
              threadId: "should-not-win",
              messages: [{ id: "user:id-1", role: "user", content: "first" }],
            }),
          }),
        ),
      );
      const firstResult = yield* call(() => consumeDurableResponse(first));
      const firstStreamId = first.headers.get("X-Session-Id");
      const firstConversationHeader = first.headers.get("X-Conversation-Id");
      const firstStarted = getEventsByType(firstResult, "RUN_STARTED") as Array<{
        type: "RUN_STARTED";
        threadId: string;
        runId: string;
      }>;

      expect(firstConversationHeader).toBe(conversationId);
      expect(firstStreamId).toBeTruthy();
      expect(firstStarted[0]?.threadId).toBe(conversationId);
      expect(firstStarted[0]?.runId).toBeTruthy();
      expect(firstStarted[0]?.runId).not.toBe(firstStreamId);
      expect(firstStarted[0]?.runId).not.toBe(conversationId);

      // Explicit runId is honored; threadId still forced to conversationId.
      const second = yield* call(() =>
        handler(
          new Request("http://localhost/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversationId,
              threadId: "still-should-not-win",
              runId: "client-run-42",
              messages: [{ id: "user:id-2", role: "user", content: "second" }],
            }),
          }),
        ),
      );
      const secondResult = yield* call(() => consumeDurableResponse(second));
      const secondStarted = getEventsByType(secondResult, "RUN_STARTED") as Array<{
        type: "RUN_STARTED";
        threadId: string;
        runId: string;
      }>;
      expect(second.headers.get("X-Conversation-Id")).toBe(conversationId);
      expect(secondStarted[0]?.threadId).toBe(conversationId);
      expect(secondStarted[0]?.runId).toBe("client-run-42");

      // threadId alone still resolves as the durable conversation key.
      const viaThread = yield* call(() =>
        handler(
          new Request("http://localhost/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              threadId: conversationId,
              messages: [{ id: "user:id-3", role: "user", content: "via thread" }],
            }),
          }),
        ),
      );
      const viaThreadResult = yield* call(() => consumeDurableResponse(viaThread));
      const viaThreadStarted = getEventsByType(viaThreadResult, "RUN_STARTED") as Array<{
        type: "RUN_STARTED";
        threadId: string;
      }>;
      expect(viaThread.headers.get("X-Conversation-Id")).toBe(conversationId);
      expect(viaThreadStarted[0]?.threadId).toBe(conversationId);
    });

    it("should reuse the same durable session for repeated conversationId requests", function* () {
      const provider = createMockProvider({ responses: ["First response", "Second response"] });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider, [], {
          retentionPolicy: { mode: "retain_forever" },
        }),
      });

      const conversationId = "thread-123";

      const first = yield* call(() =>
        makeRequest(handler, [{ id: "user:hello", role: "user", content: "Hello" }], {
          conversationId,
        }),
      );

      expect(first.sessionId).toBeDefined();

      const { request: replayRequest } = createChatRequest([], {
        method: "GET",
        conversationId,
      });
      const replayResponse = yield* call(() => handler(replayRequest));
      expect(replayResponse.status).toBe(200);
      expect(replayResponse.headers.get("X-Session-Id")).toBe(first.sessionId);

      const replayResult = yield* call(() => consumeDurableResponse(replayResponse));
      const replaySnapshots = getEventsByType(replayResult, "MESSAGES_SNAPSHOT") as Array<{
        type: "MESSAGES_SNAPSHOT";
        messages: Array<{ role: string; content?: string }>;
      }>;
      expect(replaySnapshots[0]?.messages).toMatchObject([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "First response" },
      ]);
      expect(replayResult.text).toBe("");

      const { request: headRequest } = createChatRequest([], {
        method: "HEAD",
        conversationId,
      });
      const headResponse = yield* call(() => handler(headRequest));
      expect(headResponse.status).toBe(200);
      expect(headResponse.headers.get("X-Session-Id")).toBe(first.sessionId);
    });

    it("should reset stale conversation offsets to the current snapshot hydrate", function* () {
      const provider = createMockProvider({ responses: "Reset me" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider, [], {
          retentionPolicy: { mode: "retain_forever" },
        }),
      });

      const conversationId = "thread-reset";
      yield* call(() =>
        makeRequest(handler, [{ id: "user:reset", role: "user", content: "Hello" }], {
          conversationId,
        }),
      );

      const { request } = createChatRequest([], {
        method: "GET",
        conversationId,
        offset: 0,
      });
      const response = yield* call(() => handler(request));
      const replay = yield* call(() => consumeDurableResponse(response));

      expect(response.headers.get("Stream-Cursor-Reset")).toBe("true");
      expect(response.headers.get("Stream-Next-Offset")).toBeTruthy();
      const snapshots = getEventsByType(replay, "MESSAGES_SNAPSHOT") as Array<{
        type: "MESSAGES_SNAPSHOT";
        messages: Array<{ role: string; content?: string }>;
      }>;
      expect(snapshots[0]?.messages).toMatchObject([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Reset me" },
      ]);
    });

    it("should return snapshots plus active tail without resetting a valid hot-turn offset", function* () {
      const provider = createMockProvider({
        responses: "active tail",
        tokenDelayMs: 100,
      });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider, [], {
          retentionPolicy: { mode: "retain_forever" },
        }),
      });

      const conversationId = `thread-active-${Date.now()}`;
      const { request: initialRequest } = createChatRequest(
        [{ id: "user:active", role: "user", content: "Stream slowly" }],
        {
          conversationId,
        },
      );
      const initialResponse = yield* call(() => handler(initialRequest));
      expect(initialResponse.headers.get("X-Session-Id")).toBeTruthy();

      yield* call(() => new Promise((resolve) => setTimeout(resolve, 20)));

      const { request } = createChatRequest([], {
        method: "GET",
        conversationId,
        offset: 3,
      });
      const response = yield* call(() => handler(request));
      const replay = yield* call(() => consumeDurableResponse(response));

      expect(response.headers.get("Stream-Cursor-Reset")).toBeNull();
      expect(getEventsByType(replay, "MESSAGES_SNAPSHOT").length).toBeGreaterThan(0);

      yield* call(async () => {
        await initialResponse.body?.cancel();
      });
    });

    it("should hydrate paused threads with snapshots plus a public interrupt marker", function* () {
      const provider = createMockProvider({ responses: "Paused hello" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider, [], {
          retentionPolicy: { mode: "retain_forever" },
        }),
      });

      const conversationId = `thread-paused-${Date.now()}`;
      const first = yield* call(() =>
        makeRequest(handler, [{ id: "user:paused", role: "user", content: "Pause me" }], {
          conversationId,
        }),
      );

      registerInterruptsFromRunFinished({
        type: "RUN_FINISHED",
        threadId: conversationId,
        runId: first.sessionId!,
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: `interrupt-${conversationId}`,
              reason: "input_required",
              message: "Need approval",
              toolCallId: "call-paused",
              responseSchema: { type: "object", properties: { ok: { type: "boolean" } } },
              metadata: {
                "sweatpants/toolName": "confirm",
                "sweatpants/key": "confirmAction",
                "sweatpants/sessionId": "private-session-id",
                "sweatpants/continuationRef": "private-continuation-ref",
                publicNote: "safe-public-note",
              },
            },
          ],
        },
      });

      const { request } = createChatRequest([], {
        method: "GET",
        conversationId,
      });
      const response = yield* call(() => handler(request));
      const replay = yield* call(() => consumeDurableResponse(response));

      expect(response.headers.get("Stream-Cursor-Reset")).toBeNull();
      const snapshots = getEventsByType(replay, "MESSAGES_SNAPSHOT") as Array<{
        type: "MESSAGES_SNAPSHOT";
        messages: Array<{ role: string; content?: string }>;
      }>;
      expect(snapshots[0]?.messages).toMatchObject([
        { role: "user", content: "Pause me" },
        { role: "assistant", content: "Paused hello" },
      ]);

      const stateSnapshots = getEventsByType(replay, "STATE_SNAPSHOT") as Array<{
        type: "STATE_SNAPSHOT";
        snapshot: { pendingClientActions?: Array<{ sessionId: string; toolCallId: string }> };
      }>;
      expect(stateSnapshots[0]?.snapshot.pendingClientActions).toMatchObject([
        { sessionId: "call-paused", toolCallId: "call-paused" },
      ]);

      const runFinished = getEventsByType(replay, "RUN_FINISHED") as Array<{
        type: "RUN_FINISHED";
        outcome?: { type: string; interrupts?: Array<{ metadata?: Record<string, unknown> }> };
      }>;
      expect(runFinished[0]?.outcome?.type).toBe("interrupt");
      expect(JSON.stringify(runFinished[0])).not.toContain("private-session-id");
      expect(JSON.stringify(runFinished[0])).not.toContain("private-continuation-ref");
      expect(runFinished[0]?.outcome?.interrupts?.[0]?.metadata).toMatchObject({
        "sweatpants/toolName": "confirm",
        "sweatpants/key": "confirmAction",
        publicNote: "safe-public-note",
      });
    });

    it("rejects contradictory pending resume state instead of emitting it (TC-N04)", function* () {
      // REQ-014 / REQ-042: derived pendingClientActions must describe the same
      // pending set as the authoritative RUN_FINISHED interrupt marker. Force a
      // divergence and verify the consistency guard throws rather than letting
      // contradictory resume instructions reach a client.
      const openInterrupts = [
        { interruptId: "interrupt-a", toolCallId: "call-a" },
        { interruptId: "interrupt-b", toolCallId: "call-b" },
      ];
      const elicitFor = (interruptId: string, callId: string) => ({
        type: "elicit_request" as const,
        sessionId: callId,
        callId,
        toolName: "confirm",
        elicitId: interruptId,
        key: interruptId,
        message: "Need approval",
        schema: {},
      });

      // Matched sets pass.
      expect(() =>
        assertPendingResumeConsistency(
          [elicitFor("interrupt-a", "call-a"), elicitFor("interrupt-b", "call-b")],
          openInterrupts,
        ),
      ).not.toThrow();

      // Derived action referencing an interrupt outside the authoritative set fails.
      expect(() =>
        assertPendingResumeConsistency(
          [elicitFor("interrupt-a", "call-a"), elicitFor("interrupt-stale", "call-stale")],
          openInterrupts,
        ),
      ).toThrow(/mismatch/i);

      // Missing derived action for an open interrupt with a toolCallId fails.
      expect(() =>
        assertPendingResumeConsistency([elicitFor("interrupt-a", "call-a")], openInterrupts),
      ).toThrow(/mismatch/i);

      // Interrupts without toolCallId cannot become pendingClientActions and are exempt.
      expect(() =>
        assertPendingResumeConsistency(
          [elicitFor("interrupt-a", "call-a")],
          [openInterrupts[0]!, { interruptId: "interrupt-no-call" }],
        ),
      ).not.toThrow();
    });

    it("should preserve the original private system prompt for later runs in the same thread", function* () {
      const seenMessages: Message[][] = [];
      const fallback = createMockProvider({ responses: ["first", "second"] });
      const provider = createMockProvider({
        customStream: (messages, options) => {
          seenMessages.push(messages);
          return fallback.stream(messages, options);
        },
      });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider, [], {
          retentionPolicy: { mode: "retain_forever" },
        }),
      });

      const conversationId = `thread-prompt-${Date.now()}`;
      yield* call(() =>
        makeRequest(handler, [{ id: "user:one", role: "user", content: "Hello" }], {
          conversationId,
          systemPrompt: "Prompt A",
        }),
      );
      resetPrivateModelContextRegistry();

      yield* call(() =>
        makeRequest(handler, [{ id: "user:two", role: "user", content: "Again" }], {
          conversationId,
          systemPrompt: "Prompt B",
        }),
      );

      expect(seenMessages[0]?.[0]?.role).toBe("system");
      expect(seenMessages[0]?.[0]?.content).toBe("Prompt A");
      expect(seenMessages[1]?.[0]?.role).toBe("system");
      expect(seenMessages[1]?.[0]?.content).toBe("Prompt A");
    });

    it("should stream a simple text response with strict AG-UI run lifecycle", function* () {
      const provider = createMockProvider({ responses: "Hello, world!" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const { result, sessionId } = yield* call(() =>
        makeRequest(handler, [{ id: "user:hi", role: "user", content: "Hi" }]),
      );

      // Should have session ID
      expect(sessionId).toBeDefined();

      expect(getEventsByType(result, "RUN_STARTED")).toHaveLength(1);

      // Should have text
      expect(result.text).toBe("Hello, world!");

      // Should have complete event (RUN_FINISHED)
      expect(result.complete).not.toBeNull();
      expect(result.complete?.type).toBe("RUN_FINISHED");

      // All events should have LSN
      expect(result.events.length).toBeGreaterThan(0);
      for (const event of result.events) {
        expect(typeof event.lsn).toBe("number");
        expect(event.lsn).toBeGreaterThan(0);
      }
    });

    it("does not close the final response before Session Head publication", function* () {
      const provider = createMockProvider({ responses: "Wait for publication" });
      const memoryHistory = createMemoryHistoryStore();
      let releasePublication!: () => void;
      let publicationReached!: () => void;
      const released = new Promise<void>((resolve) => {
        releasePublication = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        publicationReached = resolve;
      });
      const historyStore: HistoryStore<Json> = {
        ...memoryHistory,
        *compareAndSwapHead(sessionId, expected, next) {
          if (next.activeExecutionId === null) {
            publicationReached();
            yield* call(() => released);
          }
          return yield* memoryHistory.compareAndSwapHead(sessionId, expected, next);
        },
      };
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
        executionStore: createMemoryExecutionStore(),
        historyStore,
      });
      let settled = false;
      const response = makeRequest(handler, [
        { id: "user:publication-order", role: "user", content: "Wait" },
      ]).then((value) => {
        settled = true;
        return value;
      });

      yield* call(() => reached);
      expect(settled).toBe(false);
      releasePublication();
      const completed = yield* call(() => response);
      expect(completed.result.complete?.type).toBe("RUN_FINISHED");
      expect(settled).toBe(true);
    });

    it("recovers terminal-unpublished history without invoking the provider again", function* () {
      let providerInvocations = 0;
      const provider = createMockProvider({
        customStream(messages, options) {
          providerInvocations += 1;
          return createMockProvider({ responses: "Published exactly once" }).stream(
            messages,
            options,
          );
        },
      });
      const executionStore = createMemoryExecutionStore();
      const memoryHistory = createMemoryHistoryStore();
      let failBeforeSegment = true;
      const historyStore: HistoryStore<Json> = {
        loadHead: (sessionId) => memoryHistory.loadHead(sessionId),
        *putSegment(segment) {
          if (failBeforeSegment) {
            failBeforeSegment = false;
            throw new Error("semantic fault after terminal capsule commit");
          }
          return yield* memoryHistory.putSegment(segment);
        },
        compareAndSwapHead: (sessionId, expected, next) =>
          memoryHistory.compareAndSwapHead(sessionId, expected, next),
        readPage: (sessionId, cursor, limit) => memoryHistory.readPage(sessionId, cursor, limit),
      };
      const conversationId = "terminal-unpublished-recovery";
      const config = {
        setup: createTestHooks(provider, [], { retentionPolicy: { mode: "retain_forever" } }),
        executionStore,
        historyStore,
      };

      const first = createTestDurableChatHandler(config);
      const firstResult = yield* call(() =>
        makeRequest(first, [{ id: "user:fault", role: "user", content: "Publish this" }], {
          conversationId,
        }),
      );
      expect(firstResult.result.complete).toBeNull();
      expect(providerInvocations).toBe(1);

      const replacement = createTestDurableChatHandler(config);
      const recovered = yield* call(() =>
        makeRequest(replacement, [{ id: "user:fault", role: "user", content: "Publish this" }], {
          conversationId,
        }),
      );
      expect(recovered.result.complete?.type).toBe("RUN_FINISHED");
      expect(providerInvocations).toBe(1);
      expect((yield* memoryHistory.readPage(conversationId)).entries).toHaveLength(1);
    });

    it("should include LSN in correct order", function* () {
      const provider = createMockProvider({ responses: "One Two Three" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const { result } = yield* call(() =>
        makeRequest(handler, [{ id: "user:count", role: "user", content: "Count" }]),
      );

      // LSNs should be monotonically increasing
      const lsns = result.events.map((e) => e.lsn);
      for (let i = 1; i < lsns.length; i++) {
        expect(lsns[i]).toBeGreaterThan(lsns[i - 1]!);
      }
    });
  });

  describe("Tool Calling", () => {
    it("should execute server-side tools and emit results", function* () {
      const echoTool = createMockTool("echo", "Echoes input");
      const provider = createMockProvider({
        responses: "Let me echo that",
        toolCalls: [{ id: "call-1", name: "echo", arguments: { input: "hello" } }],
      });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider, [echoTool]),
        maxToolIterations: 1,
      });

      const { result } = yield* call(() =>
        makeRequest(handler, [{ id: "user:echo", role: "user", content: "Echo something" }], {
          enabledTools: true,
        }),
      );

      // Should have tool calls event
      expect(result.toolCalls).not.toBeNull();
      expect(result.toolCalls?.[0]?.name).toBe("echo");

      // Should have tool result
      expect(result.toolResults).not.toBeNull();
      expect(result.toolResults?.[0]?.name).toBe("echo");
      expect(result.toolResults?.[0]?.content).toContain("Mock result for: hello");
    });

    it("should reject invalid tool parameters before server execution", function* () {
      let serverCalls = 0;
      const routeTool: LegacyTestTool = {
        name: "book_flight",
        description: "Book a flight",
        parameters: z.object({ from: z.string(), destination: z.string() }),
        server: function* (params: unknown) {
          serverCalls++;
          return { route: params };
        },
      };
      let providerCalls = 0;
      const provider = createMockProvider({
        customStream: (messages, options) => {
          const idx = providerCalls++;
          if (idx === 0) {
            return createMockProvider({
              responses: "Calling tool",
              toolCalls: [
                { id: "call-missing-from", name: "book_flight", arguments: { destination: "NYC" } },
              ],
            }).stream(messages, options);
          }
          return createMockProvider({ responses: "Where are you flying from?" }).stream(
            messages,
            options,
          );
        },
      });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider, [routeTool]),
        maxToolIterations: 2,
      });

      const { result } = yield* call(() =>
        makeRequest(
          handler,
          [{ id: "user:flight", role: "user", content: "I want to fly to NYC" }],
          {
            enabledTools: true,
          },
        ),
      );

      expect(serverCalls).toBe(0);
      expect(result.toolResults).toEqual([
        expect.objectContaining({
          id: "call-missing-from",
          name: "book_flight",
          content: expect.stringMatching(/TOOL_PARAMETER_VALIDATION_FAILED/),
        }),
      ]);
      expect(result.error).toMatchObject({
        type: "RUN_ERROR",
        code: "TOOL_PARAMETER_VALIDATION_FAILED",
      });
      expect(result.error?.message).toContain('Invalid parameters for tool "book_flight"');
    });

    it("should reconcile unique generated tool-name aliases before execution", function* () {
      const generatedTool = createMockTool("book-flight_book_flight", "Books a flight");
      const provider = createMockProvider({
        responses: "I will book that",
        toolCalls: [{ id: "call-1", name: "book-flight", arguments: { input: "NYC to LAX" } }],
      });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider, [generatedTool]),
        maxToolIterations: 1,
      });

      const { result } = yield* call(() =>
        makeRequest(handler, [{ id: "user:alias-tool", role: "user", content: "Book a flight" }], {
          enabledTools: true,
        }),
      );

      expect(result.toolCalls?.[0]?.name).toBe("book-flight_book_flight");
      expect(result.toolResults?.[0]?.name).toBe("book-flight_book_flight");
      expect(result.toolResults?.[0]?.content).toContain("Mock result for: NYC to LAX");
    });

    it("should reject ambiguous generated tool-name aliases with candidates", function* () {
      const first = createMockTool("book-flight_first", "First flight tool");
      const second = createMockTool("book-flight_second", "Second flight tool");
      const provider = createMockProvider({
        responses: "",
        toolCalls: [{ id: "call-ambiguous", name: "book-flight", arguments: { input: "NYC" } }],
      });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider, [first, second]),
        maxToolIterations: 1,
      });

      const { result } = yield* call(() =>
        makeRequest(handler, [{ id: "user:ambiguous", role: "user", content: "Book" }], {
          enabledTools: true,
        }),
      );

      expect(result.error).toMatchObject({
        type: "RUN_ERROR",
        code: "ambiguous_tool_alias",
      });
      expect(result.error?.message).toContain("book-flight_first");
      expect(result.error?.message).toContain("book-flight_second");
    });

    it("should fail with a stable code when the provider names an unsupported tool", function* () {
      const echoTool = createMockTool("echo", "Echoes input");
      const provider = createMockProvider({
        responses: "",
        toolCalls: [
          { id: "call-unsupported", name: "unsupported_tool", arguments: { input: "hello" } },
        ],
      });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider, [echoTool]),
        maxToolIterations: 1,
      });

      const { result } = yield* call(() =>
        makeRequest(
          handler,
          [{ id: "user:unsupported-tool", role: "user", content: "Call an unsupported tool" }],
          {
            enabledTools: true,
          },
        ),
      );

      expect(result.error).toMatchObject({
        type: "RUN_ERROR",
        code: "foreign_tool_not_found",
      });
      expect(result.error?.message).toBe("Tool not found: unsupported_tool");
      expect(result.toolCalls).toEqual([
        expect.objectContaining({ id: "call-unsupported", name: "unsupported_tool" }),
      ]);
      expect(result.toolResults).toEqual([
        expect.objectContaining({
          id: "call-unsupported",
          name: "unsupported_tool",
          content: expect.stringMatching(/error|foreign_tool_not_found/i),
        }),
      ]);
      expect(result.complete).toBeNull();
    });

    it("should emit AG-UI tool lifecycle events for server-side tools", function* () {
      const echoTool = createMockTool("echo", "Echoes input");
      const provider = createMockProvider({
        responses: "Let me echo that",
        toolCalls: [{ id: "call-1", name: "echo", arguments: { input: "hello" } }],
      });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider, [echoTool]),
        maxToolIterations: 1,
      });

      const { result } = yield* call(() =>
        makeRequest(handler, [{ id: "user:u1", role: "user", content: "Echo something" }], {
          conversationId: "thread-ag-ui-server-tool",
          enabledTools: true,
        }),
      );

      const toolStartEvents = getEventsByType(result, "TOOL_CALL_START") as Array<{
        type: "TOOL_CALL_START";
        toolCallId: string;
        toolCallName: string;
      }>;
      const toolArgEvents = getEventsByType(result, "TOOL_CALL_ARGS") as Array<{
        type: "TOOL_CALL_ARGS";
        toolCallId: string;
        delta: string;
      }>;
      const toolEndEvents = getEventsByType(result, "TOOL_CALL_END") as Array<{
        type: "TOOL_CALL_END";
        toolCallId: string;
      }>;

      expect(toolStartEvents).toEqual([
        {
          type: "TOOL_CALL_START",
          toolCallId: "call-1",
          toolCallName: "echo",
          parentMessageId: "assistant:tools:call-1",
        },
      ]);
      expect(toolArgEvents).toEqual([
        {
          type: "TOOL_CALL_ARGS",
          toolCallId: "call-1",
          delta: JSON.stringify({ input: "hello" }),
        },
      ]);
      expect(toolEndEvents).toEqual([
        {
          type: "TOOL_CALL_END",
          toolCallId: "call-1",
        },
      ]);
    });
  });

  describe("Error Handling", () => {
    it("should emit error event when provider throws", function* () {
      const provider = createMockProvider({
        customStream: () => {
          throw new Error("Provider error");
        },
      });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const { result } = yield* call(() =>
        makeRequest(handler, [{ id: "user:hi", role: "user", content: "Hi" }]),
      );

      // Should have error event
      expect(result.error).not.toBeNull();
      expect(result.error?.message).toContain("Provider error");
    });

    it("should emit error when provider is not configured", function* () {
      const handler = createTestDurableChatHandler({
        setup: function* () {
          // Only setup durable streams, no provider
          const bufferStore = createInMemoryBufferStore<string>();
          const registryStore = createInMemoryRegistryStore();
          yield* setupDurableStreams({ bufferStore, registryStore });
        },
      });

      const { result } = yield* call(() =>
        makeRequest(handler, [{ id: "user:hi", role: "user", content: "Hi" }]),
      );

      expect(result.error).not.toBeNull();
      expect(result.error?.message).toContain("Model provider not configured");
    });
  });

  describe("Session Management", () => {
    it("should return session ID in response headers", function* () {
      const provider = createMockProvider({ responses: "Hello" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const { sessionId } = yield* call(() =>
        makeRequest(handler, [{ id: "user:hi", role: "user", content: "Hi" }]),
      );

      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe("string");
      expect(sessionId?.length).toBeGreaterThan(0);
    });

    it("should return correct content type", function* () {
      const provider = createMockProvider({ responses: "Hello" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const { request } = createChatRequest([{ id: "user:hi", role: "user", content: "Hi" }]);
      const response = yield* call(() => handler(request));

      expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Stream-Next-Offset")).toBeDefined();
      expect(response.headers.get("ETag")).toBeDefined();
    });
  });

  describe("Protocol Alignment", () => {
    it("should support reconnect via /sessions/{id}?offset=N", function* () {
      const provider = createMockProvider({ responses: "one two three" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const { sessionId, result: initial } = yield* call(() =>
        makeRequest(handler, [{ id: "user:hi", role: "user", content: "Hi" }]),
      );

      const { request } = createChatRequest([], {
        sessionId: sessionId!,
        offset: Math.max(0, initial.lastLSN - 1),
        useSessionPath: true,
      });
      const response = yield* call(() => handler(request));

      expect(response.status).toBe(200);
      expect(response.headers.get("X-Session-Id")).toBe(sessionId);
      expect(response.headers.get("ETag")).toBeDefined();
      expect(response.headers.get("Stream-Next-Offset")).toBeDefined();
    });

    it("should return metadata for HEAD /sessions/{id}", function* () {
      const provider = createMockProvider({ responses: "head metadata" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const { request: initialRequest } = createChatRequest([
        { id: "user:hi", role: "user", content: "Hi" },
      ]);
      const initialResponse = yield* call(() => handler(initialRequest));
      const sessionId = initialResponse.headers.get("X-Session-Id");
      expect(sessionId).toBeDefined();

      const { request } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: "HEAD",
      });

      const response = yield* call(() => handler(request));
      expect(response.status).toBe(200);
      expect(response.headers.get("ETag")).toBeDefined();
      expect(response.headers.get("Stream-Next-Offset")).toBeDefined();
      expect(response.headers.get("Cache-Control")).toBe("no-store");

      // Ensure streaming response is cleaned up
      yield* call(async () => {
        await initialResponse.body?.cancel();
      });
    });

    it("should return 304 for If-None-Match when up-to-date", function* () {
      const provider = createMockProvider({ responses: "etag check" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const { request: initialRequest } = createChatRequest([
        { id: "user:hi", role: "user", content: "Hi" },
      ]);
      const initialResponse = yield* call(() => handler(initialRequest));
      const sessionId = initialResponse.headers.get("X-Session-Id");
      expect(sessionId).toBeDefined();

      const { request: headRequest } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: "HEAD",
      });
      const headResponse = yield* call(() => handler(headRequest));
      const offset = Number.parseInt(headResponse.headers.get("Stream-Next-Offset") ?? "0", 10);

      const { request: firstReconnect } = createChatRequest([], {
        sessionId: sessionId!,
        offset,
        useSessionPath: true,
      });
      const firstResponse = yield* call(() => handler(firstReconnect));
      const etag = firstResponse.headers.get("ETag");
      expect(etag).toBeDefined();

      const { request: secondReconnect } = createChatRequest([], {
        sessionId: sessionId!,
        offset,
        useSessionPath: true,
      });
      secondReconnect.headers.set("If-None-Match", etag!);

      const secondResponse = yield* call(() => handler(secondReconnect));
      expect(secondResponse.status).toBe(304);

      yield* call(async () => {
        await initialResponse.body?.cancel();
      });
    });

    it("should return 204 for long-poll timeout when up-to-date", function* () {
      const provider = createMockProvider({
        responses: "slow response",
        tokenDelayMs: 1_000,
      });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const { request: initialRequest } = createChatRequest([
        { id: "user:hi", role: "user", content: "Hi" },
      ]);
      const initialResponse = yield* call(() => handler(initialRequest));
      const sessionId = initialResponse.headers.get("X-Session-Id");
      expect(sessionId).toBeDefined();

      const { request: longPollRequest } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: "HEAD",
      });
      const headResponse = yield* call(() => handler(longPollRequest));
      const tailOffset = Number.parseInt(headResponse.headers.get("Stream-Next-Offset") ?? "0", 10);

      const { request: pollRequest } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: "GET",
        live: "long-poll",
        offset: tailOffset,
        timeout: 0,
      });

      const longPollResponse = yield* call(() => handler(pollRequest));
      expect(longPollResponse.status).toBe(204);
      expect(longPollResponse.headers.get("Stream-Up-To-Date")).toBe("true");
      expect(longPollResponse.headers.get("Stream-Cursor")).toBeDefined();

      yield* call(async () => {
        await initialResponse.body?.cancel();
      });
    });

    it("should return 200 for long-poll when backlog data exists", function* () {
      const provider = createMockProvider({ responses: "long poll backlog" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const { sessionId } = yield* call(() =>
        makeRequest(handler, [{ id: "user:hi", role: "user", content: "Hi" }]),
      );

      const { request: longPollRequest } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: "GET",
        live: "long-poll",
        offset: 0,
        timeout: 1,
      });

      const longPollResponse = yield* call(() => handler(longPollRequest));
      expect(longPollResponse.status).toBe(200);
      expect(longPollResponse.headers.get("Stream-Cursor")).toBeDefined();
      expect(longPollResponse.headers.get("Stream-Next-Offset")).toBeDefined();
    });

    it("should stream SSE data and control events", function* () {
      const provider = createMockProvider({ responses: "sse stream payload" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const { request: initialRequest } = createChatRequest([
        { id: "user:hi", role: "user", content: "Hi" },
      ]);
      const initialResponse = yield* call(() => handler(initialRequest));
      const sessionId = initialResponse.headers.get("X-Session-Id");
      expect(sessionId).toBeDefined();

      const { request } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: "GET",
        live: "sse",
        offset: 0,
      });
      const response = yield* call(() => handler(request));

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      const body = yield* call(() => response.text());
      expect(body).toContain("id: 0000000000000001");
      expect(body).toContain('data: {"type":"RUN_STARTED"');
      expect(body).not.toContain("event: control");
      expect(body).not.toContain("streamNextOffset");

      yield* call(async () => {
        await initialResponse.body?.cancel();
      });
    });

    it("should emit streamClosed control event for SSE at closed tail", function* () {
      const provider = createMockProvider({ responses: "closed stream" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const { request: initialRequest } = createChatRequest([
        { id: "user:hi", role: "user", content: "Hi" },
      ]);
      const initialResponse = yield* call(() => handler(initialRequest));
      const sessionId = initialResponse.headers.get("X-Session-Id");
      expect(sessionId).toBeDefined();

      // Keep one reconnect handle alive so completed session isn't cleaned up.
      const { request: holderRequest } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: "GET",
        offset: 0,
      });
      const holderResponse = yield* call(() => handler(holderRequest));

      // Drain initial response so writer reaches closed state.
      yield* call(() => initialResponse.text());

      const { request: headRequest } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: "HEAD",
      });
      const headResponse = yield* call(() => handler(headRequest));
      const tailOffset = Number.parseInt(headResponse.headers.get("Stream-Next-Offset") ?? "0", 10);

      const { request } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: "GET",
        live: "sse",
        offset: tailOffset,
      });

      const response = yield* call(() => handler(request));
      const body = yield* call(() => response.text());
      expect(body).toBe("");

      yield* call(async () => {
        await holderResponse.body?.cancel();
      });
    });

    it("should treat offset=-1 as stream beginning", function* () {
      const provider = createMockProvider({ responses: "offset beginning" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const { request: initialRequest } = createChatRequest([
        { id: "user:hi", role: "user", content: "Hi" },
      ]);
      const initialResponse = yield* call(() => handler(initialRequest));
      const sessionId = initialResponse.headers.get("X-Session-Id");
      expect(sessionId).toBeDefined();

      const { request } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: "GET",
        offset: -1,
      });
      const response = yield* call(() => handler(request));
      expect(response.status).toBe(200);

      const body = yield* call(() => response.text());
      expect(body).toContain('"lsn":1');

      yield* call(async () => {
        await initialResponse.body?.cancel();
      });
    });

    it("should treat offset=now as current tail for catch-up reads", function* () {
      const provider = createMockProvider({
        responses: "offset now",
        tokenDelayMs: 1_000,
      });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const { request: initialRequest } = createChatRequest([
        { id: "user:hi", role: "user", content: "Hi" },
      ]);
      const initialResponse = yield* call(() => handler(initialRequest));
      const sessionId = initialResponse.headers.get("X-Session-Id");
      expect(sessionId).toBeDefined();

      const nowUrl = new URL(`http://localhost/sessions/${encodeURIComponent(sessionId!)}`);
      nowUrl.searchParams.set("offset", "now");
      const nowRequest = new Request(nowUrl.toString(), {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const response = yield* call(() => handler(nowRequest));
      expect(response.status).toBe(200);
      expect(response.headers.get("Stream-Up-To-Date")).toBe("true");

      const body = yield* call(() => response.text());
      expect(body).toBe("");

      yield* call(async () => {
        await initialResponse.body?.cancel();
      });
    });

    it("should return [] for offset=now with JSON accept header", function* () {
      const provider = createMockProvider({
        responses: "offset now json",
        tokenDelayMs: 1_000,
      });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const { request: initialRequest } = createChatRequest([
        { id: "user:hi", role: "user", content: "Hi" },
      ]);
      const initialResponse = yield* call(() => handler(initialRequest));
      const sessionId = initialResponse.headers.get("X-Session-Id");
      expect(sessionId).toBeDefined();

      const nowUrl = new URL(`http://localhost/sessions/${encodeURIComponent(sessionId!)}`);
      nowUrl.searchParams.set("offset", "now");
      const nowRequest = new Request(nowUrl.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      const response = yield* call(() => handler(nowRequest));
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");

      const body = yield* call(() => response.text());
      expect(body.trim()).toBe("[]");

      yield* call(async () => {
        await initialResponse.body?.cancel();
      });
    });

    it("should return [] when caught up with JSON accept header", function* () {
      const provider = createMockProvider({ responses: "already caught up" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider, [], {
          retentionPolicy: { mode: "retain_forever" },
        }),
      });

      const { sessionId } = yield* call(() =>
        makeRequest(handler, [{ id: "user:hi", role: "user", content: "Hi" }]),
      );

      const { request: headRequest } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: "HEAD",
      });
      const headResponse = yield* call(() => handler(headRequest));
      const tailOffset = headResponse.headers.get("Stream-Next-Offset");
      expect(tailOffset).toBeDefined();

      const { request } = createChatRequest([], {
        sessionId: sessionId!,
        useSessionPath: true,
        method: "GET",
        offset: Number.parseInt(tailOffset ?? "0", 10),
        requestHeaders: {
          Accept: "application/json",
        },
      });

      const response = yield* call(() => handler(request));
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      const body = yield* call(() => response.text());
      expect(body.trim()).toBe("[]");
    });

    it("should support protocol-native PUT/POST/DELETE lifecycle on /sessions/{id}", function* () {
      const provider = createMockProvider({ responses: "unused" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const sessionId = "protocol-native-1";
      const sessionUrl = `http://localhost/sessions/${sessionId}`;

      const putResponse = yield* call(() =>
        handler(
          new Request(sessionUrl, {
            method: "PUT",
          }),
        ),
      );
      expect(putResponse.status).toBe(201);
      expect(putResponse.headers.get("Stream-Next-Offset")).toBe("0000000000000000");

      const appendResponse = yield* call(() =>
        handler(
          new Request(sessionUrl, {
            method: "POST",
            body: JSON.stringify({ type: "text", content: "hello protocol" }),
          }),
        ),
      );
      expect(appendResponse.status).toBe(204);
      expect(appendResponse.headers.get("Stream-Next-Offset")).toBe("0000000000000001");

      const closeResponse = yield* call(() =>
        handler(
          new Request(sessionUrl, {
            method: "POST",
            headers: {
              "Stream-Closed": "true",
            },
          }),
        ),
      );
      expect(closeResponse.status).toBe(204);
      expect(closeResponse.headers.get("Stream-Closed")).toBe("true");

      const { request: readRequest } = createChatRequest([], {
        sessionId,
        useSessionPath: true,
        method: "GET",
        offset: 0,
      });
      const readResponse = yield* call(() => handler(readRequest));
      expect(readResponse.status).toBe(200);
      const readBody = yield* call(() => readResponse.text());
      expect(readBody).toContain("hello protocol");

      const deleteResponse = yield* call(() =>
        handler(
          new Request(sessionUrl, {
            method: "DELETE",
          }),
        ),
      );
      expect(deleteResponse.status).toBe(204);

      const { request: headRequest } = createChatRequest([], {
        sessionId,
        useSessionPath: true,
        method: "HEAD",
      });
      const headResponse = yield* call(() => handler(headRequest));
      expect(headResponse.status).toBe(404);
    });
  });

  describe("Response Format", () => {
    it("should emit events as NDJSON with LSN", function* () {
      const provider = createMockProvider({ responses: "Test" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const { request } = createChatRequest([{ id: "user:hi", role: "user", content: "Hi" }]);
      const response = yield* call(() => handler(request));

      // Read raw response
      const text = yield* call(() => response.text());
      const lines = text.trim().split("\n");

      // Each line should be valid JSON with lsn and event
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(typeof parsed.lsn).toBe("number");
        expect(parsed.event).toBeDefined();
        expect(typeof parsed.event.type).toBe("string");
      }
    });

    it("should not emit legacy checkpoints for durable thread hydration", function* () {
      const provider = createMockProvider({ responses: "Test" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const { request } = createChatRequest([{ id: "user:u1", role: "user", content: "Hi" }], {
        conversationId: "thread-ag-ui-checkpoint",
      });
      const response = yield* call(() => handler(request));
      const text = yield* call(() => response.text());
      const events = text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).event);

      expect(events.some((event) => event.type === "ag_ui_checkpoint")).toBe(false);
      expect(events.some((event) => event.type === "MESSAGES_SNAPSHOT")).toBe(true);
    });

    it("should emit AG-UI run, message, and state events for threaded requests", function* () {
      const provider = createMockProvider({ responses: "Hello there" });
      const handler = createTestDurableChatHandler({
        setup: createTestHooks(provider),
      });

      const { request } = createChatRequest([{ id: "user:u1", role: "user", content: "Hi" }], {
        conversationId: "thread-ag-ui-events",
      });
      const response = yield* call(() => handler(request));
      const text = yield* call(() => response.text());
      const events = text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).event);

      expect(events.some((event) => event.type === "RUN_STARTED")).toBe(true);
      expect(events.some((event) => event.type === "MESSAGES_SNAPSHOT")).toBe(true);
      expect(events.some((event) => event.type === "STATE_SNAPSHOT")).toBe(true);
      expect(events.some((event) => event.type === "TEXT_MESSAGE_START")).toBe(true);
      expect(events.some((event) => event.type === "TEXT_MESSAGE_CONTENT")).toBe(true);
      expect(events.some((event) => event.type === "TEXT_MESSAGE_END")).toBe(true);
    });
  });
});
