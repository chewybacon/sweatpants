import { type Operation, type Stream } from "effection";
import { definePort } from "@sweatpants/foundation/port";
import type { ToolCall } from "./types.ts";
import type { ToolInventoryEntry } from "./tool-inventory.ts";

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
  result: unknown;
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
  schema: Record<string, unknown>;
  context?: Record<string, unknown>;
}

/**
 * Wire-level tool execution event.
 *
 * Widened form of the canonical session event union
 * (`mcp-tools/session/types.ts` ToolSessionEvent): `lsn`/`timestamp` are
 * optional because transports may re-sequence. The strict session events are
 * structurally assignable to this union — keep the field sets in sync so the
 * runtime→session seam needs no casts.
 */
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
      schema: Record<string, unknown>;
      context?: Record<string, unknown>;
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
      schema?: Record<string, unknown>;
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

export type ToolContinuationPayload = {
  type: "elicit_response";
  callId: string;
  toolName: string;
  ref?: ToolExecutionRef;
  elicitId: string;
  result: unknown;
};

export interface ToolRuntime {
  /**
   * Runtime identity, exposed as an operation because port members are
   * dispatched, not read: a value member would be evaluated eagerly and could
   * not fail closed when no runtime is installed.
   */
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
  /** Optional declared ownership set used for duplicate-route detection. */
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

export interface StrategyToolRuntimeOptions {
  id?: string;
  strategies: ToolExecutionStrategy[];
}

function isOperation<T>(value: boolean | Operation<T>): value is Operation<T> {
  return typeof value !== "boolean";
}

function assertDisjointStrategyToolNames(strategies: ToolExecutionStrategy[]): void {
  const owners = new Map<string, string>();

  for (const strategy of strategies) {
    const seenInStrategy = new Set<string>();
    for (const name of strategy.toolNames ?? []) {
      if (seenInStrategy.has(name)) {
        throw new ToolRuntimeError(
          "DUPLICATE_TOOL_STRATEGY",
          `Strategy "${strategy.id}" declares duplicate tool name: ${name}`,
        );
      }
      seenInStrategy.add(name);

      const owner = owners.get(name);
      if (owner) {
        throw new ToolRuntimeError(
          "DUPLICATE_TOOL_STRATEGY",
          `Tool "${name}" is claimed by multiple execution strategies: ${owner}, ${strategy.id}`,
        );
      }
      owners.set(name, strategy.id);
    }
  }
}

export function createToolExecutionRef(input: {
  runtimeId: string;
  callId: string;
  toolName: string;
  executionId?: string;
  sessionId?: string;
}): ToolExecutionRef {
  return {
    runtimeId: input.runtimeId,
    executionId: input.executionId ?? input.sessionId ?? input.callId,
    callId: input.callId,
    toolName: input.toolName,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}

export function createStrategyToolRuntime(options: StrategyToolRuntimeOptions): ToolRuntime {
  const runtimeId = options.id ?? "tool-runtime";
  const strategies = [...options.strategies];

  assertDisjointStrategyToolNames(strategies);

  return {
    *runtimeId(): Operation<string> {
      return runtimeId;
    },

    *execute(request: ToolExecuteRequest): Operation<ToolExecution> {
      const ctx: ToolExecutionContext = {
        runtimeId,
        ...(request.request !== undefined ? { request: request.request } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {}),
      };

      for (const strategy of strategies) {
        const accepted = strategy.canExecute(request.entry, request.call, ctx);
        const canExecute = isOperation(accepted) ? yield* accepted : accepted;
        if (canExecute) {
          return yield* strategy.execute(request.entry, request.call, ctx);
        }
      }

      throw new ToolRuntimeError(
        "NO_MATCHING_TOOL_STRATEGY",
        `No tool execution strategy can execute tool: ${request.call.function.name}`,
      );
    },

    *resume(request: ToolResumeRequest): Operation<ToolExecution> {
      for (const strategy of strategies) {
        if (!strategy.resume) {
          continue;
        }
        try {
          return yield* strategy.resume(request.ref, request.input, {
            runtimeId,
            ...(request.request !== undefined ? { request: request.request } : {}),
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.metadata ? { metadata: request.metadata } : {}),
          });
        } catch (error) {
          if (error instanceof ToolRuntimeError && error.code === "EXECUTION_NOT_FOUND") {
            continue;
          }
          throw error;
        }
      }
      throw new ToolRuntimeError(
        "EXECUTION_NOT_FOUND",
        `No strategy can resume execution: ${request.ref.executionId}`,
      );
    },

    *abort(ref: ToolExecutionRef, reason?: string): Operation<void> {
      for (const strategy of strategies) {
        if (!strategy.abort) {
          continue;
        }
        try {
          yield* strategy.abort(ref, reason, { runtimeId });
          return;
        } catch (error) {
          if (error instanceof ToolRuntimeError && error.code === "EXECUTION_NOT_FOUND") {
            continue;
          }
          throw error;
        }
      }
      throw new ToolRuntimeError(
        "EXECUTION_NOT_FOUND",
        `No strategy can abort execution: ${ref.executionId}`,
      );
    },
  };
}

/**
 * Tool execution as a port.
 *
 * This seam is optional: a Host may run purely through the program runtime with
 * no tool runtime installed, so callers probe `isInstalled()` rather than being
 * handed the driver.
 */
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

/**
 * Installs one tool runtime adapter for the calling scope.
 *
 * Reference ownership is enforced here rather than inside each adapter, so the
 * invariant holds for every driver and cannot be skipped by a custom runtime.
 * It is composed at install time, not as middleware, because it is mandatory.
 */
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
