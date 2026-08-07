import { assertJson, requireJsonObject, type Json, type JsonObject } from "@sweatpants/foundation";
import {
  decodeChatContent,
  decodeChatContentPart,
  type ChatContent,
  type ChatContentPart,
} from "./content.ts";

export type ChatMessage =
  | ChatUserMessage
  | ChatAssistantMessage
  | ChatSystemMessage
  | ChatDeveloperMessage
  | ChatToolResultMessage;

export interface ChatUserMessage {
  readonly role: "user";
  readonly content: ChatContent;
}

export interface ChatAssistantMessage {
  readonly role: "assistant";
  readonly content: readonly ChatMessagePart[];
}

export interface ChatSystemMessage {
  readonly role: "system";
  readonly content: string;
}

export interface ChatDeveloperMessage {
  readonly role: "developer";
  readonly content: string;
}

export interface ChatToolResultMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly content: ChatContent;
  readonly isError: boolean;
}

export type ChatMessagePart = ChatContentPart | ChatReasoningPart | ChatToolCallPart;

export interface ChatReasoningPart {
  readonly type: "reasoning";
  readonly text: string;
  readonly format: string | null;
  readonly signature: string | null;
  readonly redacted: boolean;
}

export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Json;
  readonly thoughtSignature: string | null;
}

export interface ChatToolCallPart {
  readonly type: "tool-call";
  readonly toolCall: ChatToolCall;
}

export type ChatToolDefinition = {
  readonly name: string;
  readonly description: string | null;
  readonly parameters: JsonObject;
};

export type ChatMessageDecodeErrorCode =
  | "invalid-value"
  | "unknown-field"
  | "missing-field"
  | "invalid-role"
  | "invalid-part"
  | "invalid-tool-call"
  | "invalid-tool-definition";

export class ChatMessageDecodeError extends TypeError {
  readonly code: ChatMessageDecodeErrorCode;
  readonly path: string;

  constructor(code: ChatMessageDecodeErrorCode, path: string, message: string) {
    super(`[${code}] ${path}: ${message}`);
    this.name = "ChatMessageDecodeError";
    this.code = code;
    this.path = path;
  }
}

export function decodeChatMessage(value: unknown, path = "$"): ChatMessage {
  const input = record(value, path);
  const role = requiredString(input, "role", path);
  switch (role) {
    case "user":
      assertKeys(input, ["role", "content"], path);
      return freeze({ role, content: decodeChatContent(input["content"]) });
    case "assistant":
      assertKeys(input, ["role", "content"], path);
      return freeze({ role, content: decodeAssistantParts(input["content"], `${path}.content`) });
    case "system":
    case "developer":
      assertKeys(input, ["role", "content"], path);
      return freeze({ role, content: stringValue(input["content"], `${path}.content`) });
    case "tool":
      assertKeys(input, ["role", "toolCallId", "name", "content", "isError"], path);
      return freeze({
        role,
        toolCallId: requiredString(input, "toolCallId", path),
        name: requiredString(input, "name", path),
        content: decodeChatContent(input["content"]),
        isError: requiredBoolean(input, "isError", path),
      });
    default:
      throw new ChatMessageDecodeError(
        "invalid-role",
        `${path}.role`,
        `unsupported role ${JSON.stringify(role)}`,
      );
  }
}

export function decodeChatAssistantMessage(value: unknown, path = "$"): ChatAssistantMessage {
  const message = decodeChatMessage(value, path);
  if (message.role !== "assistant") {
    throw new ChatMessageDecodeError(
      "invalid-role",
      `${path}.role`,
      "expected an assistant message",
    );
  }
  return message;
}

export function decodeChatMessages(value: unknown, path = "$"): readonly ChatMessage[] {
  if (!Array.isArray(value)) {
    throw new ChatMessageDecodeError("invalid-value", path, "expected a message array");
  }
  return freeze(value.map((entry, index) => decodeChatMessage(entry, `${path}[${index}]`)));
}

export function decodeChatToolCall(value: unknown, path = "$"): ChatToolCall {
  const input = record(value, path);
  assertKeys(input, ["id", "name", "input", "thoughtSignature"], path);
  if (!Object.prototype.hasOwnProperty.call(input, "input")) {
    throw new ChatMessageDecodeError("missing-field", `${path}.input`, "input is required");
  }
  return freeze({
    id: requiredString(input, "id", path),
    name: requiredString(input, "name", path),
    input: jsonValue(input["input"], `${path}.input`, "invalid-tool-call"),
    thoughtSignature: nullableString(input["thoughtSignature"], `${path}.thoughtSignature`),
  });
}

export function decodeChatToolDefinition(value: unknown, path = "$"): ChatToolDefinition {
  const input = record(value, path);
  assertKeys(input, ["name", "description", "parameters"], path);
  return freeze({
    name: requiredString(input, "name", path),
    description: nullableString(input["description"], `${path}.description`),
    parameters: objectValue(input["parameters"], `${path}.parameters`, "invalid-tool-definition"),
  });
}

function decodeAssistantParts(value: unknown, path: string): readonly ChatMessagePart[] {
  if (!Array.isArray(value)) {
    throw new ChatMessageDecodeError("invalid-value", path, "expected an assistant part array");
  }
  return freeze(value.map((entry, index) => decodeAssistantPart(entry, `${path}[${index}]`)));
}

function decodeAssistantPart(value: unknown, path: string): ChatMessagePart {
  const input = record(value, path);
  const type = requiredString(input, "type", path);
  switch (type) {
    case "reasoning":
      assertKeys(input, ["type", "text", "format", "signature", "redacted"], path);
      return freeze({
        type,
        text: stringValue(input["text"], `${path}.text`),
        format: nullableString(input["format"], `${path}.format`),
        signature: nullableString(input["signature"], `${path}.signature`),
        redacted: optionalBoolean(input["redacted"], `${path}.redacted`),
      });
    case "tool-call":
      assertKeys(input, ["type", "toolCall"], path);
      return freeze({ type, toolCall: decodeChatToolCall(input["toolCall"], `${path}.toolCall`) });
    case "text":
    case "image":
    case "audio":
    case "video":
    case "document": {
      try {
        return decodeChatContentPart(input, path);
      } catch (error) {
        if (error instanceof ChatMessageDecodeError) throw error;
        throw new ChatMessageDecodeError(
          "invalid-part",
          path,
          error instanceof Error ? error.message : "content part did not decode",
        );
      }
    }
    default:
      throw new ChatMessageDecodeError(
        "invalid-part",
        `${path}.type`,
        `unsupported assistant part ${JSON.stringify(type)}`,
      );
  }
}

function record(value: unknown, path: string): JsonObject {
  try {
    return requireJsonObject(assertJson(value, path), path);
  } catch (error) {
    throw new ChatMessageDecodeError(
      "invalid-value",
      path,
      error instanceof Error ? error.message : "expected a JSON object",
    );
  }
}

function jsonValue(value: unknown, path: string, code: ChatMessageDecodeErrorCode): Json {
  try {
    return assertJson(value, path);
  } catch (error) {
    throw new ChatMessageDecodeError(
      code,
      path,
      error instanceof Error ? error.message : "expected canonical JSON",
    );
  }
}

function objectValue(value: unknown, path: string, code: ChatMessageDecodeErrorCode): JsonObject {
  try {
    return requireJsonObject(assertJson(value, path), path);
  } catch (error) {
    throw new ChatMessageDecodeError(
      code,
      path,
      error instanceof Error ? error.message : "expected a JSON object",
    );
  }
}

function requiredString(input: JsonObject, key: string, path: string): string {
  if (!Object.prototype.hasOwnProperty.call(input, key)) {
    throw new ChatMessageDecodeError("missing-field", `${path}.${key}`, `${key} is required`);
  }
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ChatMessageDecodeError(
      "invalid-value",
      `${path}.${key}`,
      `${key} must be a non-empty string`,
    );
  }
  return value;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ChatMessageDecodeError("invalid-value", path, "expected a string");
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ChatMessageDecodeError("invalid-value", path, "expected a string or null");
  }
  return value;
}

function requiredBoolean(input: JsonObject, key: string, path: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(input, key) || typeof input[key] !== "boolean") {
    throw new ChatMessageDecodeError("missing-field", `${path}.${key}`, `${key} must be a boolean`);
  }
  return input[key];
}

function optionalBoolean(value: unknown, path: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new ChatMessageDecodeError("invalid-value", path, "expected a boolean");
  }
  return value;
}

function assertKeys(input: JsonObject, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new ChatMessageDecodeError("unknown-field", `${path}.${key}`, `unknown field ${key}`);
    }
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
