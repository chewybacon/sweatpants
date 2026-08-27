import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Operation } from "effection";
import { createChatApplication, createChatHandler } from "@sweatpants/agent-host/server";
import { DurableEffectRouting } from "@sweatpants/durable-effects/runtime";
import { createCapabilityKeyring, LOW_PRIVATE_SEGMENT_TARGET } from "@sweatpants/journal-authority";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import type { ExecutionStore } from "@sweatpants/journal-authority/store";
import { createMemoryConversationStore } from "@sweatpants/history-store/memory";
import type { ConversationStore } from "@sweatpants/history-store/contract";
import {
  createProgramDriverJournalStore,
  createProjectionTokenKeyring,
  programDriverSchemaRegistry,
  type ProgramDriverJournalStore,
} from "@sweatpants/durable-chat-runtime/durable-handler";
import { ProgramDriverNativeToolsContext } from "@sweatpants/durable-chat-runtime/program-driver/native-tools";
import { createSimulatedRemoteModelSamplingService } from "./model-placement-simulator.ts";
import {
  assistantText,
  ExecutionModelSamplingServiceContext,
  ModelSamplingApi,
} from "@sweatpants/model-sampling";
import {
  createToolInventory,
  createToolInventoryEntry,
  installToolInventory,
} from "@sweatpants/tool-runtime";
import { setupInMemoryDurableStreams } from "@sweatpants/durable-chat-runtime/response-streams";
import { ProgramDriverEphemeralEffectsContext } from "@sweatpants/durable-chat-runtime/program-driver/effects";
import type { ToolSessionSamplingProvider } from "@sweatpants/tool-session";
import { createPiAiModelProviderDriver } from "@sweatpants/model-provider-pi-ai";
import type { ModelContext } from "@sweatpants/model-provider";
import type { ChatMessage } from "@sweatpants/chat-contract";
import {
  createDurableToolRegistry,
  type DurableToolRegistry,
  type ProgramDriver,
  type ProgramRoute,
} from "@sweatpants/durable-execution";
import {
  createLocalToolInvocationRuntime,
  createLocalWorkerDurableProgramDriver,
  installLocalToolRuntimeComposition,
  type LocalToolInvocationRuntime,
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
    resolve(process.cwd(), `packages/platform-acceptance/src/fixtures/${filename}`),
  ];
  const candidate = candidates.find((path) => existsSync(path));
  if (!candidate) {
    throw new Error(`Failed to resolve ${filename}`);
  }
  return pathToFileURL(candidate);
}

function createSamplingProvider(
  context: TestApplicationFactoryContext,
): ToolSessionSamplingProvider {
  const driver = createPiAiModelProviderDriver();
  return {
    *sample(messages, options) {
      const modelMessages: ChatMessage[] = messages;
      const modelContext: ModelContext = {
        messages: [
          ...(options?.systemPrompt
            ? [{ role: "system" as const, content: options.systemPrompt }]
            : []),
          ...modelMessages,
        ],
        tools: [],
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
  conversationStore: ConversationStore;
  executionStore: ExecutionStore;
  modelSamplingExecutors: string[];
  modelSamplingProtocol: string[];
  checkpointErrors: unknown[];
  durableWorker: DurableWorkerMetrics;
  get toolInvocationRuntime(): LocalToolInvocationRuntime | undefined;
}

export interface AcceptanceApplicationOptions {
  maxToolIterations?: number;
  retainResponseStreams?: boolean;
  /** Shared durable substrate used when a test-rig scenario replaces a Host generation. */
  journalStore?: ProgramDriverJournalStore;
  /** Direct ConversationStore installed into the runtime composition. */
  conversationStore?: ConversationStore;
  /** Direct ExecutionStore shared by terminal authority and program journal. */
  executionStore?: ExecutionStore;
  /** Lowers checkpoint spill and private segment targets for the SQLite spine. */
  storageProfile?: "low" | "default";
  durableDriverKind?: string;
  durableRoute?: ProgramRoute;
  /** Explicitly exercises the host activation-lease path for native bindings. */
  durableActivation?: "fenced";
  createDurableDriver?(registry: DurableToolRegistry): ProgramDriver;
  modelSamplingOwnership?: "host" | "execution";
  modelSamplingTargets?: "root" | "all";
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
  const modelSamplingExecutors: string[] = [];
  const modelSamplingProtocol: string[] = [];
  const checkpointErrors: unknown[] = [];
  const durableWorker: DurableWorkerMetrics = {
    activeAttachments: 0,
    attachmentCount: 0,
    shutdownCount: 0,
  };
  let toolInvocationRuntime: LocalToolInvocationRuntime | undefined;
  const executionStore = options.executionStore ?? createMemoryExecutionStore();
  const conversationStore = options.conversationStore ?? createMemoryConversationStore();
  const journalStore =
    options.journalStore ??
    createProgramDriverJournalStore({
      keyring: createCapabilityKeyring("test-rig-acceptance", [
        {
          keyId: "test-v1",
          secret: "test-rig-acceptance-secret-at-least-32-bytes",
        },
      ]),
      schemaRegistry: programDriverSchemaRegistry(acceptanceDurableTool.artifacts.catalog),
      executionStore,
      ...(options.storageProfile === "low"
        ? { privateSegmentTarget: LOW_PRIVATE_SEGMENT_TARGET }
        : {}),
    });
  inspect?.({
    journalStore,
    conversationStore,
    executionStore,
    modelSamplingExecutors,
    modelSamplingProtocol,
    checkpointErrors,
    durableWorker,
    get toolInvocationRuntime() {
      return toolInvocationRuntime;
    },
  });

  const application = createChatApplication({
    setup: function* (): Operation<void> {
      yield* setupInMemoryDurableStreams<string>(
        options.retainResponseStreams ? { retentionPolicy: { mode: "retain_forever" } } : {},
      );
      yield* installToolInventory(inventory);
      yield* durableOptionsProvider.install();
      yield* ModelSamplingApi.around({
        *sample([request, attempt], next) {
          modelSamplingExecutors.push(attempt.executor ?? "host");
          return yield* next(request, attempt);
        },
      });
      if (options.modelSamplingOwnership === "execution") {
        const executionSampling = createSimulatedRemoteModelSamplingService({
          model: context.model.model,
          streamOptions: context.model.streamOptions,
          onEvent: (event) => modelSamplingProtocol.push(event),
        });
        const executionService = {
          *sample(
            request: Parameters<NonNullable<typeof executionSampling.sample>>[0],
            attempt: Parameters<NonNullable<typeof executionSampling.sample>>[1],
          ) {
            return yield* executionSampling.sample(request, attempt);
          },
          ...(executionSampling.acknowledge
            ? {
                *acknowledge(
                  attempt: Parameters<NonNullable<typeof executionSampling.acknowledge>>[0],
                  outcomeDigest: string,
                ) {
                  return yield* executionSampling.acknowledge!(attempt, outcomeDigest);
                },
              }
            : {}),
        };
        yield* ExecutionModelSamplingServiceContext.set(executionService);
        yield* DurableEffectRouting.around({
          *route([request], next) {
            if (
              request.definition.name === "model.sample" &&
              (request.program.id === "sweatpants.chat-root" ||
                options.modelSamplingTargets === "all")
            ) {
              return { placement: "execution" };
            }
            return yield* next(request);
          },
        });
      }

      toolInvocationRuntime = yield* createLocalToolInvocationRuntime({
        worker: {
          workerUrl: resolveFixtureBootstrapUrl("acceptance-tool-worker-bootstrap.mjs"),
          isDev: false,
        },
      });

      yield* installLocalToolRuntimeComposition({
        tools: [acceptanceBookingTool, acceptanceImmediateTool],
        samplingProvider,
        installEphemeralEffects: function* (registrations) {
          yield* ProgramDriverEphemeralEffectsContext.set(registrations);
        },
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
        capabilities: concreteDurableDriver.capabilities,
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
              ...(options.durableActivation ? { activation: options.durableActivation } : {}),
            },
          ],
        ]),
        drivers: [[options.durableDriverKind ?? "worker", durableDriver]],
        effects: [...durableOptionsProvider.registrations],
      });
    },
    handler: createChatHandler({
      programDriverJournalStore: journalStore,
      executionStore,
      conversationStore,
      projectionTokens: createProjectionTokenKeyring("platform-acceptance-windowed-projection-key"),
      *authorizeHistoryRead() {
        return "authorized" as const;
      },
      ...(options.storageProfile ? { storageProfile: options.storageProfile } : {}),
      setup: function* (): Operation<void> {
        yield* context.model.install();
      },
      maxToolIterations: options.maxToolIterations ?? 4,
    }),
  });
  return {
    ...application,
    scenario: {
      async checkpointErrors() {
        return checkpointErrors;
      },
    },
  };
}
