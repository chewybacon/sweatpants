/**
 * Differentiator demo acceptance: Reconnect mid-stream (REQ-021).
 *
 * Classification: acceptance (protocol/handler).
 * Reuses durable handler test harness (mock provider + shared buffer stores).
 */
import { describe, expect, it } from "./../src/handler/durable/__tests__/vitest-effection.ts";
import { call } from "effection";
import { createInMemoryProgramDriverJournalStore } from "../src/handler/durable/index.ts";
import { createCapabilityKeyring } from "@sweatpants/session-contract";
import {
  createMockProvider,
  createTestDurableChatHandler,
  createChatRequest,
  consumeDurableResponse,
  getEventsByType,
  setupMockModelProvider,
  setupMockTools,
} from "../src/handler/durable/__tests__/test-utils.ts";
import {
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  setupDurableStreams,
} from "../src/lib/chat/durable-streams/index.ts";
import type { RetentionPolicy } from "@sweatpants/durable-streams";
import type { ChatHandlerSetup } from "../src/handler/durable/types.ts";

const retainForever: RetentionPolicy = { mode: "retain_forever" };

function createSharedStoreHooks(provider: ReturnType<typeof createMockProvider>): ChatHandlerSetup {
  const bufferStore = createInMemoryBufferStore<string>();
  const registryStore = createInMemoryRegistryStore();
  return function* setup() {
    yield* setupDurableStreams({
      bufferStore,
      registryStore,
      retentionPolicy: retainForever,
    });
    yield* setupMockModelProvider(provider);
    // Empty tool inventory is required for a complete durable turn setup
    // (matches createTestHooks in handler unit tests).
    yield* setupMockTools([]);
  };
}

describe("demo: reconnect mid-stream", () => {
  it("continues server work after client disconnect and replays complete turn", function* () {
    const provider = createMockProvider({
      responses: "Disconnect and finish the turn completely",
      tokenDelayMs: 40,
    });
    const handler = createTestDurableChatHandler({
      setup: createSharedStoreHooks(provider),
    });

    const conversationId = `demo-reconnect-${Date.now()}`;
    const { request: initialRequest } = createChatRequest(
      [{ id: "user:disconnect", role: "user", content: "Keep going" }],
      { conversationId },
    );
    const initialResponse = yield* call(() => handler(initialRequest));
    expect(initialResponse.status).toBe(200);

    // Disconnect mid-stream
    yield* call(async () => {
      await initialResponse.body?.cancel();
    });

    // Allow producer to finish
    yield* call(() => new Promise((r) => setTimeout(r, 400)));

    const { request } = createChatRequest([], {
      method: "GET",
      conversationId,
    });
    const response = yield* call(() => handler(request));
    expect(response.status).toBe(200);

    const replay = yield* call(() => consumeDurableResponse(response));
    const snapshots = getEventsByType(replay, "MESSAGES_SNAPSHOT") as Array<{
      type: "MESSAGES_SNAPSHOT";
      messages: Array<{ role: string; content?: string }>;
    }>;

    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]?.messages).toMatchObject([
      { role: "user", content: "Keep going" },
      { role: "assistant", content: "Disconnect and finish the turn completely" },
    ]);
  });

  it("continues ProgramRuntime work after the response disconnects", function* () {
    const provider = createMockProvider({
      responses: "ProgramRuntime survives response disconnect",
      tokenDelayMs: 40,
    });
    const handler = createTestDurableChatHandler({
      setup: createSharedStoreHooks(provider),
      programDriverJournalStore: createInMemoryProgramDriverJournalStore({
        keyring: createCapabilityKeyring("program-reconnect", [
          { keyId: "test-v1", secret: "program-reconnect-acceptance-key" },
        ]),
      }),
    });
    const conversationId = `program-reconnect-${Date.now()}`;
    const { request: initialRequest } = createChatRequest(
      [{ id: "user:program-disconnect", role: "user", content: "Keep going" }],
      { conversationId },
    );
    const initialResponse = yield* call(() => handler(initialRequest));
    yield* call(async () => {
      await initialResponse.body?.cancel();
    });
    yield* call(() => new Promise((resolve) => setTimeout(resolve, 400)));

    const { request } = createChatRequest([], { method: "GET", conversationId });
    const response = yield* call(() => handler(request));
    const replay = yield* call(() => consumeDurableResponse(response));
    const snapshots = getEventsByType(replay, "MESSAGES_SNAPSHOT") as Array<{
      type: "MESSAGES_SNAPSHOT";
      messages: Array<{ role: string; content?: string }>;
    }>;

    expect(snapshots[0]?.messages).toMatchObject([
      { role: "user", content: "Keep going" },
      { role: "assistant", content: "ProgramRuntime survives response disconnect" },
    ]);
  });

  it("supports session path reconnect from offset (protocol)", function* () {
    const provider = createMockProvider({ responses: "one two three four five" });
    const handler = createTestDurableChatHandler({
      setup: createSharedStoreHooks(provider),
    });

    const { sessionId, result: initial } = yield* call(async () => {
      const { request } = createChatRequest([{ id: "user:hi", role: "user", content: "Hi" }]);
      const response = await handler(request);
      const result = await consumeDurableResponse(response);
      return {
        sessionId: response.headers.get("X-Session-Id"),
        result,
      };
    });

    expect(sessionId).toBeTruthy();
    expect(initial.complete).not.toBeNull();
    expect(initial.lastLSN).toBeGreaterThan(0);

    const { request } = createChatRequest([], {
      sessionId: sessionId!,
      offset: Math.max(0, initial.lastLSN - 1),
      useSessionPath: true,
    });
    const response = yield* call(() => handler(request));

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Session-Id")).toBe(sessionId);
    expect(response.headers.get("Stream-Next-Offset")).toBeDefined();
  });
});
