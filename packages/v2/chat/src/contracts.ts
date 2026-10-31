import type { Operation } from "@standard-durability/core";
import type {
  ChatAssistantMessage,
  ChatMessage,
  ChatToolDefinition,
  ModelGenerationOptions,
  ModelInfo,
  ModelRequest,
} from "@sweatpan.ts/providers";

/** Explicit provider/model identity. Host resolution must pin its configuration for durable use. */
export interface ModelSelection {
  readonly provider: string;
  readonly api: string;
  readonly id: string;
}

/** Accepted conversation history with provenance for every assistant message. */
export type ChatHistoryMessage =
  | Exclude<ChatMessage, ChatAssistantMessage>
  | (ChatAssistantMessage & { readonly model: ModelSelection });

/** Input to context assembly. This does not mutate or compact accepted history. */
export interface ChatInferenceOptions {
  readonly model: ModelInfo;
  readonly history: readonly ChatHistoryMessage[];
  readonly tools: readonly ChatToolDefinition[];
  readonly options?: ModelGenerationOptions;
  /** Default reject. Explicitly omit foreign reasoning and clear foreign tool thought signatures. */
  readonly foreignReasoning?: "reject" | "omit";
}

/** Journal this complete value as the model effect input, before provider dispatch. */
export interface ChatInference {
  readonly model: ModelSelection;
  readonly request: ModelRequest;
}

/** Detached, complete prefix to summarize. Journal this input with its summary result.
 * The exact prefix anchors application to the same conversation view, not merely an offset. */
export interface ChatCompactionRequest {
  readonly prefix: readonly ChatHistoryMessage[];
}

/** Scoped context-preparation operations, interpreted through ordinary createApi composition. */
export interface ChatContext<Y> {
  /** Build the next model request in the caller's scope. Middleware may transform
   * history or replace preparation. No provider dispatch or persistence is implied. */
  prepare(input: ChatInferenceOptions): Operation<ChatInference, Y>;
}
