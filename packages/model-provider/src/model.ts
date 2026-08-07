import { assertJson, requireJsonObject, type JsonObject } from "@sweatpants/foundation";
import {
  decodeChatAssistantMessage,
  decodeChatMessages,
  decodeChatToolCall,
  decodeChatToolDefinition,
  type ChatAssistantMessage,
  type ChatMessage,
  type ChatToolDefinition,
} from "@sweatpants/chat-contract";
import type { ModelResponseSource } from "./model-shared.ts";

export interface ModelContext {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ChatToolDefinition[];
}

export interface ModelCost {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly total: number | null;
}

export interface ModelUsage {
  readonly input: number | null;
  readonly output: number | null;
  readonly total: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly cost: ModelCost | null;
}

export interface ModelResponse {
  readonly message: ChatAssistantMessage;
  readonly source: ModelResponseSource | null;
  readonly usage: ModelUsage | null;
  readonly stopReason: string | null;
  readonly responseId: string | null;
  readonly errorMessage: string | null;
}

export interface ModelRequest {
  readonly context: ModelContext;
  readonly options?: ModelGenerationOptions;
}

export type ModelGenerationOptions = {
  readonly toolChoice?: "auto" | "none" | "required";
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly responseFormat?: {
    readonly type: "json_schema";
    readonly name?: string;
    readonly schema: JsonObject;
  };
};

export type ModelStreamEvent =
  | { readonly type: "start"; readonly partial: ChatAssistantMessage }
  | {
      readonly type: "text-start";
      readonly contentIndex: number;
      readonly partial: ChatAssistantMessage;
    }
  | {
      readonly type: "text-delta";
      readonly contentIndex: number;
      readonly delta: string;
      readonly partial: ChatAssistantMessage;
    }
  | {
      readonly type: "text-end";
      readonly contentIndex: number;
      readonly content: string;
      readonly partial: ChatAssistantMessage;
    }
  | {
      readonly type: "reasoning-start";
      readonly contentIndex: number;
      readonly partial: ChatAssistantMessage;
    }
  | {
      readonly type: "reasoning-delta";
      readonly contentIndex: number;
      readonly delta: string;
      readonly partial: ChatAssistantMessage;
    }
  | {
      readonly type: "reasoning-end";
      readonly contentIndex: number;
      readonly content: string;
      readonly partial: ChatAssistantMessage;
    }
  | {
      readonly type: "tool-call-start";
      readonly contentIndex: number;
      readonly partial: ChatAssistantMessage;
    }
  | {
      readonly type: "tool-call-delta";
      readonly contentIndex: number;
      readonly delta: string;
      readonly partial: ChatAssistantMessage;
    }
  | {
      readonly type: "tool-call-end";
      readonly contentIndex: number;
      readonly toolCall: import("@sweatpants/chat-contract").ChatToolCall;
      readonly partial: ChatAssistantMessage;
    }
  | { readonly type: "done"; readonly reason: string; readonly message: ChatAssistantMessage }
  | {
      readonly type: "error";
      readonly reason: "error" | "aborted";
      readonly error: ChatAssistantMessage;
    };

export type ModelDecodeErrorCode =
  | "invalid-value"
  | "unknown-field"
  | "missing-field"
  | "invalid-context"
  | "invalid-response"
  | "invalid-stream-event";

export class UnsupportedModelCapabilityError extends Error {
  readonly code = "unsupported-model-capability" as const;
  readonly path: string;
  readonly modality: string;
  readonly provider: string | null;
  readonly model: string | null;

  constructor(
    path: string,
    modality: string,
    message: string,
    provider: string | null = null,
    model: string | null = null,
  ) {
    super(`[unsupported-model-capability] ${path}: ${message}`);
    this.name = "UnsupportedModelCapabilityError";
    this.path = path;
    this.modality = modality;
    this.provider = provider;
    this.model = model;
  }
}

export class ModelDecodeError extends TypeError {
  readonly code: ModelDecodeErrorCode;
  readonly path: string;

  constructor(code: ModelDecodeErrorCode, path: string, message: string) {
    super(`[${code}] ${path}: ${message}`);
    this.name = "ModelDecodeError";
    this.code = code;
    this.path = path;
  }
}

export function decodeModelContext(value: unknown, path = "$"): ModelContext {
  const input = record(value, path);
  assertKeys(input, ["messages", "tools"], path);
  if (!hasOwn(input, "messages")) {
    throw new ModelDecodeError("missing-field", `${path}.messages`, "messages are required");
  }
  let messages: readonly ChatMessage[];
  try {
    messages = decodeChatMessages(input["messages"], `${path}.messages`);
  } catch (error) {
    throw new ModelDecodeError(
      "invalid-context",
      `${path}.messages`,
      error instanceof Error ? error.message : "invalid Chat messages",
    );
  }
  const tools = decodeTools(input["tools"], `${path}.tools`);
  return freeze({ messages, tools });
}

export function decodeModelResponse(value: unknown, path = "$"): ModelResponse {
  const input = record(value, path);
  assertKeys(
    input,
    ["message", "source", "usage", "stopReason", "responseId", "errorMessage"],
    path,
  );
  let message: ChatAssistantMessage;
  try {
    message = decodeChatAssistantMessage(input["message"], `${path}.message`);
  } catch (error) {
    throw new ModelDecodeError(
      "invalid-response",
      `${path}.message`,
      error instanceof Error ? error.message : "expected an assistant message",
    );
  }
  return freeze({
    message,
    source: decodeSourceOrNull(input["source"], `${path}.source`),
    usage: decodeUsageOrNull(input["usage"], `${path}.usage`),
    stopReason: nullableString(input["stopReason"], `${path}.stopReason`),
    responseId: nullableString(input["responseId"], `${path}.responseId`),
    errorMessage: nullableString(input["errorMessage"], `${path}.errorMessage`),
  });
}

export function decodeModelStreamEvent(value: unknown, path = "$"): ModelStreamEvent {
  const input = record(value, path);
  const type = requiredString(input, "type", path);
  switch (type) {
    case "start":
      assertKeys(input, ["type", "partial"], path);
      return freeze({ type, partial: assistantMessage(input["partial"], `${path}.partial`) });
    case "text-start":
    case "reasoning-start":
    case "tool-call-start":
      assertKeys(input, ["type", "contentIndex", "partial"], path);
      return freeze({
        type,
        contentIndex: indexField(input, "contentIndex", path),
        partial: assistantMessage(input["partial"], `${path}.partial`),
      });
    case "text-delta":
    case "reasoning-delta":
    case "tool-call-delta":
      assertKeys(input, ["type", "contentIndex", "delta", "partial"], path);
      return freeze({
        type,
        contentIndex: indexField(input, "contentIndex", path),
        delta: stringValue(input["delta"], `${path}.delta`),
        partial: assistantMessage(input["partial"], `${path}.partial`),
      });
    case "text-end":
    case "reasoning-end":
      assertKeys(input, ["type", "contentIndex", "content", "partial"], path);
      return freeze({
        type,
        contentIndex: indexField(input, "contentIndex", path),
        content: stringValue(input["content"], `${path}.content`),
        partial: assistantMessage(input["partial"], `${path}.partial`),
      });
    case "tool-call-end":
      assertKeys(input, ["type", "contentIndex", "toolCall", "partial"], path);
      try {
        return freeze({
          type,
          contentIndex: indexField(input, "contentIndex", path),
          toolCall: decodeChatToolCall(input["toolCall"], `${path}.toolCall`),
          partial: assistantMessage(input["partial"], `${path}.partial`),
        });
      } catch (error) {
        throw new ModelDecodeError(
          "invalid-stream-event",
          `${path}.toolCall`,
          error instanceof Error ? error.message : "invalid settled tool call",
        );
      }
    case "done":
      assertKeys(input, ["type", "reason", "message"], path);
      return freeze({
        type,
        reason: stringValue(input["reason"], `${path}.reason`),
        message: assistantMessage(input["message"], `${path}.message`),
      });
    case "error":
      assertKeys(input, ["type", "reason", "error"], path);
      return freeze({
        type,
        reason: errorReason(input, path),
        error: assistantMessage(input["error"], `${path}.error`),
      });
    default:
      throw new ModelDecodeError(
        "invalid-stream-event",
        `${path}.type`,
        `unsupported stream event ${type}`,
      );
  }
}

function decodeTools(value: unknown, path: string): readonly ChatToolDefinition[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new ModelDecodeError("invalid-context", path, "tools must be an array");
  }
  return freeze(
    value.map((entry, index) => {
      try {
        return decodeChatToolDefinition(entry, `${path}[${index}]`);
      } catch (error) {
        throw new ModelDecodeError(
          "invalid-context",
          `${path}[${index}]`,
          error instanceof Error ? error.message : "invalid Chat tool definition",
        );
      }
    }),
  );
}

function decodeSourceOrNull(value: unknown, path: string): ModelResponseSource | null {
  if (value === undefined || value === null) return null;
  const input = record(value, path);
  assertKeys(input, ["api", "provider", "model", "responseModel"], path);
  return freeze({
    api: requiredString(input, "api", path),
    provider: requiredString(input, "provider", path),
    model: requiredString(input, "model", path),
    responseModel: nullableString(input["responseModel"], `${path}.responseModel`),
  });
}

function decodeUsageOrNull(value: unknown, path: string): ModelUsage | null {
  if (value === undefined || value === null) return null;
  const input = record(value, path);
  assertKeys(input, ["input", "output", "total", "cacheRead", "cacheWrite", "cost"], path);
  return freeze({
    input: nullableNumber(input["input"], `${path}.input`),
    output: nullableNumber(input["output"], `${path}.output`),
    total: nullableNumber(input["total"], `${path}.total`),
    cacheRead: nullableNumber(input["cacheRead"], `${path}.cacheRead`),
    cacheWrite: nullableNumber(input["cacheWrite"], `${path}.cacheWrite`),
    cost: decodeCostOrNull(input["cost"], `${path}.cost`),
  });
}

function decodeCostOrNull(value: unknown, path: string): ModelCost | null {
  if (value === undefined || value === null) return null;
  const input = record(value, path);
  assertKeys(input, ["input", "output", "cacheRead", "cacheWrite", "total"], path);
  return freeze({
    input: nullableNumber(input["input"], `${path}.input`),
    output: nullableNumber(input["output"], `${path}.output`),
    cacheRead: nullableNumber(input["cacheRead"], `${path}.cacheRead`),
    cacheWrite: nullableNumber(input["cacheWrite"], `${path}.cacheWrite`),
    total: nullableNumber(input["total"], `${path}.total`),
  });
}

function assistantMessage(value: unknown, path: string): ChatAssistantMessage {
  try {
    return decodeChatAssistantMessage(value, path);
  } catch (error) {
    throw new ModelDecodeError(
      "invalid-stream-event",
      path,
      error instanceof Error ? error.message : "expected an assistant message",
    );
  }
}

function errorReason(input: JsonObject, path: string): "error" | "aborted" {
  const reason = requiredString(input, "reason", path);
  if (reason !== "error" && reason !== "aborted") {
    throw new ModelDecodeError(
      "invalid-stream-event",
      `${path}.reason`,
      "expected error or aborted",
    );
  }
  return reason;
}

function record(value: unknown, path: string): JsonObject {
  try {
    return requireJsonObject(assertJson(value, path), path);
  } catch (error) {
    throw new ModelDecodeError(
      "invalid-value",
      path,
      error instanceof Error ? error.message : "expected a JSON object",
    );
  }
}

function requiredString(input: JsonObject, key: string, path: string): string {
  if (!hasOwn(input, key) || typeof input[key] !== "string" || input[key].length === 0) {
    throw new ModelDecodeError(
      "missing-field",
      `${path}.${key}`,
      `${key} must be a non-empty string`,
    );
  }
  return input[key] as string;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ModelDecodeError("invalid-value", path, "expected a string");
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ModelDecodeError("invalid-value", path, "expected a string or null");
  }
  return value;
}

function nullableNumber(value: unknown, path: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ModelDecodeError("invalid-value", path, "expected a finite number or null");
  }
  return value;
}

function indexField(input: JsonObject, key: string, path: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ModelDecodeError(
      "invalid-stream-event",
      `${path}.${key}`,
      "expected a non-negative safe integer",
    );
  }
  return value;
}

function assertKeys(input: JsonObject, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new ModelDecodeError("unknown-field", `${path}.${key}`, `unknown field ${key}`);
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
