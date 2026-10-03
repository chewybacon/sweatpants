import {
  createToolInventory,
  createToolInventoryEntry,
  installToolInventory,
} from "@sweatpants/tool-runtime";
import { resource, type Operation, type Stream } from "effection";
import type { ChatAssistantMessage } from "@sweatpants/chat-contract";
import type {
  Model,
  ModelProviderDriver,
  ModelProviderStreamRequest,
  ModelResponse,
} from "@sweatpants/model-provider";
import {
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  setupDurableStreams,
} from "@sweatpants/durable-chat-runtime/response-streams";
import { createChatApp, type ChatApp, type ChatStorageConfig } from "@sweatpants/agent-host/server";
import { ProgramDriverNativeToolsContext } from "@sweatpants/durable-chat-runtime/program-driver/native-tools";
import {
  installLocalWorkspaceFilesProvider,
  installRemoteWorkspaceFilesProvider,
  type WorkspaceConnector,
  type WorkspaceFence,
  type WorkspaceOperations,
} from "@sweatpants/workspace-runtime";
import { useProgramExecution, type ProgramExecutionValue } from "@sweatpants/durable-execution";
import {
  createPiAiModelProviderDriver,
  installPiAiModelProvider,
  resolvePiAiModel,
} from "@sweatpants/model-provider-pi-ai";

import { codingCapabilities } from "../capabilities/index.ts";
import { codingModelProvider } from "../deployment.ts";
import { createYoStudioStorageConfig } from "./storage-config.ts";

const model: Model = {
  id: "yo-studio-scripted",
  name: "yo-studio scripted coding model",
  api: "test",
  provider: "yo-studio",
  reasoning: false,
  input: ["text"],
  contextWindow: 16_000,
  maxTokens: 2_000,
};

export interface StudioModelProviderRuntime {
  readonly driver: ModelProviderDriver;
  readonly model: Model;
}

export function createPiAiStudioModelProvider(): StudioModelProviderRuntime {
  return {
    driver: createPiAiModelProviderDriver(),
    model: resolvePiAiModel(codingModelProvider.model),
  };
}

/** The actual durable chat handler consumed by @sweatpants/react-chat/useChat. */
export function createStudioDurableChatApplication(options: {
  readonly connector?: WorkspaceConnector;
  readonly operations?: WorkspaceOperations;
  readonly fence?: WorkspaceFence;
  readonly resolveWorkspace?: (
    execution: ProgramExecutionValue,
  ) => Operation<{ readonly connector: WorkspaceConnector; readonly fence: WorkspaceFence }>;
  readonly modelProvider?: StudioModelProviderRuntime;
  readonly storage?: ChatStorageConfig;
}): ChatApp {
  const definitions = Object.values(codingCapabilities);
  const resolveWorkspace =
    options.resolveWorkspace ??
    function* () {
      if (!options.connector || !options.fence) {
        throw new Error("workspace provider resolver is not configured");
      }
      return { connector: options.connector, fence: options.fence };
    };
  const installWorkspace = function* (): Operation<void> {
    if (options.operations && options.fence) {
      yield* installLocalWorkspaceFilesProvider({
        resolve: function* () {
          return { operations: options.operations!, fence: options.fence! };
        },
      });
    } else {
      yield* installRemoteWorkspaceFilesProvider({
        resolve: function* () {
          const execution = yield* useProgramExecution();
          return yield* resolveWorkspace(execution);
        },
      });
    }
  };
  const modelProvider = options.modelProvider ?? createPiAiStudioModelProvider();

  return createChatApp({
    name: "yo-studio",
    secret: "yo-studio-durable-chat-development-key",
    storage: options.storage ?? createYoStudioStorageConfig(),
    programs: definitions,
    maxToolIterations: 8,
    setup: {
      chat: function* () {
        yield* installPiAiModelProvider(modelProvider);
      },
      application: function* () {
        yield* setupDurableStreams({
          bufferStore: createInMemoryBufferStore<string>(),
          registryStore: createInMemoryRegistryStore(),
        });
        yield* installToolInventory(
          createToolInventory(
            definitions.map((definition) => createToolInventoryEntry(definition)),
          ),
        );
        yield* ProgramDriverNativeToolsContext.set({
          bindings: new Map(
            definitions.map((definition) => [
              definition.name,
              {
                publicName: definition.name,
                tool: definition,
                route: { driverKind: "program" as const },
              },
            ]),
          ),
          drivers: [],
          effects: [],
          setup: installWorkspace,
        });
      },
    },
  });
}

export function createScriptedStudioModelProvider(
  currentWorkspaceVersion: () => string,
): StudioModelProviderRuntime {
  return { driver: scriptedDriver(currentWorkspaceVersion), model };
}

function scriptedDriver(currentWorkspaceVersion: () => string): ModelProviderDriver {
  return {
    *stream(request) {
      return completedStream(scriptedMessage(request, currentWorkspaceVersion()));
    },
    *sample(): Operation<ModelResponse> {
      throw new Error("durable chat must use the streaming model seam");
    },
  };
}

function assistantResponse(message: ChatAssistantMessage, stopReason: string): ModelResponse {
  return {
    message,
    source: null,
    usage: null,
    stopReason,
    responseId: null,
    errorMessage: null,
  };
}

function scriptedMessage(
  request: ModelProviderStreamRequest,
  workspaceRevision: string,
): ModelResponse {
  const toolResults = request.context.messages.filter((message) => message.role === "tool");
  if (toolResults.length === 0) {
    return assistantResponse(
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCall: {
              id: "studio-inspect",
              name: "workspace_inspect",
              input: {},
              thoughtSignature: null,
            },
          },
        ],
      },
      "toolUse",
    );
  }
  if (toolResults.length === 1) {
    return assistantResponse(
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCall: {
              id: "studio-write",
              name: "workspace_write",
              input: {
                path: "demo.txt",
                contents: "hello from durable yo-studio\n",
                expectedWorkspaceRevision: workspaceRevision,
              },
              thoughtSignature: null,
            },
          },
        ],
      },
      "toolUse",
    );
  }
  if (toolResults.length === 2) {
    return assistantResponse(
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCall: {
              id: "studio-test",
              name: "workspace_test",
              input: { script: "test", expectedWorkspaceRevision: workspaceRevision },
              thoughtSignature: null,
            },
          },
        ],
      },
      "toolUse",
    );
  }
  return assistantResponse(
    {
      role: "assistant",
      content: [{ type: "text", text: "Created demo.txt and the declared test script passed." }],
    },
    "stop",
  );
}

function completedStream(message: ModelResponse): Stream<never, ModelResponse> {
  return resource(function* (provide) {
    yield* provide({
      *next(): Operation<IteratorResult<never, ModelResponse>> {
        return { done: true, value: message };
      },
    });
  });
}
