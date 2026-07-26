import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Operation } from "effection";
import {
  createCapabilityKeyring,
  createChatApplication,
  createChatHandler,
  createInMemoryProgramDriverJournalStore,
  ProgramDriverNativeToolsContext,
  programDriverSchemaRegistry,
  type ProgramDriverJournalStore,
} from "@sweatpants/framework/server";
import {
  createToolInventory,
  createToolInventoryEntry,
  ToolInventoryContext,
  type ExtendedMessage,
  type Message,
} from "@sweatpants/framework/chat";
import { setupInMemoryDurableStreams } from "@sweatpants/framework/chat/durable-streams";
import type {
  ToolSessionRegistry,
  ToolSessionSamplingProvider,
} from "@sweatpants/framework/chat/mcp-tools";
import {
  createPiAiModelProviderDriver,
  type AssistantMessage as ModelAssistantMessage,
  type Context as ModelContext,
  type Message as ModelMessage,
} from "@sweatpants/model-provider-pi-ai";
import {
  createDurableToolRegistry,
  type DurableToolRegistry,
  type ProgramDriver,
  type ProgramRoute,
} from "@sweatpants/session-contract";
import {
  createInMemoryToolSessionStoreWithDebug,
  createLocalWorkerDurableProgramDriver,
  createToolSessionRegistry,
  installLocalProgramToolRuntime,
} from "@sweatpants/tool-runtime-local";
import type { TestApplication, TestApplicationFactoryContext } from "@sweatpants/test-rig";
import { acceptanceBookingTool } from "../fixtures/acceptance-booking.tool.ts";
import {
  acceptanceDurableTool,
  durableOptionsProvider,
} from "../fixtures/acceptance-durable.tool.ts";
import { acceptanceImmediateTool } from "../fixtures/acceptance-immediate.tool.ts";

export {
  acceptanceBookingTool,
  ACCEPTANCE_TOOL_NAME,
  NESTED_SAMPLE_PROMPT_MARKER,
  NESTED_SAMPLE_RESPONSE_MARKER,
  TOOL_RESULT_MARKER,
} from "../fixtures/acceptance-booking.tool.ts";
export {
  acceptanceImmediateTool,
  ACCEPTANCE_IMMEDIATE_TOOL_NAME,
  IMMEDIATE_RESULT_MARKER,
} from "../fixtures/acceptance-immediate.tool.ts";
export {
  acceptanceDurableTool,
  ACCEPTANCE_DURABLE_TOOL_NAME,
  DURABLE_EFFECT_NAME,
  DURABLE_SAMPLE_PROMPT_MARKER,
  DURABLE_SAMPLE_RESPONSE_MARKER,
  DURABLE_TOOL_RESULT_MARKER,
  DURABLE_RECORDED_MARKER,
} from "../fixtures/acceptance-durable.tool.ts";

export const ACCEPTANCE_MODEL_ID = "sweatpants-acceptance";
export const OUTER_TERMINAL_TEXT = "OUTER_TERMINAL_V1 Booking complete.";
export const CALL_ID = "call_acceptance_1";

function resolveFixtureBootstrapUrl(filename: string): URL {
  const candidates = [
    resolve(process.cwd(), `src/fixtures/${filename}`),
    resolve(process.cwd(), `packages/framework-acceptance/src/fixtures/${filename}`),
  ];
  const candidate = candidates.find((path) => existsSync(path));
  if (!candidate) {
    throw new Error(`Failed to resolve ${filename}`);
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

export interface DurableWorkerMetrics {
  activeAttachments: number;
  attachmentCount: number;
  shutdownCount: number;
}

export interface AcceptanceApplicationInspection {
  journalStore: ProgramDriverJournalStore;
  durableWorker: DurableWorkerMetrics;
  get toolSessionRegistry(): ToolSessionRegistry | undefined;
  get toolSessionIds(): readonly string[];
}

export interface AcceptanceApplicationOptions {
  maxToolIterations?: number;
  retainResponseStreams?: boolean;
  /** Shared durable substrate used when a test-rig scenario replaces a Host generation. */
  journalStore?: ProgramDriverJournalStore;
  durableDriverKind?: string;
  durableRoute?: ProgramRoute;
  createDurableDriver?(registry: DurableToolRegistry): ProgramDriver;
}

export function createAcceptanceApplication(
  context: TestApplicationFactoryContext,
  inspect?: (inspection: AcceptanceApplicationInspection) => void,
  options: AcceptanceApplicationOptions = {},
): TestApplication {
  const inventory = createToolInventory([
    createToolInventoryEntry(acceptanceBookingTool),
    createToolInventoryEntry(acceptanceImmediateTool),
    createToolInventoryEntry(acceptanceDurableTool),
  ]);
  const samplingProvider = createSamplingProvider(context);
  const durableWorker: DurableWorkerMetrics = {
    activeAttachments: 0,
    attachmentCount: 0,
    shutdownCount: 0,
  };
  let toolSessionRegistry: ToolSessionRegistry | undefined;
  let toolSessionStore: ReturnType<typeof createInMemoryToolSessionStoreWithDebug> | undefined;
  const journalStore =
    options.journalStore ??
    createInMemoryProgramDriverJournalStore({
      keyring: createCapabilityKeyring("test-rig-acceptance", [
        {
          keyId: "test-v1",
          secret: "test-rig-acceptance-secret-at-least-32-bytes",
        },
      ]),
      schemaRegistry: programDriverSchemaRegistry(acceptanceDurableTool.artifacts.catalog),
    });
  inspect?.({
    journalStore,
    durableWorker,
    get toolSessionRegistry() {
      return toolSessionRegistry;
    },
    get toolSessionIds() {
      return toolSessionStore?.getSessionIds() ?? [];
    },
  });

  return createChatApplication({
    setup: function* (): Operation<void> {
      yield* setupInMemoryDurableStreams<string>(
        options.retainResponseStreams ? { retentionPolicy: { mode: "retain_forever" } } : {},
      );
      yield* ToolInventoryContext.set(inventory);
      yield* durableOptionsProvider.install();

      toolSessionStore = createInMemoryToolSessionStoreWithDebug();
      const registry = yield* createToolSessionRegistry(toolSessionStore, {
        worker: {
          workerUrl: resolveFixtureBootstrapUrl("acceptance-tool-worker-bootstrap.mjs"),
          isDev: false,
        },
      });

      toolSessionRegistry = registry;

      yield* installLocalProgramToolRuntime({
        tools: [acceptanceBookingTool, acceptanceImmediateTool],
        registry,
        samplingProvider,
      });

      const durableRegistry = createDurableToolRegistry([acceptanceDurableTool]);
      const concreteDurableDriver = options.createDurableDriver
        ? options.createDurableDriver(durableRegistry)
        : createLocalWorkerDurableProgramDriver({
            workerUrl: resolveFixtureBootstrapUrl("acceptance-durable-worker-bootstrap.mjs"),
            name: "framework-acceptance-durable",
            registry: durableRegistry,
          });
      const durableDriver: ProgramDriver = {
        *attach(request) {
          const attachment = yield* concreteDurableDriver.attach(request);
          durableWorker.activeAttachments += 1;
          durableWorker.attachmentCount += 1;
          return attachment;
        },
        *step(attachment, command) {
          return yield* concreteDurableDriver.step(attachment, command);
        },
        *shutdown(attachment, reason) {
          try {
            yield* concreteDurableDriver.shutdown(attachment, reason);
          } finally {
            durableWorker.activeAttachments -= 1;
            durableWorker.shutdownCount += 1;
          }
        },
        *manifest(program) {
          if (!concreteDurableDriver.manifest) {
            throw new Error("durable worker driver does not expose manifest lookup");
          }
          return yield* concreteDurableDriver.manifest(program);
        },
      };
      yield* ProgramDriverNativeToolsContext.set({
        bindings: new Map([
          [
            acceptanceDurableTool.name,
            {
              publicName: acceptanceDurableTool.name,
              tool: acceptanceDurableTool,
              route: options.durableRoute ?? {
                driverKind: options.durableDriverKind ?? "worker",
                profile: "framework-acceptance-durable",
              },
            },
          ],
        ]),
        drivers: [[options.durableDriverKind ?? "worker", durableDriver]],
        effects: [...durableOptionsProvider.registrations],
      });
    },
    handler: createChatHandler({
      programDriverJournalStore: journalStore,
      setup: function* (): Operation<void> {
        yield* context.model.install();
      },
      maxToolIterations: options.maxToolIterations ?? 4,
    }),
  });
}
