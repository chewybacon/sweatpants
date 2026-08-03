import type { ElicitExchangeCompletion } from "@sweatpants/agent-sdk";
import type { Json, JsonObject } from "@sweatpants/foundation";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import type { ToolCall } from "@sweatpants/model-provider";
import { definePort } from "@sweatpants/foundation/port";
import type { Operation, Stream } from "effection";

/** Portable, execution-neutral projection of an authored tool definition. */
export interface PortableToolDefinition {
  name: string;
  description: string;
  parameters: JsonObject;
  metadata?: Record<string, unknown>;
}

export interface ToolCapabilities {
  inline?: boolean;
  client?: boolean;
  elicits?: boolean;
  samples?: boolean;
}

export interface ToolInventoryEntry {
  definition: PortableToolDefinition;
  capabilities?: ToolCapabilities;
  metadata?: Record<string, unknown>;
  interfaceDigest?: string;
  elicits?: Readonly<
    Record<
      string,
      {
        responseContract: PortableSchemaDescriptor;
        contextContract?: PortableSchemaDescriptor;
      }
    >
  >;
}

export interface ToolExecutionRef {
  runtimeId: string;
  executionId: string;
  callId: string;
  toolName: string;
  sessionId?: string;
}

export interface ToolExecuteRequest {
  entry: ToolInventoryEntry;
  call: ToolCall;
  request?: unknown;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface ToolContinuationInput {
  type: "elicit_response";
  elicitId?: string;
  completion: ElicitExchangeCompletion<unknown>;
}

export interface ToolResumeRequest {
  ref: ToolExecutionRef;
  input: ToolContinuationInput;
  request?: unknown;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface ToolExecutionError {
  code?: string;
  message: string;
  cause?: unknown;
}

export interface ElicitToolRequest {
  elicitId: string;
  key: string;
  message: string;
  schema: JsonObject;
  context?: Json;
  bindingId?: string;
  responseContract?: PortableSchemaDescriptor;
  contextContract?: PortableSchemaDescriptor;
  placement?: { nodeId: string; parentNodeId: string | null; sequence: number };
  ownerInterfaceDigest?: string;
  clientMetadata?: Json;
}

export type ToolExecutionEvent =
  | { type: "progress"; lsn?: number; timestamp?: number; message?: string; progress?: number }
  | { type: "log"; lsn?: number; timestamp?: number; level?: string; message: string }
  | {
      type: "elicit_request";
      lsn?: number;
      timestamp?: number;
      elicitId: string;
      key: string;
      message: string;
      schema: JsonObject;
      context?: Json;
      bindingId?: string;
      responseContract?: PortableSchemaDescriptor;
      contextContract?: PortableSchemaDescriptor;
      placement?: { nodeId: string; parentNodeId: string | null; sequence: number };
      ownerInterfaceDigest?: string;
      clientMetadata?: Json;
    }
  | {
      type: "sample_request";
      lsn?: number;
      timestamp?: number;
      sampleId: string;
      messages?: unknown[];
      systemPrompt?: string;
      maxTokens?: number;
      modelPreferences?: unknown;
      tools?: unknown[];
      toolChoice?: unknown;
      schema?: JsonObject;
    }
  | { type: "sample_response_queued"; lsn?: number; timestamp?: number }
  | { type: "result"; lsn?: number; timestamp?: number; result: unknown }
  | {
      type: "error";
      lsn?: number;
      timestamp?: number;
      message: string;
      code?: string;
      name?: string;
      stack?: string;
    }
  | { type: "cancelled"; lsn?: number; timestamp?: number; reason?: string };

export type ToolExecution =
  | { kind: "completed"; ref: ToolExecutionRef; result: unknown }
  | { kind: "failed"; ref: ToolExecutionRef; error: ToolExecutionError }
  | { kind: "awaiting_elicit"; ref: ToolExecutionRef; request: ElicitToolRequest }
  | { kind: "running"; ref: ToolExecutionRef; events: Stream<ToolExecutionEvent, void> };

export type PendingToolRequest = { type: "elicit" } & ElicitToolRequest;

export interface PendingToolExecution {
  ref: ToolExecutionRef;
  status: "awaiting_elicit" | "running" | "stale";
  request?: PendingToolRequest;
  lastEventLSN?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ToolContinuationPayload {
  type: "elicit_response";
  callId: string;
  toolName: string;
  ref?: ToolExecutionRef;
  elicitId: string;
  completion: ElicitExchangeCompletion<unknown>;
}

export interface ToolRuntime {
  runtimeId(): Operation<string>;
  execute(request: ToolExecuteRequest): Operation<ToolExecution>;
  resume(request: ToolResumeRequest): Operation<ToolExecution>;
  abort(ref: ToolExecutionRef, reason?: string): Operation<void>;
}

export interface ToolExecutionContext {
  runtimeId: string;
  request?: unknown;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface ToolExecutionStrategy {
  readonly id: string;
  readonly toolNames?: readonly string[];
  canExecute(
    entry: ToolInventoryEntry,
    call: ToolCall,
    ctx: ToolExecutionContext,
  ): boolean | Operation<boolean>;
  execute(
    entry: ToolInventoryEntry,
    call: ToolCall,
    ctx: ToolExecutionContext,
  ): Operation<ToolExecution>;
  resume?(
    ref: ToolExecutionRef,
    input: ToolContinuationInput,
    ctx: ToolExecutionContext,
  ): Operation<ToolExecution>;
  abort?(
    ref: ToolExecutionRef,
    reason: string | undefined,
    ctx: ToolExecutionContext,
  ): Operation<void>;
}

export class ToolRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolRuntimeError";
  }
}

function unavailable(): never {
  throw new ToolRuntimeError(
    "TOOL_RUNTIME_NOT_CONFIGURED",
    "Tool runtime not configured. Install a ToolRuntime in scope.",
  );
}

export const ToolRuntimePort = definePort<ToolRuntime>("tool-runtime", {
  *runtimeId(): Operation<string> {
    return unavailable();
  },
  *execute(_request: ToolExecuteRequest): Operation<ToolExecution> {
    return unavailable();
  },
  *resume(_request: ToolResumeRequest): Operation<ToolExecution> {
    return unavailable();
  },
  *abort(_ref: ToolExecutionRef, _reason?: string): Operation<void> {
    return unavailable();
  },
});

export const ToolRuntimeApi = ToolRuntimePort.api;

function* assertOwnedBy(runtime: ToolRuntime, ref: ToolExecutionRef): Operation<void> {
  const id = yield* runtime.runtimeId();
  if (ref.runtimeId !== id) {
    throw new ToolRuntimeError(
      "WRONG_TOOL_RUNTIME",
      `Wrong tool runtime: expected ${id}, received ${ref.runtimeId}`,
    );
  }
}

export function installToolRuntime(runtime: ToolRuntime): Operation<void> {
  return ToolRuntimePort.installDriver({
    runtimeId: () => runtime.runtimeId(),
    execute: (request) => runtime.execute(request),
    *resume(request: ToolResumeRequest): Operation<ToolExecution> {
      yield* assertOwnedBy(runtime, request.ref);
      return yield* runtime.resume(request);
    },
    *abort(ref: ToolExecutionRef, reason?: string): Operation<void> {
      yield* assertOwnedBy(runtime, ref);
      yield* runtime.abort(ref, reason);
    },
  });
}
