// @vitest-environment node
import { resource, type Operation, type Stream } from "effection";
import { describe, expect, it } from "vitest";
import {
  ModelProviderContext,
  ModelProviderModelContext,
  type AssistantMessage,
  type Model,
  type ModelProviderDriver,
  type StreamEvent,
} from "@sweatpants/framework/chat";
import {
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  setupDurableStreams,
} from "@sweatpants/framework/chat/durable-streams";
import {
  createCapabilityKeyring,
  createChatApplication,
  createDurableChatHandler,
  createInMemoryProgramDriverJournalStore,
  createPluginSessionManager,
} from "@sweatpants/framework/server";
import {
  createInMemoryToolSessionStore,
  createToolSessionRegistry,
} from "@sweatpants/tool-runtime-local";

import { allTools } from "../src/server/tools.ts";
import { installYoChatToolRuntime } from "../src/server/tool-runtime-installation.ts";
import { yoChatToolSessionWorkerConfig } from "../src/server/tool-worker-config.ts";

const model: Model = {
  id: "calculator-program-driver",
  name: "Calculator ProgramDriver",
  api: "test",
  provider: "test",
  reasoning: false,
  input: ["text"],
  contextWindow: 16_000,
  maxTokens: 1_000,
};

describe("immediate worker tool through ProgramRuntime HTTP", () => {
  it("completes calculator and performs the following model sample", async () => {
    let calls = 0;
    const driver: ModelProviderDriver = {
      stream(): Stream<StreamEvent, AssistantMessage> {
        calls += 1;
        return completed(
          calls === 1
            ? {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "toolu_vrtx_01FfNucgXHWrdUXARo41G3sc",
                    name: "calculator",
                    arguments: { expression: "8374 * 923" },
                  },
                ],
                stopReason: "toolUse",
              }
            : {
                role: "assistant",
                content: [{ type: "text", text: "Calculation complete" }],
                stopReason: "stop",
              },
        );
      },
      *sample(): Operation<never> {
        throw new Error("Streaming seam required");
      },
    };
    const journalStore = createInMemoryProgramDriverJournalStore({
      keyring: createCapabilityKeyring("calculator-http", [
        { keyId: "test-v1", secret: "calculator-http-program-driver-key" },
      ]),
    });
    const handler = createDurableChatHandler({
      programDriverJournalStore: journalStore,
      setup: function* () {
        yield* ModelProviderContext.set(driver);
        yield* ModelProviderModelContext.set(model);
      },
    });
    const application = createChatApplication({
      handler,
      setup: function* () {
        yield* setupDurableStreams({
          bufferStore: createInMemoryBufferStore<string>(),
          registryStore: createInMemoryRegistryStore(),
        });
        const registry = yield* createToolSessionRegistry(createInMemoryToolSessionStore(), {
          worker: yoChatToolSessionWorkerConfig,
        });
        const samplingProvider = {
          *sample(): Operation<never> {
            throw new Error("Calculator must not sample");
          },
        };
        const pluginManager = yield* createPluginSessionManager({
          registry,
        });
        yield* installYoChatToolRuntime({
          mode: "local",
          registry,
          pluginManager,
          samplingProvider,
          tools: [...allTools],
        });
      },
    });

    try {
      const response = await application.handle(
        new Request("http://localhost/chat?conversationId=calculator-http", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ id: "user:calculator", role: "user", content: "calculate" }],
            enabledTools: true,
          }),
        }),
      );
      const events = (await response.text())
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)["event"] as { type: string; delta?: string });
      expect(events.some((event) => event.type === "TOOL_CALL_RESULT")).toBe(true);
      expect(events.some((event) => event.delta === "Calculation complete")).toBe(true);
      expect(calls).toBe(2);
    } finally {
      await application.close();
    }
  }, 20_000);
});

function completed(message: AssistantMessage): Stream<StreamEvent, AssistantMessage> {
  return resource(function* (provide) {
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, AssistantMessage>> {
        return { done: true, value: message };
      },
    });
  });
}
