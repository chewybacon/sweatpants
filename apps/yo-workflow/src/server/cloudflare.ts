import { workflowLanguage } from "../workflow/language.ts";
import { executionFetch } from "../../execution/worker.mjs";
export { ExecutionLab } from "../../execution/worker.mjs";
import schemeManifest from "@sweatpants/scheme-runtime/manifest" with { type: "json" };
import { DurableObject } from "cloudflare:workers";
import { handle as astroHandle } from "@astrojs/cloudflare/handler";
import { createChatFetchHandler } from "@sweatpants/agent-host/server";
import { pi, createPiAiDecisionProvider } from "@sweatpants/model-provider-pi-ai";
import { InMemoryCredentialStore, type Credential } from "@earendil-works/pi-ai";
import { createWorkflowModels } from "./cloudflare/model-catalog.ts";
import { createCloudflareWorkflowApp, type CloudflareBindings } from "./cloudflare/application.ts";
import { createConversationRouter, type ConversationNamespace } from "./cloudflare/routing.ts";
import { reasoningLevel } from "./model-settings.ts";

export { ResponseStream } from "@sweatpants/durable-streams-cloudflare/worker";
export { ToolExecutors } from "./cloudflare/tool-executors.ts";

interface Env extends CloudflareBindings {
  EXECUTION_LABS: DurableObjectNamespace;
  CONVERSATIONS: ConversationNamespace;
  ASSETS: { fetch(request: Request): Promise<Response> };
  MODEL_CREDENTIALS: string;
  DEFAULT_CHAT_MODEL_PROVIDER: string;
  DEFAULT_CHAT_MODEL_ID: string;
  DEFAULT_CHAT_MODEL_THINKING?: string;
}

export class Conversations extends DurableObject<Env> {
  override fetch(request: Request) {
    return createChatFetchHandler(async () => {
      if (!this.env.MODEL_CREDENTIALS) {
        throw new Error("MODEL_CREDENTIALS is required; use pnpm dev:cloudflare");
      }
      const credentials = new InMemoryCredentialStore();
      const records = JSON.parse(this.env.MODEL_CREDENTIALS) as Record<string, Credential>;
      for (const [id, credential] of Object.entries(records)) {
        await credentials.modify(id, async () => credential);
      }
      const models = createWorkflowModels(credentials);
      return createCloudflareWorkflowApp(
        this.env,
        pi({
          provider: this.env.DEFAULT_CHAT_MODEL_PROVIDER,
          model: this.env.DEFAULT_CHAT_MODEL_ID,
          models,
          streamOptions: { thinking: reasoningLevel(this.env.DEFAULT_CHAT_MODEL_THINKING) },
        }),
        createPiAiDecisionProvider({ models }),
        workflowLanguage(request.headers.get("X-Workflow-Language")),
      );
    })(request);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === "/api/execution") {
      return executionFetch(request, env);
    }
    if (path === "/health") {
      return Response.json({
        app: "yo-workflow",
        model: {
          provider: env.DEFAULT_CHAT_MODEL_PROVIDER,
          id: env.DEFAULT_CHAT_MODEL_ID,
          thinking: reasoningLevel(env.DEFAULT_CHAT_MODEL_THINKING),
        },
        host: "conversation-do",
        tools: "executor-do",
        evaluation: "hoot-scheme-in-tool-executor-do",
        scheme: schemeManifest,
        sampling: "native",
        site: "astro",
      });
    }
    if (path === "/api/chat" || path.startsWith("/api/chat/")) {
      return createConversationRouter(env.CONVERSATIONS)(request);
    }
    return astroHandle(request, env, ctx);
  },
};
