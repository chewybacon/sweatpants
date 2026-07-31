import { assertJson } from "@sweatpants/foundation";
import {
  toPortableAssistantMessage,
  type AssistantMessage,
  type PortableAssistantMessage,
  type PortableToolCall,
} from "@sweatpants/model-provider";
import type { ModelResponseMode, ModelSampleOutput, ModelSampleResult } from "./contract.ts";

export function assistantText(message: PortableAssistantMessage): string {
  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

export function assistantToolCalls(message: PortableAssistantMessage): PortableToolCall[] {
  return message.content.flatMap((block) => (block.type === "toolCall" ? [block.toolCall] : []));
}

function settleJson(message: PortableAssistantMessage): ModelSampleOutput {
  const call = assistantToolCalls(message)[0];
  if (call) {
    return { type: "json", value: call.function.arguments };
  }
  const rawText = assistantText(message);
  try {
    return { type: "json", value: assertJson(JSON.parse(rawText)) };
  } catch {
    return {
      type: "json-invalid",
      error: { message: "Failed to parse structured sample", rawText },
    };
  }
}

/** Settles provider output once before the durable effect result is journaled. */
export function settleModelSample(
  response: ModelResponseMode,
  message: AssistantMessage,
): ModelSampleResult {
  const portable = toPortableAssistantMessage(message);
  return {
    message: portable,
    output: response.type === "message" ? { type: "message" } : settleJson(portable),
  };
}
