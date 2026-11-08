import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { Operation, Outcome } from "@standard-durability/core";
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

/** One completed batch member, correlated by model call identity. */
export interface ChatToolResult {
  readonly toolCallId: string;
  readonly content: ChatContent;
  readonly isError: boolean;
}

/** A domain sampling request, before host-side preparation. */
export interface ChatLoopRequest {
  /** Zero-based round within this invocation; not a mutable middleware counter. */
  readonly round: number;
  readonly history: readonly ChatHistoryMessage[];
  readonly tools: readonly ChatToolDefinition[];
}

/** Accepted sample provenance and complete response supplied by the host exchange. */
export interface ChatLoopSample {
  readonly model: ModelSelection;
  readonly response: ModelResponse;
}

/** Semantic loop progress. Application policy selects which fields may reach clients.
 * Tool/batch start records dispatch intent, not external delivery. Batch-mode tool
 * completions are observed after joining, in model-call order, not execution order. */
export type ChatLoopEvent =
  | {
      readonly type: "assistant";
      readonly round: number;
      readonly message: ChatAssistantMessage & { readonly model: ModelSelection };
    }
  | {
      readonly type: "tool-batch-started";
      readonly round: number;
      readonly calls: readonly ChatToolCall[];
    }
  | { readonly type: "tool-started"; readonly round: number; readonly call: ChatToolCall }
  | {
      readonly type: "tool-completed";
      readonly round: number;
      readonly call: ChatToolCall;
      readonly content: ChatContent;
      readonly isError: boolean;
    };

/** Guest orchestration inputs. Pin catalog and consumption order; sampling policy lives on the Host. */
export type ChatStreamOptions = {
  readonly history: readonly ChatHistoryMessage[];
  /** Yield a domain exchange, not native runtime/API work. The host prepares/counts
   * context, consumes the provider and accepts the response or policy denial with provenance. */
  sample(
    request: ChatLoopRequest,
  ): Operation<Outcome<ChatLoopSample, ChatSamplingError>, CapabilityRequest>;
} & (
  | {
      readonly tools: readonly ChatLoopTool[];
      readonly executeTools?: never;
    }
  | {
      readonly tools: readonly Pick<ChatLoopTool, "definition">[];
      /** Run the entire nonempty validated call set through domain exchanges.
       * Choose sequential or owned-concurrent execution in assembly. Return exactly
       * one result per call ID; return order may differ. No per-tool callbacks run
       * in this mode. Unknown/duplicate/missing IDs reject before publishing any
       * completion or appending tool history. A throw is not an authored result.
       */
      executeTools(
        calls: readonly ChatToolCall[],
      ): Operation<readonly ChatToolResult[], CapabilityRequest>;
    }
);

/** Terminal response and complete logical history, including all correlated tool results. */
export interface ChatLoopResult {
  readonly response: ModelResponse;
  readonly history: readonly ChatHistoryMessage[];
  readonly rounds: number;
}

/** Convenience runner options; runChat drains streamChat through this callback. */
export type ChatLoopOptions = ChatStreamOptions & {
  /** Optional domain callback receiving detached progress data. For recoverable
   * presentation, yield a recorded effect; direct side effects repeat on replay.
   * Failures propagate. Pin callback presence/order as part of the program contract. */
  event?(event: ChatLoopEvent): Operation<void, CapabilityRequest>;
};

/** An expected sampling policy rejection, accepted as data rather than a delivery failure. */
export interface ChatSamplingError {
  readonly code: string;
  readonly message: string;
  /** Retain a completed inference when policy denies its requested continuation. */
  readonly sample?: ChatLoopSample;
}

/** Host model policy. Accepted sampling records retain the selected identity. */
export interface ChatModel<Y> {
  /** Select full model configuration before preparation/provider acquisition. */
  select(request: ChatLoopRequest): Operation<ModelInfo, Y>;
}

/** Host sampling boundary. Stream-producing providers remain underneath this complete-result operation. */
export interface ChatSampling<Y, Sample extends ChatLoopSample = ChatLoopSample> {
  /** Apply policy and return an accepted sample or expected denial. Exceptions remain delivery failures. */
  sample(request: ChatLoopRequest): Operation<Outcome<Sample, ChatSamplingError>, Y>;
}

/** Bind the model facade and complete inference driver once at the Host assembly boundary. */
export interface ChatSamplingDriver<Y, Sample extends ChatLoopSample = ChatLoopSample> {
  readonly model: ChatModel<Y>;
  /** Prepare/count context and drain a provider stream using this selected configuration.
   * Return matching model provenance; acquisition and cleanup remain driver-owned. */
  sample(model: ModelInfo, request: ChatLoopRequest): Operation<Sample, Y>;
}
