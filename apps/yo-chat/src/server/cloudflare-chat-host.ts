import type { D1Database } from "@cloudflare/workers-types";
import { createChatApp, type ChatModel } from "@sweatpants/agent-host/server";
import { createD1Storage } from "@sweatpants/storage-d1";
import {
  createCloudflareResponseStores,
  type ResponseStreamNamespace,
} from "@sweatpants/durable-streams-cloudflare";
import { setupDurableStreams } from "@sweatpants/durable-chat-runtime/response-streams";
import {
  cloudflare,
  type ToolExecutorNamespace,
  type ToolSessionNamespace,
} from "@sweatpants/tool-runtime-cloudflare";
import { allTools, setupYoChatBaseContexts } from "./tools";
import { createDrawPickCardsRegistration } from "../tools/pick-card/durable-effects";

export interface CloudflareChatBindings {
  JOURNAL: D1Database;
  THREAD_METADATA: D1Database;
  RESPONSE_STREAMS: ResponseStreamNamespace;
  TOOL_SESSIONS: ToolSessionNamespace;
  TOOL_EXECUTORS: ToolExecutorNamespace;
  PROGRAM_DRIVER_CAPABILITY_SECRET: string;
}

/** Each request owns the host's scopes and RPC targets; durable state lives in bindings. */
export function createCloudflareChatApplication(
  bindings: CloudflareChatBindings,
  model: ChatModel,
) {
  if (!bindings.PROGRAM_DRIVER_CAPABILITY_SECRET) {
    throw new Error("PROGRAM_DRIVER_CAPABILITY_SECRET is required");
  }
  return createChatApp({
    name: "yo-chat",
    secret: bindings.PROGRAM_DRIVER_CAPABILITY_SECRET,
    storage: createD1Storage(bindings.JOURNAL),
    tools: allTools,
    effects: [createDrawPickCardsRegistration()],
    execution: cloudflare({
      executors: bindings.TOOL_EXECUTORS,
      sessions: bindings.TOOL_SESSIONS,
    }),
    model,
    shutdownDeadlineMs: 0,
    setup: {
      application: function* () {
        yield* setupDurableStreams({
          ...createCloudflareResponseStores<string>(bindings.RESPONSE_STREAMS),
          retentionPolicy: { mode: "retain_forever" },
        });
        yield* setupYoChatBaseContexts();
      },
    },
  });
}
