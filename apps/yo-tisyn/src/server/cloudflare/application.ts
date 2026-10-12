import {
  createDecisionEffectRegistration,
  installDecisionProvider,
  type DecisionProviderDriver,
} from "@sweatpants/model-decision";
import { createChatApp, type ChatModel } from "@sweatpants/agent-host/server";
import { ToolExposurePolicyContext } from "@sweatpants/chat-core";
import { createD1Storage } from "@sweatpants/storage-d1";
import {
  createCloudflareResponseStores,
  type ResponseStreamNamespace,
} from "@sweatpants/durable-streams-cloudflare";
import { setupDurableStreams } from "@sweatpants/durable-chat-runtime/response-streams";
import { cloudflare, type ToolExecutorNamespace } from "@sweatpants/tool-runtime-cloudflare";
import type { D1Database } from "@cloudflare/workers-types";
import { tisynExposure } from "../../workflow/agent.ts";
import { programs } from "./agent.ts";

export interface CloudflareBindings {
  JOURNAL: D1Database;
  RESPONSE_STREAMS: ResponseStreamNamespace;
  TOOL_EXECUTORS: ToolExecutorNamespace;
  PROGRAM_DRIVER_CAPABILITY_SECRET: string;
}

/** Same Agent Host composition as yo-chat: D1 authority, DO tools, DO delivery. */
export function createCloudflareTisynApp(
  bindings: CloudflareBindings,
  model: ChatModel,
  decisionProvider?: DecisionProviderDriver,
) {
  if (!bindings.PROGRAM_DRIVER_CAPABILITY_SECRET) {
    throw new Error("PROGRAM_DRIVER_CAPABILITY_SECRET is required");
  }
  return createChatApp({
    name: "yo-tisyn",
    secret: bindings.PROGRAM_DRIVER_CAPABILITY_SECRET,
    storage: createD1Storage(bindings.JOURNAL),
    tools: programs,
    effects: [createDecisionEffectRegistration()],
    execution: cloudflare({ executors: bindings.TOOL_EXECUTORS }),
    model,
    // Initial validation, up to three repairs, execution, and final summary.
    maxToolIterations: 6,
    shutdownDeadlineMs: 0,
    setup: {
      application: function* () {
        if (decisionProvider) yield* installDecisionProvider(decisionProvider);
        yield* setupDurableStreams({
          ...createCloudflareResponseStores<string>(bindings.RESPONSE_STREAMS),
          retentionPolicy: { mode: "retain_forever" },
        });
      },
      chat: function* () {
        yield* ToolExposurePolicyContext.set(tisynExposure);
      },
    },
  });
}
