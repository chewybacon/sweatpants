import { z } from "zod";

import type { ToolCall } from "@sweatpants/model-provider";
import type { Message } from "../messages.ts";
import type { Json } from "@sweatpants/foundation";
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
  | {
      id: string;
      role: "tool";
      content: string;
      toolCallId: string;
      name?: string;
      error?: string;
    }
  | {
      id: string;
      role: "activity";
      activityType: string;
      content: PluginReplayActivityContent | Record<string, unknown>;
    }
  | { id: string; role: "reasoning"; content: string };

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
    if (!message.tool_call_id) {
      throw new Error(`Tool message "${id}" has no settled tool_call_id`);
    }
    return {
      id,
      role: "tool",
      content: message.content,
      toolCallId: message.tool_call_id,
      ...(message.name ? { name: message.name } : {}),
      ...(message.isError ? { error: message.content } : {}),
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

export function agUiMessageToInternalMessage(
  message: AgUiMessage,
  toolNames: ReadonlyMap<string, string> = new Map(),
): Message | null {
  if (message.role === "activity") {
    return {
      id: message.id,
      role: "activity",
      activityType: message.activityType,
      content: JSON.stringify(message.content),
    };
  }

  if (message.role === "tool") {
    const name = message.name ?? toolNames.get(message.toolCallId);
    if (!name) {
      throw new Error(`AG-UI tool result "${message.toolCallId}" has no preceding call name`);
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

  return {
    id: message.id,
    role: message.role,
    content: message.content,
  };
}

export function agUiMessagesToInternalMessages(messages: AgUiMessage[]): Message[] {
  const toolNames = new Map<string, string>();
  const output: Message[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        toolNames.set(call.id, call.function.name);
      }
    }
    const internal = agUiMessageToInternalMessage(message, toolNames);
    if (internal) output.push(internal);
  }
  return output;
}

export function isAgUiMessageArray(value: unknown): value is AgUiMessage[] {
  return Array.isArray(value);
}
