/**
 * lib/chat/session/api-transport.ts
 */
import type { Operation } from "effection";
import { call } from "effection";
import type { Message } from "../messages.ts";
import type { StreamChatOptions, ElicitResponseData } from "./options.ts";

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
  if (response.completion.action === "cancel") {
    return { interruptId: response.elicitId, status: "cancelled" as const };
  }
  if (response.completion.action === "decline") {
    return {
      interruptId: response.elicitId,
      status: "resolved" as const,
      payload: { action: "decline" as const },
    };
  }
  return {
    interruptId: response.elicitId,
    status: "resolved" as const,
    payload: { action: "accept" as const, content: response.completion.content },
  };
}

function buildResume(
  options: StreamChatOptions,
): ReturnType<typeof resumeEntryForElicitResponse>[] {
  return (options.elicitResponses ?? []).map(resumeEntryForElicitResponse);
}

export function* executeChatFetch(
  baseUrl: string,
  messages: Message[],
  options: StreamChatOptions,
  signal: AbortSignal,
): Operation<Response> {
  const resume = buildResume(options);

  const chatFetch = options.fetch ?? globalThis.fetch;
  const response = yield* call(() =>
    chatFetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: options.conversationId,
        messages,
        enabledTools: deriveEnabledTools(options),
        systemPrompt: options.systemPrompt,
        persona: options.persona,
        personaConfig: options.personaConfig,
        enableOptionalTools: options.enableOptionalTools,
        effort: options.effort,
        streamOptions: options.streamOptions,
        initialToolChoice: options.initialToolChoice,
        pluginAbort: options.pluginAbort,
        ...(resume.length > 0 ? { resume } : {}),
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
