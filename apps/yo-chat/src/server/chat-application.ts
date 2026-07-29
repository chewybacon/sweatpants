import { createChatApplication } from "@sweatpants/agent-host/server";
import { setupLogger } from "@sweatpants/agent-host/logging";
import { setupYoChatDurableStreams } from "./durable-streams";
import { setupYoChatBaseContexts } from "./tools";
import { setupYoChatPluginsAndRuntime } from "./tool-runtime";
import { createYoChatHandler } from "./chat-handler";
export { withDefaultSystemPrompt } from "./default-system-prompt";
export { ProgramDriverConfigurationError } from "./chat-handler";

/** Creates yo-chat with one root scope and the parsed execution-engine configuration. */
export function createYoChatApplication() {
  const setup = function* setupApplication() {
    yield* setupLogger();
    yield* setupYoChatDurableStreams();
    yield* setupYoChatBaseContexts();
    yield* setupYoChatPluginsAndRuntime();
  };
  return createChatApplication({ setup, handler: createYoChatHandler() });
}

export const chatApp = createYoChatApplication();
