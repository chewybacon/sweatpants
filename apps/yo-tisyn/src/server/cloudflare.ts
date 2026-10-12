import { DurableObject } from "cloudflare:workers";
import { handle as astroHandle } from "@astrojs/cloudflare/handler";
import { createChatFetchHandler } from "@sweatpants/agent-host/server";
import { pi, createPiAiDecisionProvider } from "@sweatpants/model-provider-pi-ai";
import { InMemoryCredentialStore, type Credential } from "@earendil-works/pi-ai";
import { createTisynModels } from "./cloudflare/model-catalog.ts";
import { createCloudflareTisynApp, type CloudflareBindings } from "./cloudflare/application.ts";
import { createConversationRouter, type ConversationNamespace } from "./cloudflare/routing.ts";
import { samplingMode } from "../workflow/agent.ts";

export { ResponseStream } from "@sweatpants/durable-streams-cloudflare/worker";
export { ToolExecutors } from "./cloudflare/tool-executors.ts";

interface Env extends CloudflareBindings {
  CONVERSATIONS: ConversationNamespace;
  ASSETS: { fetch(request: Request): Promise<Response> };
  MODEL_CREDENTIALS: string;
  DEFAULT_CHAT_MODEL_PROVIDER: string;
  DEFAULT_CHAT_MODEL_ID: string;
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
      const models = createTisynModels(credentials);
      return createCloudflareTisynApp(
        this.env,
        pi({
          provider: this.env.DEFAULT_CHAT_MODEL_PROVIDER,
          model: this.env.DEFAULT_CHAT_MODEL_ID,
          models,
          streamOptions: { thinking: "low" },
        }),
        createPiAiDecisionProvider({ models }),
      );
    })(request);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      return Response.json({
        app: "yo-tisyn",
        model: { provider: env.DEFAULT_CHAT_MODEL_PROVIDER, id: env.DEFAULT_CHAT_MODEL_ID },
        host: "conversation-do",
        tools: "executor-do",
        evaluation: "quickjs-in-tool-executor-do",
        sampling: samplingMode,
        site: "astro",
      });
    }
    if (path === "/api/chat" || path.startsWith("/api/chat/")) {
      return createConversationRouter(env.CONVERSATIONS)(request);
    }
    return astroHandle(request, env, ctx);
  },
};
