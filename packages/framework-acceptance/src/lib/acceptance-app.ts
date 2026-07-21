import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Operation } from "effection";
import {
  createCapabilityKeyring,
  createChatApplication,
  createChatHandler,
  createInMemoryProgramDriverJournalStore,
  ProgramDriverForeignEffectsContext,
} from "@sweatpants/framework/server";
import {
  createToolInventory,
  createToolInventoryEntry,
  ToolInventoryContext,
  type ExtendedMessage,
  type Message,
} from "@sweatpants/framework/chat";
import { setupInMemoryDurableStreams } from "@sweatpants/framework/chat/durable-streams";
import type { ToolSessionSamplingProvider } from "@sweatpants/framework/chat/mcp-tools";
import {
  createPiAiModelProviderDriver,
  type AssistantMessage as ModelAssistantMessage,
  type Context as ModelContext,
  type Message as ModelMessage,
} from "@sweatpants/model-provider-pi-ai";
import {
  createInMemoryToolSessionStore,
  createToolSessionForeignEffectRegistrations,
  createToolSessionRegistry,
  installLocalToolRuntime,
} from "@sweatpants/tool-runtime-local";
import type { TestApplication, TestApplicationFactoryContext } from "@sweatpants/test-rig";
import { acceptanceBookingTool } from "../fixtures/acceptance-booking.tool.ts";

export {
  acceptanceBookingTool,
  ACCEPTANCE_TOOL_NAME,
  NESTED_SAMPLE_PROMPT_MARKER,
  NESTED_SAMPLE_RESPONSE_MARKER,
  TOOL_RESULT_MARKER,
} from "../fixtures/acceptance-booking.tool.ts";

export const ACCEPTANCE_MODEL_ID = "sweatpants-acceptance";
export const OUTER_TERMINAL_TEXT = "OUTER_TERMINAL_V1 Booking complete.";
export const CALL_ID = "call_acceptance_1";

const workerFixtureCandidates = [
  resolve(process.cwd(), "src/fixtures/acceptance-tool-worker-bootstrap.mjs"),
  resolve(
    process.cwd(),
    "packages/framework-acceptance/src/fixtures/acceptance-tool-worker-bootstrap.mjs",
  ),
];

function resolveWorkerBootstrapUrl(): URL {
  const candidate = workerFixtureCandidates.find((path) => existsSync(path));
  if (!candidate) {
    throw new Error("Failed to resolve acceptance-tool-worker-bootstrap.mjs");
  }
  return pathToFileURL(candidate);
}

function contentText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

function extendedToProviderMessage(message: ExtendedMessage, index: number): Message {
  const id = `sample-${index}`;
  if (message.role === "system") {
    return { id, role: "system", content: contentText(message.content) };
  }
  if (message.role === "user") {
    return { id, role: "user", content: contentText(message.content) };
  }
  if (message.role === "assistant") {
    return { id, role: "assistant", content: contentText(message.content) };
  }
  const toolCallId =
    "toolCallId" in message && typeof message.toolCallId === "string"
      ? message.toolCallId
      : "tool_call_id" in message && typeof message.tool_call_id === "string"
        ? message.tool_call_id
        : "";
  return {
    id,
    role: "tool",
    content: contentText(message.content),
    tool_call_id: toolCallId,
  };
}

function providerToModelMessage(message: Message): ModelMessage {
  if (message.role === "system") {
    return { role: "system", content: message.content };
  }
  if (message.role === "user") {
    return { role: "user", content: message.content };
  }
  if (message.role === "tool") {
    return {
      role: "toolResult",
      toolCallId: message.tool_call_id ?? "",
      toolName: "",
      content: [{ type: "text", text: message.content }],
      isError: false,
    };
  }
  return {
    role: "assistant",
    content: message.content ? [{ type: "text", text: message.content }] : [],
  };
}

function assistantText(message: ModelAssistantMessage): string {
  return message.content
    .filter(
      (block): block is Extract<ModelAssistantMessage["content"][number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

function createSamplingProvider(
  context: TestApplicationFactoryContext,
): ToolSessionSamplingProvider {
  const driver = createPiAiModelProviderDriver();
  return {
    *sample(messages, options) {
      const modelMessages = messages
        .map((message, index) => extendedToProviderMessage(message, index))
        .map(providerToModelMessage);
      const modelContext: ModelContext = {
        messages: modelMessages,
        ...(options?.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      };
      const assistant = yield* driver.sample({
        model: context.model.model,
        context: modelContext,
        options: {
          ...context.model.streamOptions,
          ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        },
      });
      return { text: assistantText(assistant) };
    },
  };
}

export function createAcceptanceApplication(
  context: TestApplicationFactoryContext,
): TestApplication {
  const inventory = createToolInventory([createToolInventoryEntry(acceptanceBookingTool)]);
  const samplingProvider = createSamplingProvider(context);

  return createChatApplication({
    setup: function* (): Operation<void> {
      yield* setupInMemoryDurableStreams<string>();
      yield* ToolInventoryContext.set(inventory);

      const registry = yield* createToolSessionRegistry(createInMemoryToolSessionStore(), {
        worker: {
          workerUrl: resolveWorkerBootstrapUrl(),
          isDev: false,
        },
      });

      yield* ProgramDriverForeignEffectsContext.set(
        createToolSessionForeignEffectRegistrations({
          registry,
          tools: new Map([[acceptanceBookingTool.name, acceptanceBookingTool]]),
        }),
      );

      yield* installLocalToolRuntime({
        tools: [acceptanceBookingTool],
        registry,
        samplingProvider,
      });
    },
    handler: createChatHandler({
      programDriverJournalStore: createInMemoryProgramDriverJournalStore({
        keyring: createCapabilityKeyring("test-rig-acceptance", [
          {
            keyId: "test-v1",
            secret: "test-rig-acceptance-secret-at-least-32-bytes",
          },
        ]),
      }),
      setup: function* (): Operation<void> {
        yield* context.model.install();
      },
      maxToolIterations: 4,
    }),
  });
}
