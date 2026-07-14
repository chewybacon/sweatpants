import {
  call,
  createChannel,
  createScope,
  each,
  run,
  sleep,
  spawn,
  suspend,
  type Operation,
} from "effection";
import { describe, expect, it } from "vitest";

import {
  CrankStoreContext,
  createCapabilityKeyring,
  createChatHandler,
  createInMemoryProgramDriverJournalStore,
  createPluginSessionManager,
  createInMemoryCrankStore,
  type PluginSessionManager,
} from "@sweatpants/framework/server";
import { setupInMemoryDurableStreams } from "@sweatpants/framework/chat/durable-streams";
import {
  McpToolRegistryContext,
  PluginRegistryContext,
  PluginSessionManagerContext,
  ToolInventoryContext,
  createToolInventory,
  createToolInventoryEntry,
} from "@sweatpants/framework/chat";
import { createChatSession } from "../../../../packages/framework/src/lib/chat/session/create-session.ts";
import type { Message } from "../../../../packages/framework/src/lib/chat/types.ts";
import type { ChatState } from "../../../../packages/framework/src/lib/chat/state/chat-state.ts";
import { initialChatState } from "../../../../packages/framework/src/lib/chat/state/index.ts";
import {
  createPluginRegistryFrom,
  type ToolSessionRegistry,
} from "@sweatpants/framework/chat/mcp-tools";
import {
  createInMemoryToolSessionStore,
  createToolSessionRegistry,
  installLocalToolRuntime,
} from "@sweatpants/tool-runtime-local";
import { yoChatTestToolSessionWorkerConfig } from "../server/tool-worker-config.ts";
import {
  createMockProvider,
  setupMockModelProvider,
} from "../../../../packages/framework/src/handler/durable/__tests__/test-utils.ts";
import { pickCard, pickCardPlugin } from "../tools/pick-card";

type PendingElicit = ChatState["pendingElicits"][string]["elicitations"][number];

function createSingleToolMcpRegistry(tool: { name: string }) {
  const map = new Map<string, unknown>([[tool.name, tool]]);
  return {
    get: (name: string) => map.get(name),
    has: (name: string) => map.has(name),
    names: () => Array.from(map.keys()),
  };
}

function findPendingElicit(state: ChatState, key: string, callId?: string): PendingElicit | null {
  for (const tracking of Object.values(state.pendingElicits)) {
    for (const elicit of tracking.elicitations) {
      if (
        elicit.key === key &&
        elicit.status === "pending" &&
        (!callId || elicit.callId === callId)
      ) {
        return elicit;
      }
    }
  }

  return null;
}

function countAssistantMessagesContaining(state: ChatState, text: string): number {
  return state.messages.filter(
    (message) => message.role === "assistant" && message.content.includes(text),
  ).length;
}

function* waitForState(
  label: string,
  getState: () => ChatState,
  predicate: (state: ChatState) => boolean,
  timeoutMs = 10_000,
): Operation<ChatState> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const state = getState();
    if (predicate(state)) {
      return state;
    }
    yield* sleep(25);
  }

  throw new Error(`Timeout waiting for state: ${label}`);
}

describe("pick_card session history", () => {
  it("keeps the selected card in subsequent-turn history for the model", async () => {
    await run(function* () {
      const pluginRegistry = createPluginRegistryFrom([pickCardPlugin.client as any]);
      const mcpToolRegistry = createSingleToolMcpRegistry(pickCard);

      const [serverScope, destroyServerScope] = createScope();
      const ready = createChannel<
        { registry: ToolSessionRegistry; manager: PluginSessionManager; samplingProvider: any },
        void
      >();

      serverScope.run(function* () {
        const store = createInMemoryToolSessionStore();
        const samplingProvider = {
          *sample() {
            return { text: "unused", model: "mock", stopReason: "endTurn" as const };
          },
        };

        const registry = yield* createToolSessionRegistry(store, {
          samplingProvider,
          worker: yoChatTestToolSessionWorkerConfig,
        });
        const manager = yield* createPluginSessionManager({ registry });

        yield* ready.send({ registry, manager, samplingProvider });
        yield* suspend();
      });

      const readySub = yield* ready;
      const readyResult = yield* readySub.next();
      if (readyResult.done) {
        throw new Error("PluginSessionManager setup channel closed unexpectedly");
      }
      const {
        registry: toolSessionRegistry,
        manager: pluginSessionManager,
        samplingProvider,
      } = readyResult.value;

      const providerMessages: Message[][] = [];
      const crankStore = createInMemoryCrankStore();
      const provider = createMockProvider({
        customStream: (messages, options) => {
          providerMessages.push(JSON.parse(JSON.stringify(messages)) as Message[]);

          const lastMessage = messages[messages.length - 1];
          if (lastMessage?.role === "user" && /draw a card/i.test(lastMessage.content)) {
            return createMockProvider({
              responses: "Calling pick_card tool",
              toolCalls: [
                {
                  id: "pick-card-call-1",
                  name: pickCard.name,
                  arguments: { count: 5 },
                },
              ],
            }).stream(messages, options);
          }

          if (
            lastMessage?.role === "user" &&
            /what card did i just pick/i.test(lastMessage.content)
          ) {
            const hasToolResult = messages.some(
              (message) => message.role === "tool" && /5 of Spades|5♠/i.test(message.content),
            );
            const hasAssistantAck = messages.some(
              (message) => message.role === "assistant" && /5 of Spades|5♠/i.test(message.content),
            );
            return createMockProvider({
              responses:
                hasToolResult && hasAssistantAck
                  ? "You picked the 5 of Spades."
                  : "I don't have any record of you picking a card yet.",
            }).stream(messages, options);
          }

          const latestToolMessage = [...messages]
            .reverse()
            .find((message) => message.role === "tool");
          if (latestToolMessage?.content.includes("5 of Spades")) {
            return createMockProvider({
              responses: "Great choice! You selected the 5 of Spades from the 5 cards!",
            }).stream(messages, options);
          }

          return createMockProvider({ responses: "No action needed" }).stream(messages, options);
        },
      });

      const setup = function* setup() {
        yield* setupInMemoryDurableStreams<string>();
        yield* CrankStoreContext.set(crankStore);
        yield* setupMockModelProvider(provider);
        yield* PluginRegistryContext.set(pluginRegistry);
        yield* McpToolRegistryContext.set(mcpToolRegistry);
        yield* PluginSessionManagerContext.set(pluginSessionManager);
        const localPickCardTool = pickCard;
        yield* ToolInventoryContext.set(
          createToolInventory([createToolInventoryEntry(localPickCardTool)]),
        );
        yield* installLocalToolRuntime({
          tools: [localPickCardTool],
          registry: toolSessionRegistry,
          samplingProvider,
        });
      };

      const handler = createChatHandler({
        setup,
        maxToolIterations: 5,
        programDriverJournalStore: createInMemoryProgramDriverJournalStore({
          keyring: createCapabilityKeyring("pick-card-history", [
            { keyId: "test-v1", secret: "pick-card-history-program-secret" },
          ]),
        }),
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const { signal: _signal, ...restInit } = init ?? {};
        const rawUrl =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const url =
          rawUrl.startsWith("http://") || rawUrl.startsWith("https://")
            ? rawUrl
            : `http://localhost${rawUrl}`;
        return handler(new Request(url, restInit));
      };

      try {
        const { state, dispatch } = yield* createChatSession({
          baseUrl: "http://localhost/chat",
          plugins: [pickCardPlugin],
          conversationId: "thread-pick-card-memory",
        });
        let currentState = initialChatState;

        yield* spawn(function* () {
          for (const nextState of yield* each(state)) {
            currentState = nextState;
            yield* each.next();
          }
        });

        yield* sleep(0);

        dispatch({ type: "send", content: "draw a card from 5 cards" });

        const firstElicitState = yield* waitForState(
          "pickCard elicit",
          () => currentState,
          (candidate) =>
            !candidate.isStreaming && findPendingElicit(candidate, "pickCard") !== null,
          20_000,
        );
        const pending = findPendingElicit(firstElicitState, "pickCard");
        expect(pending?.callId).toBe("pick-card-call-1");

        dispatch({
          type: "elicit_response",
          sessionId: pending!.sessionId,
          callId: pending!.callId,
          elicitId: pending!.elicitId,
          result: {
            action: "accept",
            content: { picked: { rank: "5", suit: "Spades", display: "5♠" } },
          },
        });

        yield* waitForState(
          "assistant acknowledges picked card",
          () => currentState,
          (candidate) =>
            !candidate.isStreaming &&
            countAssistantMessagesContaining(candidate, "5 of Spades") >= 1,
          20_000,
        );

        dispatch({ type: "send", content: "What card did I just pick?" });
        yield* sleep(500);

        const followupRequest = providerMessages.find((messages) => {
          const last = messages[messages.length - 1];
          return last?.role === "user" && /what card did i just pick/i.test(last.content);
        });

        expect(followupRequest).toBeDefined();
        expect(
          followupRequest?.some(
            (message) => message.role === "tool" && /5 of Spades|5♠/i.test(message.content),
          ),
        ).toBe(true);
        expect(
          followupRequest?.some(
            (message) => message.role === "assistant" && /5 of Spades|5♠/i.test(message.content),
          ),
        ).toBe(true);

        yield* waitForState(
          "follow-up answer mentions selected card",
          () => currentState,
          (candidate) =>
            !candidate.isStreaming &&
            countAssistantMessagesContaining(candidate, "You picked the 5 of Spades.") >= 1,
          20_000,
        );
      } finally {
        globalThis.fetch = originalFetch;
        yield* call(() => destroyServerScope());
      }
    });
  }, 60_000);
});
