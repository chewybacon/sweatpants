import type {
  Context,
  Model,
  Message,
  SimpleStreamOptions,
  AssistantMessage,
  Usage,
} from "@earendil-works/pi-ai";
import type { ChatMessagePart, ModelRequest } from "@sweatpan.ts/providers";

import { encodeContent } from "./content.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function assistant(part: ChatMessagePart): AssistantMessage["content"][number] {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  if (part.type === "reasoning") {
    if (part.format !== null) {
      throw new Error("Unsupported pi-ai reasoning format");
    }
    return {
      type: "thinking",
      thinking: part.text,
      thinkingSignature: part.signature ?? undefined,
      redacted: part.redacted,
    };
  }
  if (part.type === "tool-call") {
    const input = part.toolCall.input;
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Pi-ai tool arguments must be an object");
    }
    // The input context was detached before translation.
    return {
      type: "toolCall",
      id: part.toolCall.id,
      name: part.toolCall.name,
      arguments: Object.fromEntries(Object.entries(input)),
      thoughtSignature: part.toolCall.thoughtSignature ?? undefined,
    };
  }
  throw new Error(`Unsupported pi-ai assistant modality: ${part.type}`);
}
export function encode(
  request: ModelRequest,
  model: Model<string>,
  accounting: ReadonlyMap<number, Usage> = new Map(),
): { context: Context; options: SimpleStreamOptions } {
  const context = structuredClone(request.context);
  const { responseFormat, topP, topK, thinking, toolChoice, ...options } = structuredClone(
    request.options ?? {},
  );
  if (
    responseFormat !== undefined ||
    topP !== undefined ||
    topK !== undefined ||
    toolChoice === "required"
  ) {
    throw new Error("Unsupported pi-ai generation option");
  }
  if (
    options.maxTokens !== undefined &&
    (!Number.isSafeInteger(options.maxTokens) ||
      options.maxTokens <= 0 ||
      options.maxTokens > model.maxTokens)
  ) {
    throw new Error("Invalid pi-ai output token limit");
  }
  if (
    thinking !== undefined &&
    ((thinking !== "off" && !model.reasoning) || model.thinkingLevelMap?.[thinking] === null)
  ) {
    throw new Error("Unsupported pi-ai reasoning level");
  }
  for (const budget of Object.values(options.thinkingBudgets ?? {})) {
    if (!Number.isSafeInteger(budget) || budget < 0) {
      throw new Error("Invalid pi-ai thinking budget");
    }
  }
  const messages: Message[] = [];
  const instructions: string[] = [];
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  for (const [index, message] of context.messages.entries()) {
    if (message.role === "system" || message.role === "developer") {
      if (messages.length) {
        throw new Error("Pi-ai instructions must precede conversation messages");
      }
      instructions.push(message.content);
    } else if (message.role === "tool") {
      if (pending.get(message.toolCallId) !== message.name) {
        throw new Error("Unmatched pi-ai tool result");
      }
      pending.delete(message.toolCallId);
      messages.push({
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.name,
        content: encodeContent(message.content, model.input),
        isError: message.isError,
        timestamp: 0,
      });
    } else {
      if (pending.size) {
        throw new Error("Unsettled pi-ai tool calls");
      }
      if (message.role === "user") {
        messages.push({
          role: "user",
          content: encodeContent(message.content, model.input),
          timestamp: 0,
        });
      } else {
        const content = message.content.map(assistant);
        for (const part of content) {
          if (part.type === "toolCall") {
            if (seen.has(part.id)) {
              throw new Error("Duplicate pi-ai tool call identity");
            }
            seen.add(part.id);
            pending.set(part.id, part.name);
          }
        }
        messages.push({
          role: "assistant",
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: structuredClone(accounting.get(index) ?? usage),
          stopReason: pending.size ? "toolUse" : "stop",
          timestamp: 0,
        });
      }
    }
  }
  if (pending.size) {
    throw new Error("Unsettled pi-ai tool calls");
  }
  return {
    context: {
      messages,
      systemPrompt: instructions.length ? instructions.join("\n\n") : undefined,
      tools: context.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        parameters: structuredClone(tool.parameters),
      })),
    },
    options: { ...options, toolChoice, reasoning: thinking === "off" ? undefined : thinking },
  };
}
