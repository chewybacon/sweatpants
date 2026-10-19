/** Isolated composition spike: one live execution per connection, no journal or retries. */
import { resource, createQueue, spawn, suspend, type Operation } from "effection";
import { useWorker, type WorkerResource } from "@effectionx/worker";
import {
  createExecution,
  definePort,
  type Executor as ExecutorContract,
  type Execution,
  type ExecutionBoundary,
  type ExecutionCommand,
  type Json,
} from "@sweatpants/foundation";

export type Boundary = ExecutionBoundary<Json, Json, Json>;
export type Kernel = ExecutorContract<Json, Json, Json, Json, Json, Json>;
export type Command =
  | { kind: "start"; program: Json; input: Json }
  | ExecutionCommand<Json>
  | { kind: "dispose" };
export type Response =
  | { kind: "boundary"; boundary: Boundary }
  | { kind: "disposed" }
  | { kind: "rejected"; message: string };

export interface Connection {
  exchange(command: Command): Operation<Response>;
  close(): Operation<void>;
}
export interface Transport {
  connect(): Operation<Connection>;
}

export const Executor = definePort<Kernel>("executor-transport-spike", {
  *start() {
    throw new Error("No executor installed");
  },
});

/** Operative-side dispatcher; the kernel and live handles never cross the connection. */
export function createOperative(kernel: Kernel): Connection {
  let execution: Execution<Json, Json, Json, Json> | undefined;
  let started = false;
  let closed = false;
  let busy = false;
  return {
    *exchange(command) {
      if (closed) {
        throw new Error("connection_closed");
      }
      if (busy) {
        throw new Error("execution_command_in_progress");
      }
      busy = true;
      try {
        if (command.kind === "start") {
          if (started) {
            throw new Error("execution_already_started");
          }
          started = true;
          const executionState = yield* kernel.start(command.program, command.input);
          execution = executionState.execution;
          return { kind: "boundary", boundary: executionState.boundary };
        }
        if (!execution) {
          throw new Error("execution_not_started");
        }
        if (command.kind === "dispose") {
          yield* execution.dispose();
          execution = undefined;
          closed = true;
          return { kind: "disposed" };
        }
        const boundary =
          command.kind === "resume"
            ? yield* execution.resume(command.suspensionId, command.reply)
            : yield* execution.cancel(command.reason);
        return { kind: "boundary", boundary };
      } finally {
        busy = false;
      }
    },
    *close() {
      if (closed) {
        return;
      }
      closed = true;
      if (execution) {
        yield* execution.dispose();
      }
    },
  };
}

export function createLocalTransport(createKernel: () => Kernel): Transport {
  return {
    connect() {
      return resource<Connection>(function* (provide) {
        const operative = createOperative(createKernel());
        try {
          yield* provide({
            *exchange(command) {
              return structuredClone(yield* operative.exchange(structuredClone(command)));
            },
            close: () => operative.close(),
          });
        } finally {
          yield* operative.close();
        }
      });
    },
  };
}

export function createWorkerTransport(workerUrl: URL): Transport {
  return {
    connect() {
      return resource<Connection>(function* (provide) {
        const ready = createQueue<WorkerResource<Command, Response, void>, never>();
        const task = yield* spawn(function* () {
          const worker = yield* useWorker<Command, Response, void, undefined>(workerUrl, {
            type: "module",
            data: undefined,
          });
          ready.add(worker);
          yield* suspend();
        });
        const { value: worker } = yield* ready.next();
        let closed = false;
        function* close(): Operation<void> {
          if (closed) {
            return;
          }
          closed = true;
          yield* task.halt();
        }
        try {
          yield* provide({
            *exchange(command) {
              if (closed) {
                throw new Error("connection_closed");
              }
              return yield* worker.send(command);
            },
            close,
          });
        } finally {
          yield* close();
        }
      });
    },
  };
}

/** Principal-side implementation is identical for local and worker placement. */
export function createExecutor(transport: Transport): Kernel {
  return {
    *start(program, input) {
      const connection = yield* transport.connect();
      function* boundary(command: Command): Operation<Boundary> {
        const response = yield* connection.exchange(command);
        if (response.kind === "rejected") {
          throw new Error(response.message);
        }
        if (response.kind !== "boundary") {
          throw new Error("Expected execution boundary");
        }
        return response.boundary;
      }
      try {
        const initial = yield* boundary({ kind: "start", program, input });
        return createExecution(initial, {
          turn: boundary,
          *dispose() {
            try {
              const response = yield* connection.exchange({ kind: "dispose" });
              if (response.kind === "rejected") {
                throw new Error(response.message);
              }
              if (response.kind !== "disposed") {
                throw new Error("Expected disposal acknowledgement");
              }
            } finally {
              yield* connection.close();
            }
          },
        });
      } catch (error) {
        yield* connection.close();
        throw error;
      }
    },
  };
}
