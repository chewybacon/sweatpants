import type { Operation } from "effection";
import { definePort } from "@sweatpants/foundation";
import type { Json, JsonObject } from "@sweatpants/foundation";
import type { ChatMessage, ChatToolDefinition } from "@sweatpants/chat-contract";
import type { ToolInvocationEventReader, ToolInvocationEventSource } from "./contract.ts";
import type { ToolSessionModelSelection } from "./model-selection.ts";
import type { ToolInvocationResume } from "./invocation-resume.ts";
export type { ToolInvocationResume } from "./invocation-resume.ts";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import type { AnyToolContract, ModelPreferences, SamplingToolChoice } from "@sweatpants/agent-sdk";

export type ToolInvocationId = string;
export type ToolInvocationCommandId = string;
export type ToolInvocationCursor = number;

export interface StartToolInvocation {
  readonly invocationId: ToolInvocationId;
  readonly tool: AnyToolContract;
  readonly input: Json;
  readonly model?: ToolSessionModelSelection;
}

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
  readonly responseContract?: PortableSchemaDescriptor;
  readonly contextContract?: PortableSchemaDescriptor;
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
export interface ToolInvocationResource {
  readonly id: ToolInvocationId;
  readonly toolName: string;
  readonly projection: ToolInvocationEventReader<Json>;
  resume(resume: ToolInvocationResume): Operation<void>;
  dispose(): Operation<void>;
}

/** Runtime-owned factory. Its storage and placement details stay private. */
export interface ToolInvocationResourceFactory {
  create(request: StartToolInvocation): Operation<ToolInvocationResource>;
  open(invocationId: ToolInvocationId): Operation<ToolInvocationResource | null>;
}

export interface ToolInvocationHost {
  start(request: StartToolInvocation): Operation<void>;
  turn(request: TurnToolInvocation): Operation<ToolInvocationTurn>;
  dispose(invocationId: ToolInvocationId): Operation<void>;
}

export class ToolInvocationHostUnavailable extends Error {
  readonly code = "tool_invocation_host_unavailable";

  constructor() {
    super("No tool invocation host is installed in this scope");
    this.name = "ToolInvocationHostUnavailable";
  }
}

/** Scoped invocation-control capability. Composition installs its driver once. */
export const ToolInvocationHostPort = definePort<ToolInvocationHost>("tool-invocation-host", {
  *start(): Operation<void> {
    throw new ToolInvocationHostUnavailable();
  },
  *turn(): Operation<ToolInvocationTurn> {
    throw new ToolInvocationHostUnavailable();
  },
  *dispose(): Operation<void> {
    throw new ToolInvocationHostUnavailable();
  },
});

export class ToolInvocationEventSourceUnavailable extends Error {
  readonly code = "tool_invocation_event_source_unavailable";

  constructor() {
    super("No tool invocation event source is installed in this scope");
    this.name = "ToolInvocationEventSourceUnavailable";
  }
}

export const ToolInvocationEventSourcePort = definePort<ToolInvocationEventSource>(
  "tool-invocation-events",
  {
    *open(): Operation<ToolInvocationEventReader | null> {
      throw new ToolInvocationEventSourceUnavailable();
    },
  },
);
