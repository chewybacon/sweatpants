import { DurableObject } from "cloudflare:workers";
import type { ChatModel } from "@sweatpants/agent-host/server";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import {
  createCloudflareWorkflowApp,
  createWorkflowConversationHandler,
  type CloudflareBindings,
} from "../../server/cloudflare/application.ts";
import {
  createConversationRouter,
  type ConversationNamespace,
} from "../../server/cloudflare/routing.ts";
export { ToolExecutors } from "../../server/cloudflare/tool-executors.ts";
import { createToolExecutorObject } from "@sweatpants/tool-runtime-cloudflare/executor";
import { programs } from "../../workflow/agent.ts";
// Negative configuration control: same real executor and tools, without setup.
export const UnconfiguredToolExecutors = createToolExecutorObject({ tools: programs });
export { ResponseStream } from "@sweatpants/durable-streams-cloudflare/worker";

interface Env extends CloudflareBindings {
  MODEL: string;
  CONVERSATIONS: ConversationNamespace;
}

export class Conversations extends DurableObject<Env> {
  private readonly handleConversation = createWorkflowConversationHandler(() => {
    const model = JSON.parse(this.env.MODEL) as Pick<ChatModel, "model" | "streamOptions">;
    return createCloudflareWorkflowApp(
      this.env,
      { ...model, driver: createPiAiModelProvider().driver },
      undefined,
    );
  });
  override fetch(request: Request) {
    return this.handleConversation(request);
  }
}

export default {
  fetch(request: Request, env: Env) {
    return createConversationRouter(env.CONVERSATIONS)(request);
  },
};
