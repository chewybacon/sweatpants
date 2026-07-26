/**
 * lib/chat/session/api-transport.ts
 */
import type { Operation } from "effection";
import { call } from "effection";
import type { Message } from "../types.ts";
import type { StreamChatOptions, ElicitResponseData } from "./options.ts";
import { normalizeClientReplayTrace } from "./plugin-replay.ts";

/**
 * Derive the server-side `enabledPlugins` list from the plugin handles passed
 * to the session. Each plugin's `client.toolName` is the canonical tool name
 * the server should expose. Authors never specify `enabledPlugins` directly.
 */
function deriveEnabledPlugins(options: StreamChatOptions): string[] {
  return (options.plugins ?? []).map((plugin) => plugin.client.toolName);
}

function deriveEnabledTools(options: StreamChatOptions): boolean | string[] | undefined {
  if (options.enabledTools !== undefined) {
    return options.enabledTools;
  }
  if (!options.tools?.length) {
    return undefined;
  }
  return options.tools
    .map((tool) =>
      (typeof tool === "function" || (typeof tool === "object" && tool !== null)) && "name" in tool
        ? String((tool as { name: unknown }).name)
        : undefined,
    )
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

function resumeEntryForElicitResponse(response: ElicitResponseData) {
  if (response.result.action === "cancel") {
    return { interruptId: response.elicitId, status: "cancelled" as const };
  }
  if (response.result.action === "decline") {
    return {
      interruptId: response.elicitId,
      status: "resolved" as const,
      payload: { action: "decline" as const },
    };
  }
  return {
    interruptId: response.elicitId,
    status: "resolved" as const,
    payload: { action: "accept" as const, content: response.result.content },
  };
}

function buildResumeForwardedProps(options: StreamChatOptions): {
  resume?: ReturnType<typeof resumeEntryForElicitResponse>[];
  forwardedProps?: { sweatpants: { clientReplayTraces: Record<string, unknown> } };
} {
  const elicitResponses = options.elicitResponses ?? [];
  if (elicitResponses.length === 0) {
    return {};
  }

  const resume = elicitResponses.map(resumeEntryForElicitResponse);
  const clientReplayTraces: Record<string, unknown> = {};

  for (const response of elicitResponses) {
    if (!response.trace) {
      continue;
    }
    const normalized = normalizeClientReplayTrace(response.trace, {
      interruptId: response.elicitId,
    });
    if (normalized) {
      clientReplayTraces[response.elicitId] = normalized;
    }
  }

  return {
    resume,
    ...(Object.keys(clientReplayTraces).length > 0
      ? { forwardedProps: { sweatpants: { clientReplayTraces } } }
      : {}),
  };
}

export function* executeChatFetch(
  baseUrl: string,
  messages: Message[],
  options: StreamChatOptions,
  signal: AbortSignal,
): Operation<Response> {
  const resumeForwardedProps = buildResumeForwardedProps(options);

  const chatFetch = options.fetch ?? globalThis.fetch;
  const response = yield* call(() =>
    chatFetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: options.conversationId,
        messages,
        enabledTools: deriveEnabledTools(options),
        enabledPlugins: deriveEnabledPlugins(options),
        systemPrompt: options.systemPrompt,
        persona: options.persona,
        personaConfig: options.personaConfig,
        enableOptionalTools: options.enableOptionalTools,
        effort: options.effort,
        streamOptions: options.streamOptions,
        initialToolChoice: options.initialToolChoice,
        replayState: options.replayState,
        pluginAbort: options.pluginAbort,
        ...resumeForwardedProps,
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
      if (json.error) {
        errorMessage = json.error;
      }
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
