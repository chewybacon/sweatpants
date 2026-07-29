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
import type { Operation } from "effection";
import { createChatApplication } from "@sweatpants/agent-host/server";
import { createPluginSessionManager } from "@sweatpants/durable-chat-runtime/durable-handler";
import { setupLogger } from "@sweatpants/agent-host/logging";
import type { ToolSessionRegistry } from "@sweatpants/tool-session";
import {
  createInMemoryToolSessionStore,
  createToolSessionRegistry,
} from "@sweatpants/tool-runtime-local";

import { setupYoChatDurableStreams } from "@/server/durable-streams";
import { setupYoChatBaseContexts, allTools } from "@/server/tools";
import { createYoChatHandler } from "@/server/chat-handler";
import { installYoChatToolRuntime } from "@/server/tool-runtime-installation";
import { withDefaultSystemPrompt } from "@/server/default-system-prompt";
import { createPluginSamplingProvider } from "@/server/plugin-sampling-provider";
import {
  YO_CHAT_TOOL_WORKER_ENTRY_URL,
  yoChatToolSessionWorkerConfig,
} from "@/server/tool-worker-config";

import { handlerToChatFetch, type ChatBinding } from "./chat-fetch.ts";

function* setupTierAWorkerRuntime(): Operation<void> {
  const workerEntryPath = fileURLToPath(YO_CHAT_TOOL_WORKER_ENTRY_URL);
  if (!existsSync(workerEntryPath)) {
    throw new Error(`[outside-in:tier-a] worker entry not found at ${workerEntryPath}.`);
  }

  const store = createInMemoryToolSessionStore();
  const samplingProvider = createPluginSamplingProvider();
  const registry: ToolSessionRegistry = yield* createToolSessionRegistry(store, {
    worker: yoChatToolSessionWorkerConfig,
  });
  const manager = yield* createPluginSessionManager({
    registry,
  });

  yield* installYoChatToolRuntime({
    mode: "local",
    registry,
    pluginManager: manager,
    samplingProvider,
    tools: [...allTools],
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
    handler: createYoChatHandler(),
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
