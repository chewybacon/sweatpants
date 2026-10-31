import type { Operation } from "@standard-durability/core";
import type { Stream } from "@sweatpan.ts/runtime";

/** Scoped model request boundary. Request and wire representation belong to the adapter contract. */
export interface ModelProvider<
  Y,
  Request = ModelRequest,
  Event = ModelStreamEvent,
  Response = ModelResponse,
> {
  /**
   * Subscribe to one fresh inference request. Subscription starts work and its scope
   * owns cancellation and cleanup. Events are provisional; completion returns the
   * authoritative provider response, not journal acceptance. Failure throws rather
   * than manufacturing a completed response. No retry or persistence is implied.
   * Each subscription is a distinct request, not a broadcast of one inference.
   */
  stream(request: Request): Stream<Event, Response, Y>;
}

/** JSON values in model tool inputs, schemas and content metadata. */
export type Json = null | boolean | number | string | readonly Json[] | JsonObject;
/** A JSON object; provider credentials and executable callbacks are not model data. */
export interface JsonObject {
  readonly [key: string]: Json;
}

/** User/tool content: plain text or ordered multimodal parts. */
export type ChatContent = string | readonly ChatContentPart[];

/** Portable content alternatives; adapters must reject unsupported modalities explicitly. */
export type ChatContentPart =
  | ChatTextContentPart
  | ChatImageContentPart
  | ChatAudioContentPart
  | ChatVideoContentPart
  | ChatDocumentContentPart;

/** A complete text content part. */
export interface ChatTextContentPart {
  readonly type: "text";
  readonly text: string;
}

/** Image source plus portable metadata; support is adapter-specific. */
export interface ChatImageContentPart {
  readonly type: "image";
  readonly source: ChatContentSource;
  readonly metadata: JsonObject | null;
}

/** Audio source plus portable metadata; support is adapter-specific. */
export interface ChatAudioContentPart {
  readonly type: "audio";
  readonly source: ChatContentSource;
  readonly metadata: JsonObject | null;
}

/** Video source plus portable metadata; support is adapter-specific. */
export interface ChatVideoContentPart {
  readonly type: "video";
  readonly source: ChatContentSource;
  readonly metadata: JsonObject | null;
}

/** Document source plus portable metadata; support is adapter-specific. */
export interface ChatDocumentContentPart {
  readonly type: "document";
  readonly source: ChatContentSource;
  readonly metadata: JsonObject | null;
}

/** Embedded encoded data or a referenced resource URL. */
export type ChatContentSource = ChatContentDataSource | ChatContentUrlSource;

/** Encoded inline resource data, with its declared MIME type. */
export interface ChatContentDataSource {
  readonly type: "data";
  readonly value: string;
  readonly mimeType: string;
}

/** Referenced resource; fetching and validation belong to the adapter. */
export interface ChatContentUrlSource {
  readonly type: "url";
  readonly value: string;
  readonly mimeType?: string;
}

/** Canonical model-history messages, independent of UI projection and journal authority. */
export type ChatMessage =
  | ChatUserMessage
  | ChatAssistantMessage
  | ChatSystemMessage
  | ChatDeveloperMessage
  | ChatToolResultMessage;

/** User input with text or multimodal content. */
export interface ChatUserMessage {
  readonly role: "user";
  readonly content: ChatContent;
}

/** Assistant response preserving ordered text, reasoning and tool-call parts. */
export interface ChatAssistantMessage {
  readonly role: "assistant";
  readonly content: readonly ChatMessagePart[];
}

/** System instructions supplied in inference context. */
export interface ChatSystemMessage {
  readonly role: "system";
  readonly content: string;
}

/** Developer instructions; support is adapter-specific. */
export interface ChatDeveloperMessage {
  readonly role: "developer";
  readonly content: string;
}

/** Tool result correlated to the originating call, with explicit error disposition. */
export interface ChatToolResultMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly content: ChatContent;
  readonly isError: boolean;
}

/** An assistant content, reasoning or tool-call part. */
export type ChatMessagePart = ChatContentPart | ChatReasoningPart | ChatToolCallPart;

/** Reasoning metadata retained for provider continuation; not necessarily public text. */
export interface ChatReasoningPart {
  readonly type: "reasoning";
  readonly text: string;
  readonly format: string | null;
  readonly signature: string | null;
  readonly redacted: boolean;
}

/** Model-requested tool invocation. Its identity is not an execution grant. */
export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Json;
  readonly thoughtSignature: string | null;
}

/** An assistant part requesting a tool invocation. */
export interface ChatToolCallPart {
  readonly type: "tool-call";
  readonly toolCall: ChatToolCall;
}

/** Model-facing tool declaration with a JSON parameter schema. */
export type ChatToolDefinition = {
  readonly name: string;
  readonly description: string | null;
  readonly parameters: JsonObject;
};

/** Provider response identity shared by the canonical model and adapter-facing response contracts. */
export interface ModelResponseSource {
  api: string;
  provider: string;
  model: string;
  responseModel: string | null;
}
/** Complete inference context: ordered history and available tool declarations. */
export interface ModelContext {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ChatToolDefinition[];
}

/** Provider-reported cost; null means unavailable rather than zero. */
export interface ModelCost {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly total: number | null;
}

/** Provider-reported accounting. input excludes cacheRead/cacheWrite; output includes
 * reasoning. total is the reported total, not recomputed from overlapping breakdowns.
 * Unreported values remain null; cost may be SDK-calculated rather than invoiced. */
export interface ModelUsage {
  readonly input: number | null;
  readonly output: number | null;
  readonly total: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly cost: ModelCost | null;
  /** Subset of output, never added to total again. Absent/null means unreported. */
  readonly reasoning?: number | null;
  /** Subset of cacheWrite with one-hour retention. */
  readonly cacheWrite1h?: number | null;
}

/** Complete provider result. Hosting validates and accepts it separately from live events. */
export interface ModelResponse {
  readonly message: ChatAssistantMessage;
  readonly source: ModelResponseSource | null;
  readonly usage: ModelUsage | null;
  readonly stopReason: string | null;
  readonly responseId: string | null;
  readonly errorMessage: string | null;
  /** Actual reported effort, distinct from requested effort. */
  readonly reasoning?: {
    readonly requested: ReasoningLevel | null;
    readonly provider: string | null;
  };
}

/** Portable inference input; selected provider, credentials and resource lifetime belong to assembly. */
export interface ModelRequest {
  readonly context: ModelContext;
  readonly options?: ModelGenerationOptions;
}

/** Portable generation controls; adapters validate provider support. */
export type ModelGenerationOptions = {
  readonly toolChoice?: "auto" | "none" | "required";
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly thinking?: ReasoningLevel;
  readonly thinkingBudgets?: Partial<
    Readonly<Record<"minimal" | "low" | "medium" | "high", number>>
  >;
  readonly responseFormat?: {
    readonly type: "json_schema";
    readonly name?: string;
    readonly schema: JsonObject;
  };
};

/** Provisional indexed content events and v1 terminal diagnostics. Stream completion returns ModelResponse. */
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
      readonly toolCall: ChatToolCall;
      readonly partial: ChatAssistantMessage;
    }
  | { readonly type: "done"; readonly reason: string; readonly message: ChatAssistantMessage }
  | {
      readonly type: "error";
      readonly reason: "error" | "aborted";
      readonly error: ChatAssistantMessage;
    };

/** Canonical reasoning effort; adapters reject levels their model explicitly excludes. */
export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Safe model information, with no endpoint headers, credentials or executable driver. */
export interface ModelInfo {
  readonly id: string;
  readonly provider: string;
  readonly api: string;
  readonly name: string;
  readonly input: readonly ("text" | "image" | "audio" | "video" | "document")[];
  readonly output: readonly ("text" | "image" | "audio")[];
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  /** null means unknown; [] means reasoning controls are unavailable. */
  readonly reasoningLevels: readonly ReasoningLevel[] | null;
}

/** Explicit input measurement. An old response's usage is not a count of a new prompt. */
export interface ContextTokenCount {
  readonly tokens: number;
  readonly kind: "measured" | "estimated";
}

/** Per-request budget, not cumulative conversation billing. Negative remaining means over budget. */
export interface ContextBudget {
  readonly input: ContextTokenCount;
  readonly reservedOutput: number;
  readonly contextWindow: number | null;
  readonly remaining: number | null;
  readonly fits: boolean | null;
}

/** Independent image generation/editing operation; completion is authoritative provider output. */
export interface ImageProvider<Y> {
  generate(request: ImageRequest): Operation<ImageResponse, Y>;
}
export interface ImageRequest {
  readonly input: ChatContent;
}
export interface ImageResponse {
  readonly output: readonly (ChatTextContentPart | ChatImageContentPart)[];
  readonly source: ModelResponseSource;
  readonly usage: ModelUsage | null;
  readonly responseId: string | null;
}
