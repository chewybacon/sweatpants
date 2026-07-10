/**
 * Tier A binding (design R2 / Decision 2).
 *
 * Builds the durable chat handler IN-PROCESS with:
 *   - the real local **worker-backed** tool session registry, spawning a genuine
 *     worker thread through the plain-JS yo-chat bootstrap. The bootstrap loads
 *     the generated `tool-registry.gen.ts` tool list and runs it with the local
 *     worker runner, preserving the same serialization boundary proven by
 *     `worker-tool-session.test.ts`;
 *   - the real Copilot-authed model provider (via the app's own
 *     `setupYoChatModelProvider`);
 *   - the real plugin/tool inventory (book_flight, tictactoe, play_ttt + local
 *     tools).
 *
 * Returns a {@link ChatBinding} whose `fetch` calls the handler directly (no
 * socket). This keeps the fast dev loop honest about the worker serialization
 * boundary while skipping only the vite bundling that Tier B owns.
 *
 * This module deliberately does NOT import `@/server/tool-runtime` or
 * `@/server/chat-application`: those pull in `?modulePath` worker bundling that
 * is gated out under Vitest. Tier A wires the worker registry directly instead.
 */
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { RuntimeTool } from "@sweatpants/core";
import type { Operation } from "effection";
import {
  createChatApplication,
  createChatHandler,
  createPluginSessionManager,
} from "@sweatpants/framework/server";
import {
  PluginSessionManagerContext,
  PluginSessionRegistryContext,
  ToolInventoryContext,
  createToolInventory,
  createToolInventoryEntry,
  setupLogger,
} from "@sweatpants/framework/chat";
import type { ToolSessionRegistry } from "@sweatpants/framework/chat/mcp-tools";
import {
  ToolSessionSamplingProviderContext,
  createInMemoryToolSessionStore,
  createToolSessionRegistry,
  installLocalToolRuntime,
} from "@sweatpants/tool-runtime-local";

import { setupYoChatDurableStreams } from "@/server/durable-streams";
import { setupYoChatBaseContexts, activePluginTools, allTools } from "@/server/tools";
import { setupYoChatModelProvider } from "@/server/model-provider";
import { withDefaultSystemPrompt } from "@/server/default-system-prompt";
import { pluginSamplingProvider } from "@/server/plugin-sampling-provider";
import {
  YO_CHAT_GENERATED_TOOL_WORKER_ENTRY_URL,
  yoChatToolSessionWorkerConfig,
} from "@/server/tool-worker-config";

import { handlerToChatFetch, type ChatBinding } from "./chat-fetch.ts";

type LocalSessionTool = RuntimeTool;

function localOnlyTools(): LocalSessionTool[] {
  const pluginNames = new Set<string>(activePluginTools.map((tool) => tool.name));
  return allTools.filter((tool) => !pluginNames.has(tool.name));
}

function* setupTierAWorkerRuntime(): Operation<void> {
  const workerGenPath = fileURLToPath(YO_CHAT_GENERATED_TOOL_WORKER_ENTRY_URL);
  if (!existsSync(workerGenPath)) {
    throw new Error(
      `[outside-in:tier-a] generated worker entry not found at ${workerGenPath}. Run \`pnpm -C apps/yo-chat generate:tools\`.`,
    );
  }

  yield* ToolSessionSamplingProviderContext.set(pluginSamplingProvider);

  const store = createInMemoryToolSessionStore();
  const registry: ToolSessionRegistry = yield* createToolSessionRegistry(store, {
    samplingProvider: pluginSamplingProvider,
    worker: yoChatToolSessionWorkerConfig,
  });
  const manager = yield* createPluginSessionManager({
    registry,
    samplingProvider: pluginSamplingProvider,
  });

  yield* PluginSessionRegistryContext.set(registry);
  yield* PluginSessionManagerContext.set(manager);

  const pluginTools = activePluginTools;
  const localTools = localOnlyTools();

  yield* ToolInventoryContext.set(
    createToolInventory([
      ...localTools.map((tool) => createToolInventoryEntry(tool)),
      ...pluginTools.map((tool) => createToolInventoryEntry(tool)),
    ]),
  );

  yield* installLocalToolRuntime({
    tools: [...pluginTools, ...localTools],
    registry,
    samplingProvider: pluginSamplingProvider,
  });
}

/**
 * Create a Tier A (in-process, worker-backed, real-model) chat binding.
 */
export function createTierABinding(): ChatBinding {
  const app = createChatApplication({
    setup: function* setupApplication() {
      yield* setupLogger();
      yield* setupYoChatDurableStreams();
      yield* setupYoChatBaseContexts();
      yield* setupTierAWorkerRuntime();
    },
    handler: createChatHandler({
      setup: setupYoChatModelProvider,
      maxToolIterations: 10,
    }),
  });

  const baseUrl = "http://localhost/api/chat";

  // Capture the REAL fetch now, before any `withChatFetch` global override.
  // CRITICAL (Tier A is in-process): the model provider makes its own outbound
  // HTTPS call to Copilot via `globalThis.fetch`. When the driver installs this
  // seam as the global fetch, we must intercept ONLY the chat URL and delegate
  // every other request (the model API call, auth, etc.) to the real fetch —
  // otherwise the model run is hijacked into our own handler and fails.
  const realFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);

  const handlerFetch = handlerToChatFetch(async (request) => {
    // Mirror the real /api/chat route: POST gets the default system prompt.
    if (request.method.toUpperCase() === "POST") {
      return app.handle(await withDefaultSystemPrompt(request));
    }
    return app.handle(request);
  });

  const fetch: typeof handlerFetch = (input, init) => {
    let url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // Resolve relative URLs (e.g. /api/chat?conversationId=... from
    // readDurableHistory) against the baseUrl so the handler receives a
    // valid absolute URL.
    if (url.startsWith("/")) {
      url = `${baseUrl.replace("/api/chat", "")}${url}`;
    }
    // Only chat-route traffic goes to the in-process handler; everything else
    // (the real Copilot model call) passes through to the real network fetch.
    if (url.startsWith("http://localhost")) {
      return handlerFetch(url, init);
    }
    return realFetch(input as RequestInfo | URL, init);
  };

  return {
    tier: "tier-a",
    fetch,
    baseUrl,
    async close() {
      await app.close();
    },
  };
}
