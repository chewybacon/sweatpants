import type { WorkflowLanguage } from "../../workflow/language.ts";
import { documentEffectRegistration } from "../document-effect.ts";
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
import { createWorkflowExposure } from "../../workflow/agent.ts";
import { programs } from "../../workflow/agent.ts";

export interface CloudflareBindings {
  JOURNAL: D1Database;
  RESPONSE_STREAMS: ResponseStreamNamespace;
  TOOL_EXECUTORS: ToolExecutorNamespace;
  PROGRAM_DRIVER_CAPABILITY_SECRET: string;
}

/** Same Agent Host composition as yo-chat: D1 authority, DO tools, DO delivery. */
export function createCloudflareWorkflowApp(
  bindings: CloudflareBindings,
  model: ChatModel,
  decisionProvider?: DecisionProviderDriver,
  language: WorkflowLanguage = "scheme",
) {
  if (!bindings.PROGRAM_DRIVER_CAPABILITY_SECRET) {
    throw new Error("PROGRAM_DRIVER_CAPABILITY_SECRET is required");
  }
  return createChatApp({
    name: "yo-workflow",
    secret: bindings.PROGRAM_DRIVER_CAPABILITY_SECRET,
    storage: createD1Storage(bindings.JOURNAL),
    tools: programs,
    effects: [createDecisionEffectRegistration(), documentEffectRegistration],
    execution: cloudflare({ executors: bindings.TOOL_EXECUTORS }),
    model,
    // Authoring and repair continue until completion or an explicit stop.
    maxToolIterations: null,
    shutdownDeadlineMs: 0,
    setup: {
      application: function* () {
        if (decisionProvider) {
          yield* installDecisionProvider(decisionProvider);
        }
        yield* setupDurableStreams({
          ...createCloudflareResponseStores<string>(bindings.RESPONSE_STREAMS),
          retentionPolicy: { mode: "retain_forever" },
        });
      },
      chat: function* () {
        yield* ToolExposurePolicyContext.set(createWorkflowExposure(language));
      },
    },
  });
}
