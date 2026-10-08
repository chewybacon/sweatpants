import {
  failure,
  parser,
  success,
  type JsonObject,
  type ParseIssue,
  type ParseResult,
  type Parser,
} from "@sweatpants/foundation";
import {
  decodeChatAssistantMessage,
  decodeChatMessages,
  decodeChatToolCall,
  decodeChatToolDefinition,
  type ChatAssistantMessage,
  type ChatMessage,
  type ChatToolDefinition,
} from "@sweatpants/chat-contract";
import { z } from "zod";
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

// Nested values are validated and owned by their typed chat parsers below.
const modelContextSchema = z.strictObject({
  messages: z.array(z.unknown()),
  tools: z.array(z.unknown()).optional(),
});

const modelSourceSchema = z.strictObject({
  api: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  responseModel: z.string().nullable().optional(),
});

const modelCostSchema = z.strictObject({
  input: z.number().finite().nullable().optional(),
  output: z.number().finite().nullable().optional(),
  cacheRead: z.number().finite().nullable().optional(),
  cacheWrite: z.number().finite().nullable().optional(),
  total: z.number().finite().nullable().optional(),
});

const modelUsageSchema = z.strictObject({
  input: z.number().finite().nullable().optional(),
  output: z.number().finite().nullable().optional(),
  total: z.number().finite().nullable().optional(),
  cacheRead: z.number().finite().nullable().optional(),
  cacheWrite: z.number().finite().nullable().optional(),
  cost: modelCostSchema.nullable().optional(),
});

const modelResponseSchema = z.strictObject({
  message: z.unknown(),
  source: modelSourceSchema.nullable().optional(),
  usage: modelUsageSchema.nullable().optional(),
  stopReason: z.string().nullable().optional(),
  responseId: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
});

const modelStreamEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start"), partial: z.unknown() }),
  z.strictObject({
    type: z.literal("text-start"),
    contentIndex: z.number().int().nonnegative().safe(),
    partial: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("text-delta"),
    contentIndex: z.number().int().nonnegative().safe(),
    delta: z.string(),
    partial: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("text-end"),
    contentIndex: z.number().int().nonnegative().safe(),
    content: z.string(),
    partial: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("reasoning-start"),
    contentIndex: z.number().int().nonnegative().safe(),
    partial: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("reasoning-delta"),
    contentIndex: z.number().int().nonnegative().safe(),
    delta: z.string(),
    partial: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("reasoning-end"),
    contentIndex: z.number().int().nonnegative().safe(),
    content: z.string(),
    partial: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("tool-call-start"),
    contentIndex: z.number().int().nonnegative().safe(),
    partial: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("tool-call-delta"),
    contentIndex: z.number().int().nonnegative().safe(),
    delta: z.string(),
    partial: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("tool-call-end"),
    contentIndex: z.number().int().nonnegative().safe(),
    toolCall: z.unknown(),
    partial: z.unknown(),
  }),
  z.strictObject({ type: z.literal("done"), reason: z.string(), message: z.unknown() }),
  z.strictObject({
    type: z.literal("error"),
    reason: z.enum(["error", "aborted"]),
    error: z.unknown(),
  }),
]);

type StructuralModelContext = z.infer<typeof modelContextSchema>;
type StructuralModelResponse = z.infer<typeof modelResponseSchema>;
type StructuralModelStreamEvent = z.infer<typeof modelStreamEventSchema>;

const modelContextStructureParser = parser(modelContextSchema);
const modelResponseStructureParser = parser(modelResponseSchema);
const modelStreamEventStructureParser = parser(modelStreamEventSchema);

/** Result-oriented parser for the model context contract. */
export const modelContextParser: Parser<ModelContext> = modelContextStructureParser.andThen(
  (value) => normalizeResult(() => normalizeModelContext(value, "$"), "context"),
);

/** Result-oriented parser for the model response contract. */
export const modelResponseParser: Parser<ModelResponse> = modelResponseStructureParser.andThen(
  (value) => normalizeResult(() => normalizeModelResponse(value, "$"), "response"),
);

/** Result-oriented parser for model stream events. */
export const modelStreamEventParser: Parser<ModelStreamEvent> =
  modelStreamEventStructureParser.andThen((value) =>
    normalizeResult(() => normalizeModelStreamEvent(value, "$"), "stream-event"),
  );

export function decodeModelContext(value: unknown, path = "$"): ModelContext {
  const parsed = modelContextStructureParser.parse(value);
  if (!parsed.ok) throw modelErrorFromIssues(parsed.issues, path, "context");
  return requireModel(
    normalizeResult(() => normalizeModelContext(parsed.value, path), "context"),
    path,
  );
}

export function decodeModelResponse(value: unknown, path = "$"): ModelResponse {
  const parsed = modelResponseStructureParser.parse(value);
  if (!parsed.ok) throw modelErrorFromIssues(parsed.issues, path, "response");
  return requireModel(
    normalizeResult(() => normalizeModelResponse(parsed.value, path), "response"),
    path,
  );
}

export function decodeModelStreamEvent(value: unknown, path = "$"): ModelStreamEvent {
  const parsed = modelStreamEventStructureParser.parse(value);
  if (!parsed.ok) throw modelErrorFromIssues(parsed.issues, path, "stream-event");
  return requireModel(
    normalizeResult(() => normalizeModelStreamEvent(parsed.value, path), "stream-event"),
    path,
  );
}

function normalizeModelContext(value: StructuralModelContext, path: string): ModelContext {
  let messages: readonly ChatMessage[];
  try {
    messages = decodeChatMessages(value.messages, `${path}.messages`);
  } catch (error) {
    throw new ModelDecodeError(
      "invalid-context",
      `${path}.messages`,
      error instanceof Error ? error.message : "invalid Chat messages",
    );
  }
  const tools = (value.tools ?? []).map((entry, index) => {
    try {
      return decodeChatToolDefinition(entry, `${path}.tools.${index}`);
    } catch (error) {
      throw new ModelDecodeError(
        "invalid-context",
        `${path}.tools.${index}`,
        error instanceof Error ? error.message : "invalid Chat tool definition",
      );
    }
  });
  return freeze({ messages, tools });
}

function normalizeModelResponse(value: StructuralModelResponse, path: string): ModelResponse {
  let message: ChatAssistantMessage;
  try {
    message = decodeChatAssistantMessage(value.message, `${path}.message`);
  } catch (error) {
    throw new ModelDecodeError(
      "invalid-response",
      `${path}.message`,
      error instanceof Error ? error.message : "expected an assistant message",
    );
  }
  return freeze({
    message,
    source: normalizeSource(value.source),
    usage: normalizeUsage(value.usage),
    stopReason: value.stopReason ?? null,
    responseId: value.responseId ?? null,
    errorMessage: value.errorMessage ?? null,
  });
}

function normalizeModelStreamEvent(
  value: StructuralModelStreamEvent,
  path: string,
): ModelStreamEvent {
  switch (value.type) {
    case "start":
      return freeze({
        type: value.type,
        partial: assistantMessage(value.partial, `${path}.partial`),
      });
    case "text-start":
    case "reasoning-start":
    case "tool-call-start":
      return freeze({
        type: value.type,
        contentIndex: value.contentIndex,
        partial: assistantMessage(value.partial, `${path}.partial`),
      });
    case "text-delta":
    case "reasoning-delta":
    case "tool-call-delta":
      return freeze({
        type: value.type,
        contentIndex: value.contentIndex,
        delta: value.delta,
        partial: assistantMessage(value.partial, `${path}.partial`),
      });
    case "text-end":
    case "reasoning-end":
      return freeze({
        type: value.type,
        contentIndex: value.contentIndex,
        content: value.content,
        partial: assistantMessage(value.partial, `${path}.partial`),
      });
    case "tool-call-end":
      return freeze({
        type: value.type,
        contentIndex: value.contentIndex,
        toolCall: decodeChatToolCall(value.toolCall, `${path}.toolCall`),
        partial: assistantMessage(value.partial, `${path}.partial`),
      });
    case "done":
      return freeze({
        type: value.type,
        reason: value.reason,
        message: assistantMessage(value.message, `${path}.message`),
      });
    case "error":
      return freeze({
        type: value.type,
        reason: value.reason,
        error: assistantMessage(value.error, `${path}.error`),
      });
  }
}

function normalizeSource(value: StructuralModelResponse["source"]): ModelResponseSource | null {
  if (value === undefined || value === null) return null;
  return freeze({
    api: value.api,
    provider: value.provider,
    model: value.model,
    responseModel: value.responseModel ?? null,
  });
}

function normalizeUsage(value: StructuralModelResponse["usage"]): ModelUsage | null {
  if (value === undefined || value === null) return null;
  return freeze({
    input: value.input ?? null,
    output: value.output ?? null,
    total: value.total ?? null,
    cacheRead: value.cacheRead ?? null,
    cacheWrite: value.cacheWrite ?? null,
    cost:
      value.cost === undefined || value.cost === null
        ? null
        : freeze({
            input: value.cost.input ?? null,
            output: value.cost.output ?? null,
            cacheRead: value.cost.cacheRead ?? null,
            cacheWrite: value.cost.cacheWrite ?? null,
            total: value.cost.total ?? null,
          }),
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

function normalizeResult<T>(
  operation: () => T,
  context: "context" | "response" | "stream-event",
): ParseResult<T> {
  void context;
  try {
    return success(operation());
  } catch (error) {
    if (error instanceof ModelDecodeError) return failure(issueFromModelError(error));
    throw error;
  }
}

function requireModel<T>(result: ParseResult<T>, path: string): T {
  if (result.ok) return result.value;
  throw modelErrorFromIssues(result.issues, path, "value");
}

function modelErrorFromIssues(
  issues: readonly ParseIssue[],
  basePath: string,
  context: "context" | "response" | "stream-event" | "value",
): ModelDecodeError {
  const issue = issues[0] ?? { path: [], message: "invalid value" };
  const relative = issue.path.map(String).join(".");
  const path = relative.length === 0 ? basePath : `${basePath}.${relative}`;
  let code: ModelDecodeErrorCode = "invalid-value";
  if (issue.code === "unrecognized_keys") code = "unknown-field";
  else if (context === "context") code = "invalid-context";
  else if (context === "response") code = "invalid-response";
  else if (context === "stream-event") code = "invalid-stream-event";
  return new ModelDecodeError(code, path, issue.message);
}

function issueFromModelError(error: ModelDecodeError): ParseIssue {
  return {
    path: decodePath(error.path),
    message: error.message,
    code: error.code,
  };
}

function decodePath(path: string): Array<string | number> {
  if (path === "$" || path.length === 0) return [];
  return path
    .replace(/^\$\.?/u, "")
    .split(/[.[\]]+/u)
    .filter(Boolean)
    .map((part) => (/^\d+$/u.test(part) ? Number(part) : part));
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
