import { assertJson } from "@sweatpants/foundation";
import { chatMessagesParser } from "@sweatpants/chat-contract";
import { z } from "zod";

/** Only the history projection crosses into the JSON-only evaluator. */
export const exchangeSchema = z.object({ messages: z.array(z.json()).max(256) });

export function exchangeMessages(exchanges: z.infer<typeof exchangeSchema>[]) {
  const parsed = chatMessagesParser.parse(exchanges.flatMap((exchange) => exchange.messages));
  if (!parsed.ok) {
    throw new Error(`Invalid exchange messages: ${JSON.stringify(parsed.issues)}`);
  }
  const ids = new Set<string>();
  const pending = new Map<string, string>();
  for (const message of parsed.value) {
    if (pending.size > 0 && message.role !== "tool") {
      throw new Error("Exchange tool calls must be followed by their results");
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type !== "tool-call") {
          continue;
        }
        if (ids.has(part.toolCall.id)) {
          throw new Error("Duplicate exchange tool call identity");
        }
        ids.add(part.toolCall.id);
        pending.set(part.toolCall.id, part.toolCall.name);
      }
    } else if (message.role === "tool") {
      if (!pending.has(message.toolCallId) || pending.get(message.toolCallId) !== message.name) {
        throw new Error("Unmatched exchange tool result");
      }
      pending.delete(message.toolCallId);
    }
  }
  if (pending.size > 0) {
    throw new Error("Exchange history has unresolved tool calls");
  }
  return parsed.value;
}

export function projectExchange(exchange: { messages: unknown }) {
  return exchangeSchema.parse({ messages: assertJson(exchange.messages) });
}
