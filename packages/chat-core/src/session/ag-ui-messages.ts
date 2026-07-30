import { z } from "zod";

import type { Message, ToolCall } from "../messages.ts";
import type { PluginReplayActivityContent } from "./plugin-replay.ts";

const jsonObjectSchema = z.record(z.string(), z.json());

export interface AgUiFunctionCall {
  name: string;
  arguments: string;
}

export interface AgUiToolCall {
  id: string;
  type: "function";
  function: AgUiFunctionCall;
}

export type AgUiMessage =
  | { id: string; role: "developer"; content: string }
  | { id: string; role: "system"; content: string }
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; content?: string; toolCalls?: AgUiToolCall[] }
  | { id: string; role: "tool"; content: string; toolCallId: string; error?: string }
  | {
      id: string;
      role: "activity";
      activityType: string;
      content: PluginReplayActivityContent | Record<string, unknown>;
    }
  | { id: string; role: "reasoning"; content: string };

function serializeArguments(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return "{}";
  }
}

function parseArguments(args: string): Record<string, unknown> {
  if (!args) {
    return {};
  }
  try {
    const parsed = jsonObjectSchema.safeParse(JSON.parse(args));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function toolCallToAgUi(toolCall: ToolCall): AgUiToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.function.name,
      arguments: serializeArguments(toolCall.function.arguments),
    },
  };
}

function toolCallFromAgUi(toolCall: AgUiToolCall): ToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.function.name,
      arguments: parseArguments(toolCall.function.arguments),
    },
  };
}

export function internalMessageToAgUiMessage(message: Message): AgUiMessage {
  if (!message.id) {
    throw new Error("AG-UI projection requires a message id");
  }
  const id = message.id;

  if (message.role === "tool") {
    return {
      id,
      role: "tool",
      content: message.content,
      toolCallId: message.tool_call_id ?? "",
      ...(message.content.startsWith("Error:") ? { error: message.content } : {}),
    };
  }

  if (message.role === "assistant") {
    return {
      id,
      role: "assistant",
      ...(message.content ? { content: message.content } : {}),
      ...(message.tool_calls?.length ? { toolCalls: message.tool_calls.map(toolCallToAgUi) } : {}),
    };
  }

  if (message.role === "activity") {
    return {
      id,
      role: "activity",
      activityType: message.activityType ?? "sweatpants:activity",
      content: parseActivityContent(message.content),
    };
  }

  return {
    id,
    role: message.role,
    content: message.content,
  };
}

function parseActivityContent(content: string): Record<string, unknown> {
  try {
    const parsed = jsonObjectSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : { value: content };
  } catch {
    return { value: content };
  }
}

export function internalMessagesToAgUiMessages(messages: Message[]): AgUiMessage[] {
  return messages.map(internalMessageToAgUiMessage);
}

export function agUiMessageToInternalMessage(message: AgUiMessage): Message | null {
  if (message.role === "activity") {
    return {
      id: message.id,
      role: "activity",
      activityType: message.activityType,
      content: JSON.stringify(message.content),
    };
  }

  if (message.role === "tool") {
    return {
      id: message.id,
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
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

  return {
    id: message.id,
    role: message.role,
    content: message.content,
  };
}

export function agUiMessagesToInternalMessages(messages: AgUiMessage[]): Message[] {
  return messages
    .map(agUiMessageToInternalMessage)
    .filter((message): message is Message => message !== null);
}

export function isAgUiMessageArray(value: unknown): value is AgUiMessage[] {
  return Array.isArray(value);
}
