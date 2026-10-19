import {
  createQueue,
  resource,
  spawn,
  withResolvers,
  type Operation,
  type WithResolvers,
} from "effection";
import {
  createExecution,
  type ExecutionBoundary,
  type Executor,
  type Json,
} from "@sweatpants/foundation";
import { DurableProgramCancellation } from "@sweatpants/durable-execution";
import { ProgramEffectRuntimeContext } from "./program-effect-runtime.ts";

import type { ProgramRequest as Request, ProgramReply as Reply } from "./program-execution.ts";

type Boundary = ExecutionBoundary<Request, Json>;
type Program = (input: Json) => Operation<Json>;

/** Local generator evaluator. Its scope inherits the attachment's capabilities.
 * Requests contain live closures: this is deliberately not a wire protocol.
 * JavaScript generators have no capture/restore capability; recovery uses replay.
 */
export const EffectionKernel: Executor<Program, Json, Request, Reply, Json> = {
  start(program, input) {
    return resource(function* (provide) {
      const events = createQueue<Boundary, never>();
      let pending: WithResolvers<Reply> | undefined;
      let sequence = 0;
      let disposed = false;

      function* suspend(request: Request): Operation<Reply> {
        if (disposed) {
          throw new Error("execution_closed");
        }
        if (pending) {
          throw new Error("concurrent_kernel_request");
        }
        const reply = withResolvers<Reply>();
        pending = reply;
        events.add({ kind: "suspended", suspensionId: String(++sequence), request });
        try {
          return yield* reply.operation;
        } finally {
          pending = undefined;
        }
      }

      // Installed only inside the execution resource, never on its caller.
      yield* ProgramEffectRuntimeContext.set({
        *perform(boundary) {
          const reply = yield* suspend({ kind: "record", boundary });
          if (reply.kind !== "record") {
            throw new Error("kernel_reply_mismatch");
          }
          return reply.outcome;
        },
        *requestEmission(descriptor) {
          const reply = yield* suspend({ kind: "emission", descriptor });
          if (reply.kind !== "emission") {
            throw new Error("kernel_reply_mismatch");
          }
          return reply.value;
        },
      });
      const task = yield* spawn(function* () {
        try {
          const value = yield* program(input);
          events.add({ kind: "completed", value });
        } catch (error) {
          events.add(
            error instanceof DurableProgramCancellation
              ? {
                  kind: "cancelled",
                  reason: error.reason,
                }
              : { kind: "failed", error },
          );
        }
      });
      function* next(): Operation<Boundary> {
        return (yield* events.next()).value;
      }
      function* dispose(): Operation<void> {
        disposed = true;
        yield* task.halt();
      }
      try {
        const initial = yield* next();
        const state = createExecution({
          initial,
          validateReply(request: Request, reply: Reply) {
            if (request.kind !== reply.kind) {
              throw new Error("kernel_reply_mismatch");
            }
          },
          driver: {
            *resume(_suspensionId, reply) {
              if (!pending) {
                throw new Error("kernel_not_suspended");
              }
              pending.resolve(reply);
              return yield* next();
            },
            *cancel(reason) {
              if (!pending) {
                throw new Error("kernel_not_suspended");
              }
              pending.reject(new DurableProgramCancellation(reason));
              return yield* next();
            },
            dispose,
          },
        });
        yield* provide(state);
      } finally {
        yield* dispose();
      }
    });
  },
};
