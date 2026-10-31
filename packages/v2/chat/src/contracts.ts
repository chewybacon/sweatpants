import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { Operation } from "@standard-durability/core";
import type {
  ChatContent,
  ModelResponse,
  ChatToolCall,
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

/** One catalog entry and its already-granted Guest operation. Description is model
 * data; importing a declaration does not install host authority. */
export interface ChatLoopTool {
  readonly definition: ChatToolDefinition;
  /** Invoke through domain capabilities. Format authored success/failure as model
   * content explicitly; thrown delivery failures must propagate without conversion. */
  call(
    call: ChatToolCall,
  ): Operation<{ readonly content: ChatContent; readonly isError: boolean }, CapabilityRequest>;
}

/** A domain sampling request, before host-side preparation. */
export interface ChatLoopRequest {
  readonly model: ModelSelection;
  readonly history: readonly ChatHistoryMessage[];
  readonly tools: readonly ChatToolDefinition[];
}

/** Accepted sample provenance and complete response supplied by the host exchange. */
export interface ChatLoopSample {
  readonly model: ModelSelection;
  readonly response: ModelResponse;
}

/** Deterministic Guest assembly. Pin these inputs/policies across recovery. */
export interface ChatLoopOptions {
  readonly history: readonly ChatHistoryMessage[];
  readonly tools: readonly ChatLoopTool[];
  /** Positive finite model-round budget. Calls requiring a round beyond it fail
   * before executing that batch's tools. */
  readonly maxRounds: number;
  /** Zero-based round selection; must reproduce the same identity on replay. */
  model(round: number): ModelSelection;
  /** Yield a domain exchange, not native runtime/API work. The host prepares/counts
   * context, consumes the provider and accepts the response with selected provenance. */
  sample(request: ChatLoopRequest): Operation<ChatLoopSample, CapabilityRequest>;
}

/** Terminal response and complete logical history, including all correlated tool results. */
export interface ChatLoopResult {
  readonly response: ModelResponse;
  readonly history: readonly ChatHistoryMessage[];
  readonly rounds: number;
}
