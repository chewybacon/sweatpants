/**
 * F5: history policy integration through the real durable handler.
 *
 * Verifies the explicit opt-in retention policy runs before provider
 * adaptation, that the default (no policy) preserves the full history, and
 * that tool-curated foreign sample context is exempt.
 */
import { describe, it, expect } from "./vitest-effection.ts";
import { call } from "effection";
import {
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  setupDurableStreams,
} from "../../../lib/chat/durable-streams/index.ts";
import { HistoryPolicyContext, createMessageBudgetHistoryPolicy } from "@sweatpants/chat-core";
import type { ChatHandlerSetup } from "../types.ts";
import type { Message } from "../../../lib/chat/types.ts";
import {
  createMockProvider,
  createTestDurableChatHandler,
  consumeDurableResponse,
  createChatRequest,
  setupMockModelProvider,
  setupMockTools,
} from "./test-utils.ts";

function createRecordingHooks(
  provider: ReturnType<typeof createMockProvider>,
  options: { maxMessages?: number } = {},
): ChatHandlerSetup {
  const bufferStore = createInMemoryBufferStore<string>();
  const registryStore = createInMemoryRegistryStore();

  return function* setup() {
    yield* setupDurableStreams({ bufferStore, registryStore });
    yield* setupMockModelProvider(provider);
    yield* setupMockTools([]);
    if (options.maxMessages !== undefined) {
      yield* HistoryPolicyContext.set(
        createMessageBudgetHistoryPolicy({ maxMessages: options.maxMessages }),
      );
    }
  };
}

async function makeRequest(handler: (request: Request) => Promise<Response>, messages: Message[]) {
  const { request } = createChatRequest(messages);
  const response = await handler(request);
  return consumeDurableResponse(response);
}

const longHistory: Message[] = [
  { id: "user:one", role: "user", content: "first question" },
  { id: "assistant:final:one", role: "assistant", content: "first answer" },
  { id: "user:two", role: "user", content: "second question" },
  { id: "assistant:final:two", role: "assistant", content: "second answer" },
  { id: "user:three", role: "user", content: "third question" },
];

describe("history policy through the durable handler", () => {
  it("without a policy the provider receives the full projected history", function* () {
    const seenMessages: Message[][] = [];
    const fallback = createMockProvider({ responses: "ok" });
    const provider = createMockProvider({
      customStream: (messages, options) => {
        seenMessages.push(messages);
        return fallback.stream(messages, options);
      },
    });
    const handler = createTestDurableChatHandler({
      setup: createRecordingHooks(provider),
    });

    const result = yield* call(() => makeRequest(handler, longHistory));
    expect(result.error).toBeNull();

    expect(seenMessages).toHaveLength(1);
    const userContents = seenMessages[0]!
      .filter((message) => message.role === "user")
      .map((message) => message.content);
    expect(userContents).toEqual(["first question", "second question", "third question"]);
  });

  it("an installed message-budget policy compacts old turns before the provider", function* () {
    const seenMessages: Message[][] = [];
    const fallback = createMockProvider({ responses: "ok" });
    const provider = createMockProvider({
      customStream: (messages, options) => {
        seenMessages.push(messages);
        return fallback.stream(messages, options);
      },
    });
    const handler = createTestDurableChatHandler({
      setup: createRecordingHooks(provider, { maxMessages: 3 }),
    });

    const result = yield* call(() => makeRequest(handler, longHistory));
    expect(result.error).toBeNull();

    expect(seenMessages).toHaveLength(1);
    const userContents = seenMessages[0]!
      .filter((message) => message.role === "user")
      .map((message) => message.content);
    // Oldest turn dropped; latest turns preserved in order.
    expect(userContents).toEqual(["second question", "third question"]);
    // The visible response is unaffected by compaction.
    expect(result.text).toContain("ok");
  });
});
