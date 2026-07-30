import { z } from "zod";
import type { Json } from "@sweatpants/foundation";

export type NormalizedHistoryRecord =
  | { type: "user_text"; text: string }
  | { type: "assistant_text"; text: string }
  | {
      type: "assistant_tool_call";
      callId: string;
      name: string;
      arguments: Json;
    }
  | { type: "tool_result"; callId: string; output: unknown };

interface WireItem extends Record<string, unknown> {
  type?: unknown;
  text?: unknown;
  role?: unknown;
  content?: unknown;
  call_id?: unknown;
  name?: unknown;
  arguments?: unknown;
  output?: unknown;
}
const wireItemSchema = z.object({}).loose();

/** Provider history is deliberately tolerant: unusable entries are skipped, not fatal. */
const records = (value: unknown): WireItem[] =>
  (z.array(z.unknown()).safeParse(value).data ?? []).filter(
    (entry): entry is WireItem => wireItemSchema.safeParse(entry).success,
  );
const textParts = (value: unknown, kind: string): string =>
  records(value)
    .filter((p) => p.type === kind)
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("");
/** OpenAI Responses carries arguments as a JSON string; text that never decoded survives. */
const args = (value: unknown): Json => {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Json;
    } catch {
      return value;
    }
  }
  return (value ?? null) as Json;
};

/** Read-only semantic projection of OpenAI Responses input, in wire order. */
export function normalizeResponsesHistory(input: unknown): NormalizedHistoryRecord[] {
  const result: NormalizedHistoryRecord[] = [];
  const appendAssistant = (text: string) => {
    if (!text) {
      return;
    }
    const previous = result.at(-1);
    if (previous?.type === "assistant_text") {
      previous.text += text;
    } else {
      result.push({ type: "assistant_text", text });
    }
  };
  for (const item of records(input)) {
    if (item.type === "function_call") {
      result.push({
        type: "assistant_tool_call",
        callId: String(item.call_id ?? ""),
        name: String(item.name ?? ""),
        arguments: args(item.arguments),
      });
    } else if (item.type === "function_call_output") {
      let output: unknown = item.output;
      if (typeof output === "string") {
        try {
          output = JSON.parse(output);
        } catch {
          /* retain text */
        }
      }
      result.push({ type: "tool_result", callId: String(item.call_id ?? ""), output });
    } else if (item.role === "user") {
      const text =
        typeof item.content === "string" ? item.content : textParts(item.content, "input_text");
      if (text) {
        result.push({ type: "user_text", text });
      }
    } else if (item.role === "assistant") {
      appendAssistant(
        typeof item.content === "string" ? item.content : textParts(item.content, "output_text"),
      );
    }
  }
  return result;
}
