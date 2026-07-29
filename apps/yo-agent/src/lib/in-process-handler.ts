import { createToolInventoryEntry } from "@sweatpants/tool-session/tool-inventory";
import { createChatHandler } from "@sweatpants/agent-host/server";
import { createCapabilityKeyring } from "@sweatpants/session-contract";
import {
  createInMemoryProgramDriverJournalStore,
  type ChatHandlerSetupContext,
} from "@sweatpants/durable-chat-runtime/durable-handler";
import { ToolInventoryContext, createToolInventory } from "@sweatpants/chat-core";
import { MaxIterationsContext } from "@sweatpants/durable-chat-runtime/contexts";
import type { ToolDefinition } from "@sweatpants/agent-sdk";
import {
  installPiAiModelProvider,
  resolvePiAiModel,
  type ModelSelection,
} from "@sweatpants/model-provider-pi-ai";
import {
  setupInMemoryDurableStreams,
  type DurableStreamsOwner,
} from "@sweatpants/durable-chat-runtime/response-streams";
import { installLocalToolRuntime } from "@sweatpants/tool-runtime-local";
import type { Operation } from "effection";

export type AgentTool = ToolDefinition<string, unknown, unknown, any, any>;

export interface InProcessHandlerConfig {
  model: ModelSelection;
  tools: AgentTool[];
  toolsModuleUrl: string | URL;
  maxIterations?: number;
  owner: DurableStreamsOwner;
}

export function createInProcessHandler(config: InProcessHandlerConfig) {
  const { model: modelSelection, tools, toolsModuleUrl, maxIterations = 10, owner } = config;

  const toolWorkerBootstrapUrl = new URL(
    "../../src/lib/tool-worker-bootstrap.mjs",
    import.meta.url,
  );
  const workerUrl = new URL(toolWorkerBootstrapUrl.toString());
  workerUrl.searchParams.set("tools", String(toolsModuleUrl));

  const setupDurableStreams = function* (_ctx: ChatHandlerSetupContext): Operation<void> {
    yield* setupInMemoryDurableStreams<string>({ owner });
  };

  const setupProvider = function* (_ctx: ChatHandlerSetupContext): Operation<void> {
    yield* installPiAiModelProvider({ model: resolvePiAiModel(modelSelection) });
  };

  const setupTools = function* (_ctx: ChatHandlerSetupContext): Operation<void> {
    yield* ToolInventoryContext.set(
      createToolInventory(tools.map((tool) => createToolInventoryEntry(tool))),
    );
    yield* installLocalToolRuntime({
      tools,
      registryOptions: {
        worker: { workerUrl, isDev: false },
      },
    });
  };

  const setupMaxIterations = function* (_ctx: ChatHandlerSetupContext): Operation<void> {
    yield* MaxIterationsContext.set(maxIterations);
  };

  const handler = createChatHandler({
    setup: function* setup(ctx) {
      yield* setupDurableStreams(ctx);
      yield* setupProvider(ctx);
      yield* setupTools(ctx);
      yield* setupMaxIterations(ctx);
    },
    maxToolIterations: maxIterations,
    programDriverJournalStore: createInMemoryProgramDriverJournalStore({
      keyring: createCapabilityKeyring("yo-agent-in-process", [
        { keyId: "local", secret: "yo-agent-in-process-local-key-material" },
      ]),
    }),
  });

  async function inProcessFetch(input: string | Request, init?: RequestInit): Promise<Response> {
    const request = typeof input === "string" ? new Request(input, init) : input;

    const url = request.url;
    if (url.endsWith("/api/chat") && request.method === "POST") {
      return handler(request);
    }

    return new Response("Not found", { status: 404 });
  }

  return inProcessFetch;
}

export const IN_PROCESS_BASE_URL = "http://localhost:0";
