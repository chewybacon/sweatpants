import { MessageSchema, type Message, type ToolCall } from "@ag-ui/core";
import { z } from "zod";

import type { ToolCall as InternalToolCall } from "@sweatpants/model-provider";
import type { Json } from "@sweatpants/foundation";
import type { ChatMessageContent, Message as InternalMessage } from "../messages.ts";

const jsonObjectSchema = z.record(z.string(), z.json());

function serializeArguments(args: Json): string {
  // `Json` cannot contain cycles or unserializable values, so this cannot throw.
  return JSON.stringify(args);
}

/**
 * AG-UI carries tool arguments as a JSON string. Decoding that string is this
 * codec's job; judging the decoded shape is the authored tool's. Undecodable
 * text survives verbatim rather than becoming a fabricated empty object.
 */
function parseArguments(args: string): Json {
  if (!args) {
    return {};
  }
  try {
    return JSON.parse(args) as Json;
  } catch {
    return args;
  }
}

function toolCallToAgUi(toolCall: InternalToolCall): ToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.function.name,
      arguments: serializeArguments(toolCall.function.arguments),
    },
  };
}

function toolCallFromAgUi(toolCall: ToolCall): InternalToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.function.name,
      arguments: parseArguments(toolCall.function.arguments),
    },
  };
}

export function internalMessageToAgUiMessage(message: InternalMessage): Message {
  if (!message.id) {
    throw new Error("AG-UI projection requires a message id");
  }
  const id = message.id;

  if (message.role === "tool") {
    if (!message.tool_call_id) {
      throw new Error(`Tool message "${id}" has no settled tool_call_id`);
    }
    const content = messageContentText(message.content);
    return {
      id,
      role: "tool",
      content,
      toolCallId: message.tool_call_id,
      ...(message.isError ? { error: content } : {}),
    };
  }

  if (message.role === "assistant") {
    const content = messageContentText(message.content);
    return {
      id,
      role: "assistant",
      ...(content ? { content } : {}),
      ...(message.tool_calls?.length ? { toolCalls: message.tool_calls.map(toolCallToAgUi) } : {}),
    };
  }

  if (message.role === "activity") {
    return {
      id,
      role: "activity",
      activityType: message.activityType ?? "sweatpants:activity",
      content: parseActivityContent(messageContentText(message.content)),
    };
  }

  if (message.role === "user") {
    return { id, role: "user", content: message.content } as Message;
  }

  return {
    id,
    role: message.role,
    content: messageContentText(message.content),
  } as Message;
}

function messageContentText(content: ChatMessageContent | undefined): string {
  if (content === undefined || typeof content === "string") {
    return content ?? "";
  }
  return content
    .map((part: { readonly type: string; readonly text?: string }) =>
      part.type === "text" ? (part.text ?? "") : "",
    )
    .join("");
}

function parseActivityContent(content: string): Record<string, Json> {
  try {
    const parsed = jsonObjectSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : { value: content };
  } catch {
    return { value: content };
  }
}

export function internalMessagesToAgUiMessages(messages: InternalMessage[]): Message[] {
  return messages.map(internalMessageToAgUiMessage);
}

export function agUiMessageToInternalMessage(
  message: Message,
  toolNames: ReadonlyMap<string, string> = new Map(),
): InternalMessage | null {
  if (message.role === "activity") {
    return {
      id: message.id,
      role: "activity",
      activityType: message.activityType,
      content: JSON.stringify(message.content),
    };
  }

  if (message.role === "tool") {
    const name = toolNames.get(message.toolCallId);
    if (!name) {
      // An isolated tool result can occur at a checkpoint boundary before its
      // assistant call snapshot. Do not fabricate a tool identity; activity
      // projection remains the authoritative public execution representation.
      return null;
    }
    return {
      id: message.id,
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
      name,
      isError: message.error !== undefined,
    };
  }

  if (message.role === "assistant") {
    return {
      id: message.id,
      role: "assistant",
      content: message.content ?? "",
      ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(toolCallFromAgUi) } : {}),
    };
  }

  if (message.role === "reasoning") {
    return {
      id: message.id,
      role: "assistant",
      content: message.content,
    };
  }

  if (message.role === "user") {
    return {
      id: message.id,
      role: "user",
      content: message.content,
    };
  }

  return {
    id: message.id,
    role: message.role === "developer" ? "system" : message.role,
    content:
      typeof message.content === "string" ? message.content : messageContentText(message.content),
  };
}

export function agUiMessagesToInternalMessages(messages: Message[]): InternalMessage[] {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        toolNames.set(call.id, call.function.name);
      }
    }
  }
  const output: InternalMessage[] = [];
  for (const message of messages) {
    const internal = agUiMessageToInternalMessage(message, toolNames);
    if (internal) {
      output.push(internal);
    }
  }
  return output;
}

export function isAgUiMessageArray(value: unknown): value is Message[] {
  return Array.isArray(value) && value.every((entry) => MessageSchema.safeParse(entry).success);
}
