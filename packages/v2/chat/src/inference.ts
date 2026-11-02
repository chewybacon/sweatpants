import { assertCompleteHistory } from "./history.ts";
import type { ChatMessage, ChatMessagePart } from "@sweatpan.ts/providers";
import type { ChatInference, ChatInferenceOptions, ModelSelection } from "./contracts.ts";

function sameModel(a: ModelSelection, b: ModelSelection): boolean {
  return a.id === b.id && a.api === b.api && a.provider === b.provider;
}

/** Assemble a detached model-facing view after a completed tool round. Rejects
 * unresolved/mismatched/duplicate tool calls, unsupported modalities and explicitly
 * unsupported generation limits. No selection policy, I/O or persistence is implied. */
export function prepareChatInference(input: ChatInferenceOptions): ChatInference {
  const { model, history, tools, options, foreignReasoning = "reject" } = structuredClone(input);
  const selection: ModelSelection = { id: model.id, provider: model.provider, api: model.api };
  assertCompleteHistory(history);
  const messages: ChatMessage[] = [];
  for (const message of history) {
    if (message.role === "assistant") {
      const foreign = !sameModel(message.model, selection);
      const content: ChatMessagePart[] = [];
      for (const part of message.content) {
        const sensitive =
          part.type === "reasoning" ||
          (part.type === "tool-call" && part.toolCall.thoughtSignature !== null);
        if (foreign && sensitive && foreignReasoning !== "omit") {
          throw new Error("Foreign reasoning requires an explicit compatibility policy");
        }
        if (part.type === "tool-call") {
          content.push({
            ...part,
            toolCall: {
              ...part.toolCall,
              thoughtSignature: foreign ? null : part.toolCall.thoughtSignature,
            },
          });
        } else if (!(foreign && part.type === "reasoning")) {
          content.push(part);
        }
      }
      if (content.length || !foreign || message.content.length === 0) {
        messages.push({ role: "assistant", content });
      }
    } else {
      messages.push(message);
    }
  }
  for (const message of messages) {
    if (typeof message.content === "string") {
      if (!model.input.includes("text")) {
        throw new Error("Selected model does not accept text");
      }
      continue;
    }
    for (const part of message.content) {
      if (
        part.type !== "reasoning" &&
        part.type !== "tool-call" &&
        !model.input.includes(part.type)
      ) {
        throw new Error(`Selected model does not accept ${part.type}`);
      }
    }
  }
  if (
    options?.thinking !== undefined &&
    model.reasoningLevels !== null &&
    (options.thinking !== "off" || model.reasoningLevels.length > 0) &&
    !model.reasoningLevels.includes(options.thinking)
  ) {
    throw new Error("Selected model does not support requested reasoning level");
  }
  if (
    options?.maxTokens !== undefined &&
    (!Number.isSafeInteger(options.maxTokens) ||
      options.maxTokens <= 0 ||
      (model.maxOutputTokens !== null && options.maxTokens > model.maxOutputTokens))
  ) {
    throw new Error("Invalid selected model output token limit");
  }
  const request: ChatInference["request"] = { context: { messages, tools } };
  return options === undefined
    ? { model: selection, request }
    : { model: selection, request: { ...request, options } };
}
