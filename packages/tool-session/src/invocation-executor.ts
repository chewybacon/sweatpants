import type { Operation } from "effection";
import {
  createExecution,
  composeOperation,
  type OperationOptions,
  definePort,
  type ExecutionBoundary,
  type Executor,
  type Json,
} from "@sweatpants/foundation";
import type { ToolInvocationResume } from "./invocation-resume.ts";
import type {
  StartToolInvocation,
  ToolInvocationAsk,
  ToolInvocationError,
  ToolInvocationHost,
  ToolInvocationTurn,
  TurnToolInvocation,
} from "./invocation.ts";

type Reply = Exclude<ToolInvocationResume, { kind: "cancel" }>;
type Program = Omit<StartToolInvocation, "input">;
export type ToolInvocationRequest = ToolInvocationAsk & { readonly cursor: number };
export type ToolInvocationBoundary = ExecutionBoundary<
  ToolInvocationRequest,
  Json,
  ToolInvocationError
>;

/** Interpret a host turn without replacing its command identity or replay cursor. */
export function toolInvocationBoundary(turn: ToolInvocationTurn): ToolInvocationBoundary {
  switch (turn.type) {
    case "parked":
      return {
        kind: "suspended",
        suspensionId: `${turn.cursor}:${turn.ask.requestId}`,
        request: { ...turn.ask, cursor: turn.cursor },
      };
    case "completed":
      return { kind: "completed", value: turn.result };
    case "failed":
      return { kind: "failed", error: turn.error };
    case "cancelled":
      return {
        kind: "cancelled",
        reason: turn.reason,
      };
  }
}

export function* advanceToolInvocation(
  host: ToolInvocationHost,
  command: TurnToolInvocation,
): Operation<ToolInvocationBoundary> {
  return toolInvocationBoundary(yield* host.turn(command));
}

export type ToolInvocationExecutorOptions = OperationOptions<
  ToolInvocationHost,
  Executor<Program, Json, ToolInvocationRequest, Reply, Json, ToolInvocationError>
>;

/** Live-only adapter. Reopening a session is not restoring a generator. */
export function createToolInvocationExecutor({
  driver: host,
  middleware = [],
}: ToolInvocationExecutorOptions): Executor<
  Program,
  Json,
  ToolInvocationRequest,
  Reply,
  Json,
  ToolInvocationError
> {
  const executor: Executor<Program, Json, ToolInvocationRequest, Reply, Json, ToolInvocationError> =
    {
      *start(program, input) {
        yield* host.start({ ...program, input });
        // Each adapter lifetime owns a fresh command namespace; IDs are not replay receipts.
        const commands = crypto.randomUUID();
        let sequence = 0;
        let cursor = 0;
        function* advance(resume?: ToolInvocationResume) {
          const next = yield* advanceToolInvocation(host, {
            invocationId: program.invocationId,
            commandId: `${commands}:${++sequence}`,
            cursor,
            resume,
          });
          if (next.kind === "suspended") {
            cursor = next.request.cursor;
          }
          return next;
        }
        let started = false;
        try {
          const boundary = yield* advance();
          const executionState = createExecution({
            initial: boundary,
            validateReply(request, reply: Reply) {
              if (request.kind !== reply.kind || request.requestId !== reply.requestId) {
                throw new Error("execution_suspension_mismatch");
              }
            },
            driver: {
              resume: (_suspensionId, reply) => advance(reply),
              cancel: (reason) => advance({ kind: "cancel", reason }),
              dispose: () => host.dispose(program.invocationId),
            },
          });
          started = true;
          return executionState;
        } finally {
          // Until startup returns a handle, it owns cleanup. Scope cancellation
          // also passes through finally.
          if (!started) {
            yield* host.dispose(program.invocationId);
          }
        }
      },
    };
  return {
    start: composeOperation(
      (program, input) => executor.start(program, input),
      middleware.map((m) => m.start),
    ),
  };
}

/** Context resolution returns the API facade, keeping startup middleware in the path. */
export const ToolInvocationExecutor = definePort<
  Executor<Program, Json, ToolInvocationRequest, Reply, Json, ToolInvocationError>
>("tool-invocation-executor", {
  *start() {
    throw new Error("No tool invocation executor is installed in this scope");
  },
});
