import type { InputContentPart, Message, ToolCall } from "@ag-ui/core";
import {
  assertJson,
  canonicalJson,
  requireJsonObject,
  type Json,
  type JsonObject,
} from "@sweatpants/foundation";
import type {
  ChatAssistantMessage,
  ChatContent,
  ChatContentPart,
  ChatMessage,
  ChatMessagePart,
  ChatToolCall,
  ChatToolResultMessage,
} from "@sweatpants/chat-contract";
import { decodeChatContent, decodeChatContentPart } from "../content.ts";
import type {
  ChatHistoryActivityEntry,
  ChatHistoryEntry,
  ChatHistoryMessageEntry,
} from "../history.ts";
import {
  ChatConversionError,
  type ChatConversionErrorCode,
  type ChatConversionDirection,
} from "./conversion.ts";

const AG_UI_TO_HISTORY = "ag-ui-to-chat-history" as const;
const HISTORY_TO_AG_UI = "chat-history-to-ag-ui" as const;

type AgUiUserMessage = Extract<Message, { role: "user" }>;
type AgUiAssistantMessage = Extract<Message, { role: "assistant" }>;
type AgUiToolMessage = Extract<Message, { role: "tool" }>;
type AgUiSystemMessage = Extract<Message, { role: "system" }>;
type AgUiDeveloperMessage = Extract<Message, { role: "developer" }>;
type AgUiActivityMessage = Extract<Message, { role: "activity" }>;
type AgUiReasoningMessage = Extract<Message, { role: "reasoning" }>;

export function agUiMessageToChatHistoryEntry(
  message: Message,
  toolName?: string,
): ChatHistoryEntry {
  rejectEncryptedValue(message, "$");
  switch (message.role) {
    case "user":
      rejectMessageName(message, "$.name");
      return messageEntry(message.id, {
        role: "user",
        content: contentFromAgUi(message.content, "$.content"),
      });
    case "assistant":
      rejectMessageName(message, "$.name");
      return messageEntry(message.id, assistantMessage(message));
    case "tool":
      return messageEntry(message.id, toolMessage(message, toolName));
    case "system":
      rejectMessageName(message, "$.name");
      return messageEntry(message.id, { role: "system", content: message.content });
    case "developer":
      rejectMessageName(message, "$.name");
      return messageEntry(message.id, { role: "developer", content: message.content });
    case "activity":
      return activityEntry(message);
    case "reasoning":
      rejectMessageName(message, "$.name");
      return messageEntry(message.id, {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: message.content,
            format: null,
            signature: null,
            redacted: false,
          },
        ],
      });
  }
}

export function agUiMessagesToChatHistoryEntries(
  messages: readonly Message[],
): readonly ChatHistoryEntry[] {
  const toolNames = new Map<string, string>();
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      rejectEncryptedToolCall(call, `$.messages[${index}].toolCalls`);
      toolNames.set(call.id, call.function.name);
    }
  }
  return Object.freeze(
    messages.map((message) =>
      agUiMessageToChatHistoryEntry(
        message,
        message.role === "tool" ? toolNames.get(message.toolCallId) : undefined,
      ),
    ),
  );
}

export function chatHistoryEntryToAgUiMessage(entry: ChatHistoryEntry): Message {
  assertEmptyMetadata(entry, "$");
  if (entry.type === "activity") {
    return {
      id: entry.id,
      role: "activity",
      activityType: entry.activityType,
      content: entry.data,
    } satisfies AgUiActivityMessage;
  }
  return messageToAgUi(entry.id, entry.message);
}

export function chatHistoryEntriesToAgUiMessages(
  entries: readonly ChatHistoryEntry[],
): readonly Message[] {
  const toolNames = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const part of entry.message.content) {
      if (part.type === "tool-call") toolNames.set(part.toolCall.id, part.toolCall.name);
    }
  }
  return Object.freeze(
    entries.map((entry, index) => {
      assertEmptyMetadata(entry, `$.entries[${index}]`);
      if (entry.type === "activity") {
        return chatHistoryEntryToAgUiMessage(entry);
      }
      if (entry.message.role !== "tool") {
        return messageToAgUi(entry.id, entry.message);
      }
      return toolHistoryToAgUiMessage(
        entry.id,
        entry.message,
        toolNames.get(entry.message.toolCallId),
        `$.entries[${index}]`,
      );
    }),
  );
}

function messageEntry(id: string, message: ChatMessage): ChatHistoryMessageEntry {
  return { type: "message", id, message, metadata: {} };
}

function activityEntry(message: AgUiActivityMessage): ChatHistoryActivityEntry {
  return {
    type: "activity",
    id: message.id,
    activityType: message.activityType,
    data: jsonObject(message.content, "$.content"),
    metadata: {},
  };
}

function assistantMessage(message: AgUiAssistantMessage): ChatAssistantMessage {
  const content: ChatMessagePart[] = [];
  if (message.content !== undefined) {
    content.push({ type: "text", text: message.content });
  }
  for (const [index, call] of (message.toolCalls ?? []).entries()) {
    content.push({
      type: "tool-call",
      toolCall: chatToolCall(call, `$.toolCalls[${index}]`),
    });
  }
  return { role: "assistant", content: Object.freeze(content) };
}

function toolMessage(
  message: AgUiToolMessage,
  toolName: string | undefined,
): ChatToolResultMessage {
  if (toolName === undefined) {
    throw conversion(
      "missing-tool-identity",
      "$.toolCallId",
      `no assistant tool call name for ${message.toolCallId}`,
    );
  }
  return {
    role: "tool",
    toolCallId: message.toolCallId,
    name: toolName,
    content: message.content,
    isError: message.error !== undefined,
  };
}

function chatToolCall(call: ToolCall, path: string): ChatToolCall {
  rejectEncryptedToolCall(call, path);
  let input: Json;
  try {
    input = assertJson(JSON.parse(call.function.arguments), `${path}.function.arguments`);
  } catch (error) {
    throw conversion(
      "invalid-tool-arguments",
      `${path}.function.arguments`,
      error instanceof Error ? error.message : "tool arguments are not valid JSON",
    );
  }
  return {
    id: call.id,
    name: call.function.name,
    input,
    thoughtSignature: null,
  };
}

function messageToAgUi(id: string, message: ChatMessage): Message {
  switch (message.role) {
    case "user":
      return {
        id,
        role: "user",
        content: contentToAgUiUserContent(message.content),
      } satisfies AgUiUserMessage;
    case "assistant":
      return assistantToAgUiMessage(id, message);
    case "system":
      return { id, role: "system", content: message.content } satisfies AgUiSystemMessage;
    case "developer":
      return { id, role: "developer", content: message.content } satisfies AgUiDeveloperMessage;
    case "tool":
      throw historyConversion(
        "unsupported-content",
        "$.message.name",
        `isolated canonical tool result ${message.name} requires preceding-call validation`,
      );
  }
}

function assistantToAgUiMessage(id: string, message: ChatAssistantMessage): Message {
  if (message.content.length === 1 && message.content[0]?.type === "reasoning") {
    const reasoning = message.content[0];
    if (reasoning.format !== null || reasoning.signature !== null || reasoning.redacted) {
      throw historyConversion(
        "unsupported-content",
        "$.message.content[0]",
        "AG-UI reasoning messages cannot represent replay metadata",
      );
    }
    return { id, role: "reasoning", content: reasoning.text } satisfies AgUiReasoningMessage;
  }

  let content: string | undefined;
  let sawToolCall = false;
  const toolCalls: ToolCall[] = [];
  for (const [index, part] of message.content.entries()) {
    const path = `$.message.content[${index}]`;
    if (part.type === "text") {
      if (sawToolCall || content !== undefined) {
        throw historyConversion(
          "unsupported-content",
          path,
          "AG-UI cannot preserve multiple or post-call assistant text parts",
        );
      }
      content = part.text;
      continue;
    }
    if (part.type === "tool-call") {
      sawToolCall = true;
      if (part.toolCall.thoughtSignature !== null) {
        throw historyConversion(
          "unsupported-content",
          `${path}.toolCall.thoughtSignature`,
          "AG-UI tool calls cannot represent thought signatures",
        );
      }
      toolCalls.push({
        id: part.toolCall.id,
        type: "function",
        function: {
          name: part.toolCall.name,
          arguments: canonicalJson(part.toolCall.input),
        },
      });
      continue;
    }
    throw historyConversion(
      "unsupported-content",
      path,
      `AG-UI assistant messages cannot represent ${part.type} parts`,
    );
  }
  return {
    id,
    role: "assistant",
    ...(content !== undefined ? { content } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  } satisfies AgUiAssistantMessage;
}

function toolHistoryToAgUiMessage(
  id: string,
  message: ChatToolResultMessage,
  precedingName: string | undefined,
  path: string,
): AgUiToolMessage {
  if (precedingName === undefined || precedingName !== message.name) {
    throw historyConversion(
      "missing-tool-identity",
      `${path}.message.toolCallId`,
      `tool ${message.toolCallId} has no matching preceding assistant call`,
    );
  }
  if (typeof message.content !== "string") {
    throw historyConversion(
      "unsupported-content",
      `${path}.message.content`,
      "AG-UI tool messages only represent string content",
    );
  }
  return message.isError
    ? {
        id,
        role: "tool",
        toolCallId: message.toolCallId,
        content: message.content,
        error: message.content,
      }
    : {
        id,
        role: "tool",
        toolCallId: message.toolCallId,
        content: message.content,
      };
}

function contentFromAgUi(value: AgUiUserMessage["content"], path: string): ChatContent {
  if (typeof value === "string") return decodeContent(value, path);
  const parts = value.map((part, index) => inputPartToCanonical(part, `${path}[${index}]`));
  return decodeContent(parts, path);
}

function contentToAgUiUserContent(value: ChatContent): AgUiUserMessage["content"] {
  if (typeof value === "string") return value;
  return value.map((part) => canonicalPartToAgUi(part));
}

function inputPartToCanonical(part: InputContentPart, path: string): ChatContentPart {
  if (part.type === "binary") {
    throw conversion(
      "unsupported-binary-content",
      path,
      "AG-UI binary content has no canonical Chat Content variant",
    );
  }
  if (part.type === "text") return { type: "text", text: part.text };
  try {
    return decodeChatContentPart(
      part.metadata === undefined
        ? { type: part.type, source: part.source }
        : { type: part.type, source: part.source, metadata: part.metadata },
      path,
    );
  } catch (error) {
    throw conversion(
      "unsupported-content",
      path,
      error instanceof Error ? error.message : "AG-UI content part is invalid",
    );
  }
}

function canonicalPartToAgUi(part: ChatContentPart): InputContentPart {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  return part.metadata === null
    ? { type: part.type, source: part.source }
    : { type: part.type, source: part.source, metadata: part.metadata };
}

function decodeContent(value: unknown, path: string): ChatContent {
  try {
    return decodeChatContent(value);
  } catch (error) {
    throw conversion(
      "unsupported-content",
      path,
      error instanceof Error ? error.message : "invalid canonical content",
    );
  }
}

function rejectEncryptedValue(message: Message, path: string): void {
  if ("encryptedValue" in message && message.encryptedValue !== undefined) {
    throw conversion(
      "unsupported-content",
      path,
      "encrypted AG-UI values have no canonical Chat History representation",
    );
  }
}

function rejectMessageName(message: Message, path: string): void {
  if ("name" in message && message.name !== undefined) {
    throw conversion("unsupported-content", path, "AG-UI message name has no canonical Chat field");
  }
}

function rejectEncryptedToolCall(call: ToolCall, path: string): void {
  if (call.encryptedValue !== undefined) {
    throw conversion(
      "unsupported-content",
      `${path}.encryptedValue`,
      "encrypted tool calls are not canonical Chat calls",
    );
  }
}

function assertEmptyMetadata(entry: ChatHistoryEntry, path: string): void {
  if (Object.keys(entry.metadata).length !== 0) {
    throw historyConversion(
      "unsupported-content",
      `${path}.metadata`,
      "AG-UI has no general history-entry metadata field",
    );
  }
}

function jsonObject(value: unknown, path: string): JsonObject {
  try {
    return requireJsonObject(assertJson(value, path), path);
  } catch (error) {
    throw conversion(
      "invalid-external-message",
      path,
      error instanceof Error ? error.message : "expected a JSON object",
    );
  }
}

function conversion(
  code: ChatConversionErrorCode,
  path: string,
  message: string,
): ChatConversionError {
  return new ChatConversionError(code, AG_UI_TO_HISTORY, path, message);
}

function historyConversion(
  code: ChatConversionErrorCode,
  path: string,
  message: string,
): ChatConversionError {
  const direction: ChatConversionDirection = HISTORY_TO_AG_UI;
  return new ChatConversionError(code, direction, path, message);
}
