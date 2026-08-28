import { createChatApplication, type ChatApplication } from "@sweatpants/agent-host/server";
import { setupLogger } from "@sweatpants/agent-host/logging";
import { setupYoChatDurableStreams } from "./durable-streams";
import { setupYoChatBaseContexts } from "./tools";
import { setupYoChatPluginsAndRuntime } from "./tool-runtime";
import { createYoChatEndpoints } from "./chat-handler";
import type { DurableChatEndpoints } from "@sweatpants/durable-chat-runtime/durable-handler";
export { withDefaultSystemPrompt } from "./default-system-prompt";
export { ProgramDriverConfigurationError } from "./chat-handler";

export interface YoChatApplication extends ChatApplication {
  readonly endpoints: DurableChatEndpoints;
}

/** Creates yo-chat with one root scope and route-independent endpoints. */
export function createYoChatApplication(): YoChatApplication {
  const setup = function* setupApplication() {
    yield* setupLogger();
    yield* setupYoChatDurableStreams();
    yield* setupYoChatBaseContexts();
    yield* setupYoChatPluginsAndRuntime();
  };
  const endpoints = createYoChatEndpoints();
  return Object.assign(createChatApplication({ setup, handler: endpoints.postChat }), {
    endpoints,
  });
}

export const chatApp = createYoChatApplication();
