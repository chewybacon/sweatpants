import type { Operation } from "effection";
import type { Json, JsonObject } from "@sweatpants/foundation";
import type { ChatMessage, ChatToolDefinition } from "@sweatpants/chat-contract";
import type {
  AnyToolContract,
  ElicitExchangeCompletion,
  ModelPreferences,
  SamplingToolChoice,
  SampleExchangeCompletion,
} from "@sweatpants/agent-sdk";

export type ToolInvocationId = string;
export type ToolInvocationCommandId = string;
export type ToolInvocationCursor = number;

export interface StartToolInvocation {
  readonly invocationId: ToolInvocationId;
  readonly tool: AnyToolContract;
  readonly input: Json;
}

export type ToolInvocationResume =
  | {
      readonly kind: "sample";
      readonly requestId: string;
      readonly response: SampleExchangeCompletion;
    }
  | {
      readonly kind: "elicit";
      readonly requestId: string;
      readonly response: ElicitExchangeCompletion<unknown>;
    }
  | {
      readonly kind: "cancel";
      readonly reason?: string;
    };

export interface TurnToolInvocation {
  readonly invocationId: ToolInvocationId;
  /** Stable across retries of one durable pull. */
  readonly commandId: ToolInvocationCommandId;
  /** Last accepted event before this crank. */
  readonly cursor: ToolInvocationCursor;
  readonly resume?: ToolInvocationResume;
}

export interface ToolInvocationSampleAsk {
  readonly kind: "sample";
  readonly requestId: string;
  readonly messages: readonly ChatMessage[];
  readonly systemPrompt?: string;
  readonly maxTokens?: number;
  readonly modelPreferences?: ModelPreferences;
  readonly tools?: readonly ChatToolDefinition[];
  readonly toolChoice?: SamplingToolChoice;
  readonly schema?: JsonObject;
}

export interface ToolInvocationElicitAsk {
  readonly kind: "elicit";
  readonly requestId: string;
  readonly key: string;
  readonly message: string;
  readonly schema: JsonObject;
  readonly context?: Json;
  readonly bindingId?: string;
  readonly responseContract?: Json;
  readonly contextContract?: Json;
  readonly ownerInterfaceDigest?: string;
}

export type ToolInvocationAsk = ToolInvocationSampleAsk | ToolInvocationElicitAsk;

export type ToolInvocationTurn =
  | {
      readonly type: "parked";
      readonly cursor: ToolInvocationCursor;
      readonly ask: ToolInvocationAsk;
    }
  | {
      readonly type: "completed";
      readonly result: Json;
    }
  | {
      readonly type: "failed";
      readonly error: ToolInvocationError;
    }
  | {
      readonly type: "cancelled";
      readonly reason?: string;
    };

export interface ToolInvocationError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type ToolInvocationHostErrorCode =
  | "invocation_not_found"
  | "invocation_conflict"
  | "command_conflict"
  | "command_in_progress"
  | "cursor_conflict"
  | "response_mismatch";

export class ToolInvocationHostError extends Error {
  readonly code: ToolInvocationHostErrorCode;

  constructor(code: ToolInvocationHostErrorCode, message: string) {
    super(message);
    this.name = "ToolInvocationHostError";
    this.code = code;
  }
}

/**
 * Pull-based control plane for a live tool invocation.
 *
 * UX event readers are deliberately absent. They read a separate projection.
 * `turn()` is the only operation that answers a parked request and advances
 * the invocation.
 */
export interface ToolInvocationHost {
  start(request: StartToolInvocation): Operation<void>;
  turn(request: TurnToolInvocation): Operation<ToolInvocationTurn>;
  dispose(invocationId: ToolInvocationId): Operation<void>;
}
