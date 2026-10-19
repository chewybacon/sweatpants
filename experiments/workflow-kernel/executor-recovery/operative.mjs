// Isolated composition experiment. The caller supplies a trusted recovery plan;
// this is not a network authorization or journal-admission implementation.
import { resource, createQueue, spawn, withResolvers } from "effection";
import { createExecution } from "../../../packages/foundation/src/execution.ts";
import {
  ProgramPeer,
  ProgramRecovery,
  ProgramDriverRegistryContext,
  installProgramCheckpointAcceleration,
  recoverProgram,
} from "../../../packages/durable-execution/dist/index.js";
import {
  Executor,
  createOperative,
} from "../../../packages/tool-runtime-local/src/styles/__tests__/fixtures/executor-transport.ts";
import { createHootDriver } from "../hoot-composition/fixture-driver.mjs";

function boundary(step) {
  if (step.type === "completed") {
    return { kind: "completed", value: step.value };
  }
  if (step.type === "failed") {
    return { kind: "failed", error: step.error };
  }
  return { kind: "suspended", suspensionId: String(step.actionIndex), request: step };
}

export function connectHoot() {
  return resource(function* (provide) {
    const events = [];
    const driver = createHootDriver((event) => events.push(event));
    yield* ProgramDriverRegistryContext.set(new Map([["hoot-composition", driver]]));
    yield* installProgramCheckpointAcceleration({
      driverKind: "hoot-composition",
      format: driver.capabilities.continuation.format,
    });
    let attachment;

    function activate(step) {
      return createExecution({
        initial: boundary(step),
        driver: {
          *resume(suspensionId, reply) {
            return boundary(
              yield* ProgramPeer.operations.step(attachment, {
                type: "resume",
                actionIndex: Number(suspensionId),
                ...reply,
              }),
            );
          },
          *cancel(reason) {
            return boundary(
              yield* ProgramPeer.operations.step(attachment, {
                type: "cancel",
                reason,
              }),
            );
          },
          *dispose() {
            yield* ProgramPeer.operations.shutdown(attachment, "parked");
            attachment = undefined;
          },
        },
      });
    }

    yield* Executor.installDriver({
      *start(program, input) {
        attachment = yield* ProgramPeer.operations.attach({ ...program, input });
        return activate(yield* ProgramPeer.operations.step(attachment, { type: "start", input }));
      },
    });
    // Start is still the common executor operation. Recovery is scoped
    // composition over it; no restore/capture methods are added to Executor.
    yield* Executor.api.around({
      *start([program, input], next) {
        if (program.replayOnly) {
          yield* ProgramRecovery.around({
            *checkpoint() {
              return { kind: "replay" };
            },
            *recover([request], recover) {
              return yield* recover({ ...request, checkpoint: { kind: "replay" } });
            },
          });
        }
        if (!program.recovery) {
          return yield* next(program.attach, input);
        }
        const restored = yield* recoverProgram(program.recovery);
        attachment = restored.attachment;
        return activate(restored.frontier);
      },
    });
    yield* ProgramRecovery.around({
      *recover(args, next) {
        events.push("recover:before");
        const result = yield* next(...args);
        events.push("recover:after");
        return result;
      },
    });
    const operative = createOperative(yield* Executor.use());
    // A connection is a message boundary even in-process. Dispatch stays in
    // this operative scope; returning a facade does not capture its context.
    const inbox = createQueue();
    let closed = false;
    const pump = yield* spawn(function* () {
      while (true) {
        const { value: message } = yield* inbox.next();
        try {
          if (message.close) {
            yield* operative.close();
            message.result.resolve({ value: undefined });
            continue;
          }
          const response = yield* operative.exchange(message.command);
          if (response.kind === "boundary") {
            // Metadata belongs to the protocol envelope, not the
            // authored request or the common execution boundary.
            const checkpoint = yield* ProgramRecovery.operations.checkpoint(attachment);
            message.result.resolve({
              value: { ...response, checkpoint, events: [...events] },
            });
          } else {
            message.result.resolve({ value: response });
          }
        } catch (error) {
          message.result.resolve({ error });
        }
      }
    });
    function* dispatch(message) {
      const result = withResolvers();
      inbox.add({ ...message, result });
      const response = yield* result.operation;
      if ("error" in response) {
        throw response.error;
      }
      return response.value;
    }
    try {
      yield* provide({
        *exchange(command) {
          if (closed) {
            throw Error("connection_closed");
          }
          return yield* dispatch({ command });
        },
        *close() {
          if (closed) {
            return;
          }
          closed = true;
          yield* dispatch({ close: true });
        },
      });
    } finally {
      closed = true;
      yield* pump.halt();
      yield* operative.close();
      // Also release an attachment if start failed before returning a handle.
      if (attachment) {
        yield* ProgramPeer.operations.shutdown(attachment, "scope_exit");
      }
    }
  });
}

export function localHootTransport() {
  return {
    *connect() {
      const connection = yield* connectHoot();
      return {
        *exchange(command) {
          return structuredClone(yield* connection.exchange(structuredClone(command)));
        },
        close: () => connection.close(),
      };
    },
  };
}
