import { createChatEndpoints, type ChatStorageConfig } from "@sweatpants/agent-host/server";
import type { ChatHandlerSetupContext } from "@sweatpants/durable-chat-runtime/durable-handler";
import {
  createToolInventory,
  createToolInventoryEntry,
  installToolInventory,
} from "@sweatpants/tool-runtime";
import { MaxIterationsContext } from "@sweatpants/durable-chat-runtime/contexts";
import type { RuntimeTool } from "@sweatpants/agent-sdk";
import { installPiAiModelProvider, resolvePiAiModel } from "@sweatpants/model-provider-pi-ai";
import {
  setupInMemoryDurableStreams,
  type DurableStreamsOwner,
} from "@sweatpants/durable-chat-runtime/response-streams";
import {
  createLocalToolInvocationRuntime,
  installLocalToolRuntime,
} from "@sweatpants/tool-runtime-local";
import type { Operation } from "effection";

export type AgentTool = RuntimeTool;

export interface InProcessHandlerConfig {
  tools: AgentTool[];
  toolsModuleUrl: string | URL;
  maxIterations?: number;
  owner: DurableStreamsOwner;
  storage: ChatStorageConfig;
}

export function createInProcessHandler(config: InProcessHandlerConfig) {
  const { tools, toolsModuleUrl, maxIterations = 10, owner, storage } = config;

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
    const provider = process.env["DEFAULT_CHAT_MODEL_PROVIDER"];
    const id = process.env["DEFAULT_CHAT_MODEL_ID"];
    if (!provider || !id) {
      throw new Error(
        "Configure DEFAULT_CHAT_MODEL_PROVIDER and DEFAULT_CHAT_MODEL_ID before starting yo-agent",
      );
    }
    yield* installPiAiModelProvider({ model: resolvePiAiModel({ provider, id }) });
  };

  const setupTools = function* (_ctx: ChatHandlerSetupContext): Operation<void> {
    yield* installToolInventory(
      createToolInventory(tools.map((tool) => createToolInventoryEntry(tool))),
    );
    yield* createLocalToolInvocationRuntime({
      worker: { workerUrl, isDev: false },
    });
    yield* installLocalToolRuntime({
      tools,
    });
  };

  const setupMaxIterations = function* (_ctx: ChatHandlerSetupContext): Operation<void> {
    yield* MaxIterationsContext.set(maxIterations);
  };

  const endpoints = createChatEndpoints({
    name: "yo-agent-in-process",
    secret: "yo-agent-in-process-local-key-material",
    storage,
    setup: function* setup(ctx) {
      yield* setupDurableStreams(ctx);
      yield* setupProvider(ctx);
      yield* setupTools(ctx);
      yield* setupMaxIterations(ctx);
    },
    maxToolIterations: maxIterations,
  });

  async function inProcessFetch(input: string | Request, init?: RequestInit): Promise<Response> {
    const request = typeof input === "string" ? new Request(input, init) : input;

    const pathname = new URL(request.url).pathname;
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }
    if (pathname === "/api/chat") {
      return endpoints.postChat(request);
    }
    const historyMatch = /^\/api\/chat\/([^/]+)\/history:page\/?$/.exec(pathname);
    if (historyMatch) {
      return endpoints.pageHistory({
        request,
        conversationId: decodeURIComponent(historyMatch[1]!),
      });
    }
    const readMatch = /^\/api\/chat\/([^/]+)\/?$/.exec(pathname);
    if (readMatch) {
      return endpoints.readChat({
        request,
        conversationId: decodeURIComponent(readMatch[1]!),
      });
    }
    return new Response("Not found", { status: 404 });
  }

  return inProcessFetch;
}

export const IN_PROCESS_BASE_URL = "http://localhost:0";
