import type { Operation } from "effection";
import {
  ToolRuntimeError,
  type ToolExecution,
  type ToolExecutionContext,
  type ToolExecutionRef,
  type ToolExecuteRequest,
  type ToolExecutionStrategy,
  type ToolResumeRequest,
  type ToolRuntime,
} from "@sweatpants/chat-core";
export {
  ToolRuntimeApi,
  ToolRuntimeError,
  ToolRuntimePort,
  installToolRuntime,
} from "@sweatpants/chat-core";
export type {
  ElicitToolRequest,
  PendingToolExecution,
  PendingToolRequest,
  ToolContinuationInput,
  ToolContinuationPayload,
  ToolExecuteRequest,
  ToolExecution,
  ToolExecutionContext,
  ToolExecutionError,
  ToolExecutionEvent,
  ToolExecutionRef,
  ToolExecutionStrategy,
  ToolResumeRequest,
  ToolRuntime,
} from "@sweatpants/chat-core";

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
