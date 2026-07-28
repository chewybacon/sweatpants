import { resource, type Operation } from "effection";
import {
  ToolInventoryContext,
  createToolInventory,
  createToolInventoryEntry,
  type AssistantMessage,
  type Model,
  type ModelProviderDriver,
  type ModelProviderStreamRequest,
} from "@sweatpants/framework/chat";
import {
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
  setupDurableStreams,
} from "@sweatpants/durable-chat-runtime/response-streams";
import {
  ProgramDriverNativeToolsContext,
  createCapabilityKeyring,
  createChatApplication,
  createDurableChatHandler,
  createInMemoryProgramDriverJournalStore,
  programDriverSchemaRegistry,
} from "@sweatpants/framework/server";
import {
  installLocalWorkspaceFilesProvider,
  installRemoteWorkspaceFilesProvider,
  type WorkspaceConnector,
  type WorkspaceFence,
  type WorkspaceOperations,
} from "@sweatpants/workspace-runtime";
import { useProgramExecution, type ProgramExecutionValue } from "@sweatpants/session-contract";
import {
  createPiAiModelProviderDriver,
  installPiAiModelProvider,
  resolvePiAiModel,
} from "@sweatpants/model-provider-pi-ai";

import { codingCapabilities } from "../capabilities/index.ts";
import { codingModelProvider } from "../deployment.ts";

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
}) {
  const definitions = Object.values(codingCapabilities);
  const journalStore = createInMemoryProgramDriverJournalStore({
    keyring: createCapabilityKeyring("yo-studio-durable-chat", [
      { keyId: "active", secret: "yo-studio-durable-chat-development-key" },
    ]),
    schemaRegistry: programDriverSchemaRegistry(
      definitions.flatMap((definition) => [...definition.artifacts.catalog]),
    ),
  });
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
          return yield* resolveWorkspace(yield* useProgramExecution());
        },
      });
    }
  };
  const modelProvider = options.modelProvider ?? createPiAiStudioModelProvider();
  const handler = createDurableChatHandler({
    programDriverJournalStore: journalStore,
    maxToolIterations: 8,
    setup: function* () {
      yield* installPiAiModelProvider(modelProvider);
    },
  });

  return createChatApplication({
    handler,
    setup: function* () {
      yield* setupDurableStreams({
        bufferStore: createInMemoryBufferStore<string>(),
        registryStore: createInMemoryRegistryStore(),
      });
      yield* ToolInventoryContext.set(
        createToolInventory(definitions.map((definition) => createToolInventoryEntry(definition))),
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
    *sample(): Operation<AssistantMessage> {
      throw new Error("durable chat must use the streaming model seam");
    },
  };
}

function scriptedMessage(
  request: ModelProviderStreamRequest,
  workspaceRevision: string,
): AssistantMessage {
  const toolResults = request.context.messages.filter((message) => message.role === "toolResult");
  if (toolResults.length === 0) {
    return {
      role: "assistant",
      content: [
        { type: "toolCall", id: "studio-inspect", name: "workspace_inspect", arguments: {} },
      ],
      stopReason: "toolUse",
    };
  }
  if (toolResults.length === 1) {
    return {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "studio-write",
          name: "workspace_write",
          arguments: {
            path: "demo.txt",
            contents: "hello from durable yo-studio\n",
            expectedWorkspaceRevision: workspaceRevision,
          },
        },
      ],
      stopReason: "toolUse",
    };
  }
  if (toolResults.length === 2) {
    return {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "studio-test",
          name: "workspace_test",
          arguments: { script: "test", expectedWorkspaceRevision: workspaceRevision },
        },
      ],
      stopReason: "toolUse",
    };
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: "Created demo.txt and the declared test script passed." }],
    stopReason: "stop",
  };
}

function completedStream(message: AssistantMessage): ReturnType<ModelProviderDriver["stream"]> {
  return resource(function* (provide) {
    yield* provide({
      *next(): Operation<IteratorResult<never, AssistantMessage>> {
        return { done: true, value: message };
      },
    });
  });
}
