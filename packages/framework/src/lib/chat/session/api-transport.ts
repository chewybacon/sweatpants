/**
 * lib/chat/session/api-transport.ts
 */
import type { Operation } from "effection";
import { call } from "effection";
import type { Message } from "../types.ts";
import type { StreamChatOptions } from "./options.ts";

/**
 * Derive the server-side `enabledPlugins` list from the plugin handles passed
 * to the session. Each plugin's `client.toolName` is the canonical tool name
 * the server should expose. Authors never specify `enabledPlugins` directly.
 */
function deriveEnabledPlugins(options: StreamChatOptions): string[] {
  return (options.plugins ?? []).map((plugin) => plugin.client.toolName);
}

export function* executeChatFetch(
  baseUrl: string,
  messages: Message[],
  options: StreamChatOptions,
  signal: AbortSignal,
): Operation<Response> {
  const response = yield* call(() =>
    fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        enabledTools: options.enabledTools,
        enabledPlugins: deriveEnabledPlugins(options),
        systemPrompt: options.systemPrompt,
        persona: options.persona,
        personaConfig: options.personaConfig,
        enableOptionalTools: options.enableOptionalTools,
        effort: options.effort,
        streamOptions: options.streamOptions,
        initialToolChoice: options.initialToolChoice,
        isomorphicTools: options.isomorphicToolSchemas,
        isomorphicClientOutputs: options.isomorphicClientOutputs,
        elicitResponses: options.elicitResponses,
        replayState: options.replayState,
        ...(options.conversationId && { conversationId: options.conversationId }),
      }),
      signal,
    }),
  );

  if (!response.ok) {
    const errorText = yield* call(() => response.text());
    let errorMessage = `Chat API error: ${response.status}`;
    try {
      const json = JSON.parse(errorText);
      if (json.error) errorMessage = json.error;
    } catch {
      errorMessage += ` - ${errorText}`;
    }
    throw new Error(errorMessage);
  }

  if (!response.body) {
    throw new Error("No response body from chat API");
  }

  return response;
}
