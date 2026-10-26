import { Worker } from "node:worker_threads";
import { call, ensure, type Operation } from "effection";
import type { Guest, Outcome, Turn } from "@sweatpants/foundation/computation";
import type { GuestCommand, GuestResponse } from "./guest-protocol.ts";

type NativeYield = Operation<unknown> extends Iterable<infer Y> ? Y : never;
export interface WorkerGuestOptions<Input> {
  workerUrl: string | URL;
  input: Input;
  execArgv?: string[];
}

/** A worker is a placement of a Guest, never an autonomous request producer. */
export function* createWorkerGuest<T, Request, Value, Input>(
  options: WorkerGuestOptions<Input>,
): Operation<Guest<T, Request, NativeYield, Value>> {
  const generation = crypto.randomUUID();
  const worker = new Worker(options.workerUrl, {
    workerData: { generation, input: options.input },
    execArgv: options.execArgv,
  });
  let sequence = 0;
  let state: "new" | "advancing" | "suspended" | "completed" | "closed" = "new";
  let failure: Error | undefined;
  let closing: Promise<void> | undefined;
  const pending = new Map<
    number,
    { resolve(value: GuestResponse<T, Request>): void; reject(error: Error): void }
  >();
  function lost(error: Error) {
    failure ??= error;
    for (const waiter of pending.values()) {
      waiter.reject(failure);
    }
    pending.clear();
  }
  worker.on("error", lost);
  worker.on("exit", (code) => {
    lost(new Error(`Worker exited before the guest exchange completed (code ${code})`));
  });
  worker.on("message", (response: GuestResponse<T, Request>) => {
    if (response.generation !== generation || !pending.has(response.sequence)) {
      lost(new Error("Worker response correlation mismatch"));
      return;
    }
    const waiter = pending.get(response.sequence)!;
    pending.delete(response.sequence);
    waiter.resolve(response);
  });
  function send(
    command: Omit<GuestCommand<Value>, "generation" | "sequence"> & {
      outcome?: Outcome<Value, unknown>;
    },
  ) {
    const id = sequence++;
    return new Promise<GuestResponse<T, Request>>((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      pending.set(id, { resolve, reject });
      try {
        // Node worker_threads has no browser targetOrigin argument.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        worker.postMessage({ ...command, generation, sequence: id });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }
  function* advance(
    command: "start" | "resume",
    outcome?: Outcome<Value, unknown>,
  ): Operation<Turn<T, Request>> {
    if (state !== (command === "start" ? "new" : "suspended")) {
      throw new Error("Guest advancement is unavailable or already in progress");
    }
    state = "advancing";
    const response = yield* call(() => send({ kind: command, outcome }));
    if (response.kind !== "turn") {
      throw new Error(
        response.kind === "error" ? response.error.message : "Worker closed during advancement",
      );
    }
    state = response.turn.kind;
    return response.turn;
  }
  function close(): Promise<void> {
    return (closing ??= (async () => {
      state = "closed";
      try {
        if (!failure) {
          const response = await send({ kind: "close" });
          if (response.kind !== "closed") {
            throw new Error(
              response.kind === "error" ? response.error.message : "Invalid guest close reply",
            );
          }
        }
      } finally {
        lost(new Error("Guest closed"));
        await worker.terminate();
      }
    })());
  }
  yield* ensure(() => call(close));
  return {
    start: () => advance("start"),
    resume: (outcome) => advance("resume", outcome),
    *close() {
      yield* call(close);
    },
  };
}
