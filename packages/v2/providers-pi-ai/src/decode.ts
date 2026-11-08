import { z } from "zod";
import type {
  ChatAssistantMessage,
  ChatToolCall,
  ModelResponse,
  ModelStreamEvent,
} from "@sweatpan.ts/providers";

const tool = z.object({
  type: z.literal("toolCall"),
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.json()),
  thoughtSignature: z.string().optional(),
  namespace: z.never().optional(),
});
const part = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("thinking"),
    thinking: z.string(),
    thinkingSignature: z.string().optional(),
    redacted: z.boolean().optional(),
  }),
  tool,
]);
const amount = z.number().finite().nonnegative();
export const usageSchema = z.object({
  input: amount,
  output: amount,
  cacheRead: amount,
  cacheWrite: amount,
  totalTokens: amount,
  reasoning: amount.optional(),
  cacheWrite1h: amount.optional(),
  cost: z.object({
    input: amount,
    output: amount,
    cacheRead: amount,
    cacheWrite: amount,
    total: amount,
  }),
});
const message = z.object({
  role: z.literal("assistant"),
  content: z.array(part),
  api: z.string(),
  provider: z.string(),
  model: z.string(),
  responseModel: z.string().optional(),
  responseId: z.string().optional(),
  usage: usageSchema,
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  providerThinkingLevel: z.string().optional(),
  stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]),
  errorMessage: z.string().optional(),
});
function call(value: z.infer<typeof tool>): ChatToolCall {
  return {
    id: value.id,
    name: value.name,
    input: value.arguments,
    thoughtSignature: value.thoughtSignature ?? null,
  };
}
function content(value: z.infer<typeof message>): ChatAssistantMessage {
  return {
    role: "assistant",
    content: value.content.map((p) => {
      if (p.type === "text") {
        return { type: "text", text: p.text };
      }
      if (p.type === "thinking") {
        return {
          type: "reasoning",
          text: p.thinking,
          format: null,
          signature: p.thinkingSignature ?? null,
          redacted: p.redacted ?? false,
        };
      }
      return { type: "tool-call", toolCall: call(p) };
    }),
  };
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error("Invalid pi-ai response data");
  }
  return result.data;
}
export function response(value: unknown): ModelResponse {
  const result = parse(message, value);
  if (
    !["stop", "length", "toolUse"].includes(result.stopReason) ||
    result.errorMessage !== undefined
  ) {
    throw new Error("Pi-ai inference did not complete successfully");
  }
  const ids = result.content.filter((p) => p.type === "toolCall").map((p) => p.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Duplicate pi-ai tool call identity");
  }
  return {
    message: content(result),
    source: {
      api: result.api,
      provider: result.provider,
      model: result.model,
      responseModel: result.responseModel ?? null,
    },
    usage: decodeUsage(result.usage),
    reasoning: {
      requested: result.thinkingLevel ?? null,
      provider: result.providerThinkingLevel ?? null,
    },
    stopReason: result.stopReason,
    responseId: result.responseId ?? null,
    errorMessage: null,
  };
}
const indexed = { contentIndex: z.number().int().nonnegative(), partial: message };
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), partial: message }),
  z.object({ type: z.enum(["text_start", "thinking_start", "toolcall_start"]), ...indexed }),
  z.object({
    type: z.enum(["text_delta", "thinking_delta", "toolcall_delta"]),
    ...indexed,
    delta: z.string(),
  }),
  z.object({ type: z.enum(["text_end", "thinking_end"]), ...indexed, content: z.string() }),
  z.object({ type: z.literal("toolcall_end"), ...indexed, toolCall: tool }),
  z.object({ type: z.literal("done"), reason: z.enum(["stop", "length", "toolUse"]), message }),
  z.object({ type: z.literal("error"), reason: z.enum(["error", "aborted"]), error: message }),
]);
export function event(value: unknown): ModelStreamEvent {
  const e = parse(eventSchema, value);
  if (e.type === "error") {
    throw new Error("Pi-ai provider failed");
  }
  if (e.type === "done") {
    const final = response(e.message);
    if (e.reason !== final.stopReason) {
      throw new Error("Invalid pi-ai terminal reason");
    }
    return { type: "done", reason: e.reason, message: final.message };
  }
  const partial = content(e.partial);
  if (e.type === "start") {
    return { type: "start", partial };
  }
  const contentIndex = e.contentIndex;
  if (contentIndex >= partial.content.length) {
    throw new Error("Invalid pi-ai content index");
  }
  const kind = partial.content[contentIndex]?.type;
  if (
    (e.type.startsWith("text_") && kind !== "text") ||
    (e.type.startsWith("thinking_") && kind !== "reasoning") ||
    (e.type.startsWith("toolcall_") && kind !== "tool-call")
  ) {
    throw new Error("Invalid pi-ai content kind");
  }
  switch (e.type) {
    case "text_start":
      return { type: "text-start", contentIndex, partial };
    case "thinking_start":
      return { type: "reasoning-start", contentIndex, partial };
    case "toolcall_start":
      return { type: "tool-call-start", contentIndex, partial };
    case "text_delta":
      return { type: "text-delta", contentIndex, partial, delta: e.delta };
    case "thinking_delta":
      return { type: "reasoning-delta", contentIndex, partial, delta: e.delta };
    case "toolcall_delta":
      return { type: "tool-call-delta", contentIndex, partial, delta: e.delta };
    case "text_end":
      return { type: "text-end", contentIndex, partial, content: e.content };
    case "thinking_end":
      return { type: "reasoning-end", contentIndex, partial, content: e.content };
    case "toolcall_end":
      return { type: "tool-call-end", contentIndex, partial, toolCall: call(e.toolCall) };
  }
}

export function decodeUsage(value: z.infer<typeof usageSchema>) {
  return {
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    total: value.totalTokens,
    reasoning: value.reasoning ?? null,
    cacheWrite1h: value.cacheWrite1h ?? null,
    cost: value.cost,
  };
}
