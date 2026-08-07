import { assertJson, requireJsonObject, type JsonObject } from "@sweatpants/foundation";
import { decodeChatMessage, type ChatMessage } from "@sweatpants/chat-contract";

export type ChatHistoryEntry = ChatHistoryMessageEntry | ChatHistoryActivityEntry;

export interface ChatHistoryMessageEntry {
  readonly type: "message";
  readonly id: string;
  readonly message: ChatMessage;
  readonly metadata: JsonObject;
}

export interface ChatHistoryActivityEntry {
  readonly type: "activity";
  readonly id: string;
  readonly activityType: string;
  readonly data: JsonObject;
  readonly metadata: JsonObject;
}

export type ChatHistoryDecodeErrorCode =
  | "invalid-value"
  | "unknown-field"
  | "missing-field"
  | "invalid-entry"
  | "invalid-message"
  | "invalid-field";

export class ChatHistoryDecodeError extends TypeError {
  readonly code: ChatHistoryDecodeErrorCode;
  readonly path: string;

  constructor(code: ChatHistoryDecodeErrorCode, path: string, message: string) {
    super(`[${code}] ${path}: ${message}`);
    this.name = "ChatHistoryDecodeError";
    this.code = code;
    this.path = path;
  }
}

export function decodeChatHistoryEntry(value: unknown, path = "$"): ChatHistoryEntry {
  const input = jsonObject(value, path);
  const type = requiredString(input, "type", path);
  const id = requiredString(input, "id", path);
  switch (type) {
    case "message":
      assertKeys(input, ["type", "id", "message", "metadata"], path);
      if (!hasOwn(input, "message")) {
        throw new ChatHistoryDecodeError("missing-field", `${path}.message`, "message is required");
      }
      try {
        return freeze({
          type,
          id,
          message: decodeChatMessage(input["message"], `${path}.message`),
          metadata: metadata(input, path),
        });
      } catch (error) {
        if (error instanceof ChatHistoryDecodeError) throw error;
        throw new ChatHistoryDecodeError(
          "invalid-message",
          `${path}.message`,
          error instanceof Error ? error.message : "invalid canonical Chat message",
        );
      }
    case "activity":
      assertKeys(input, ["type", "id", "activityType", "data", "metadata"], path);
      return freeze({
        type,
        id,
        activityType: requiredString(input, "activityType", path),
        data: requiredObject(input, "data", path),
        metadata: metadata(input, path),
      });
    default:
      throw new ChatHistoryDecodeError(
        "invalid-entry",
        `${path}.type`,
        `unsupported history entry ${JSON.stringify(type)}`,
      );
  }
}

export function decodeChatHistoryEntries(value: unknown, path = "$"): readonly ChatHistoryEntry[] {
  if (!Array.isArray(value)) {
    throw new ChatHistoryDecodeError("invalid-value", path, "expected a history entry array");
  }
  return freeze(value.map((entry, index) => decodeChatHistoryEntry(entry, `${path}[${index}]`)));
}

function metadata(input: JsonObject, path: string): JsonObject {
  if (!hasOwn(input, "metadata")) return Object.freeze({});
  return requiredObject(input, "metadata", path);
}

function requiredObject(input: JsonObject, key: string, path: string): JsonObject {
  if (!hasOwn(input, key)) {
    throw new ChatHistoryDecodeError("missing-field", `${path}.${key}`, `${key} is required`);
  }
  try {
    return freeze(requireJsonObject(assertJson(input[key], `${path}.${key}`)));
  } catch (error) {
    throw new ChatHistoryDecodeError(
      "invalid-field",
      `${path}.${key}`,
      error instanceof Error ? error.message : `expected a JSON object for ${key}`,
    );
  }
}

function requiredString(input: JsonObject, key: string, path: string): string {
  if (!hasOwn(input, key) || typeof input[key] !== "string" || input[key].length === 0) {
    throw new ChatHistoryDecodeError(
      "missing-field",
      `${path}.${key}`,
      `${key} must be a non-empty string`,
    );
  }
  return input[key] as string;
}

function jsonObject(value: unknown, path: string): JsonObject {
  try {
    return requireJsonObject(assertJson(value, path), path);
  } catch (error) {
    if (error instanceof ChatHistoryDecodeError) throw error;
    throw new ChatHistoryDecodeError(
      "invalid-value",
      path,
      error instanceof Error ? error.message : "expected a JSON object",
    );
  }
}

function assertKeys(input: JsonObject, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new ChatHistoryDecodeError("unknown-field", `${path}.${key}`, `unknown field ${key}`);
    }
  }
}

function hasOwn(input: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
