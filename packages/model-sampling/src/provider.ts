import type { ChatToolCall } from "@sweatpants/chat-contract";
import type { ModelResponse } from "@sweatpants/model-provider";
import type { ChatToolDefinition } from "@sweatpants/chat-contract";
import type { JsonObject } from "@sweatpants/foundation";

export function projectSamplingTools<T extends { name: string; description?: string }>(
  tools: readonly T[] | undefined,
  project: (tool: T) => JsonObject,
): ChatToolDefinition[] | undefined {
  return tools?.map((tool) => ({
    name: tool.name,
    description: tool.description ?? null,
    parameters: project(tool),
  }));
}

export function assistantText(response: ModelResponse): string {
  return response.message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

export function assistantToolCalls(response: ModelResponse): ChatToolCall[] {
  return response.message.content.flatMap((part) =>
    part.type === "tool-call" ? [part.toolCall] : [],
  );
}

export function samplingToolCalls(response: ModelResponse): ChatToolCall[] {
  return assistantToolCalls(response);
}

/** Provider-independent structured text recovery used by sampling adapters. */
export function parseStructuredSampleText(text: string): unknown {
  const stripThinkingBlocks = (value: string): string =>
    value.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
  const extractFencedJson = (value: string): string | undefined =>
    /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(value)?.[1]?.trim();
  // Balanced JSON recovery intentionally tracks string, escape, and nesting state.
  // fallow-ignore-next-line complexity
  const extractBalancedJson = (value: string): string | undefined => {
    const start = value.search(/[[{]/);
    if (start < 0) return undefined;
    const opener = value[start]!;
    const closer = opener === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const char = value[index]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = inString;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === opener) depth += 1;
      if (char === closer) depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
    return undefined;
  };
  const stripped = stripThinkingBlocks(text);
  const candidates = [
    text,
    stripped,
    extractFencedJson(text),
    extractBalancedJson(stripped),
    extractBalancedJson(text),
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()));
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Failed to parse JSON");
}
