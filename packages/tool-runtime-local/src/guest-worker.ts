import { parentPort, workerData } from "node:worker_threads";
import { createScope, suspend, type Operation } from "effection";
import type { Guest } from "@sweatpants/foundation/computation";
import type { GuestCommand, GuestResponse } from "./guest-protocol.ts";

type NativeYield = Operation<unknown> extends Iterable<infer Y> ? Y : never;

/** Serve explicit turns. close may interrupt an outstanding native advancement. */
export function serveWorkerGuest<T, Request, Value, Input>(
  createGuest: (input: Input) => Operation<Guest<T, Request, NativeYield, Value>>,
): void {
  const port = parentPort;
  if (!port) {
    throw new Error("Guest worker requires a worker thread");
  }
  const { generation, input } = workerData as { generation: string; input: Input };
  const [owner, dispose] = createScope();
  let guest: Guest<T, Request, NativeYield, Value> | undefined;
  let expected = 0;
  let advancing = false;
  let closed = false;
  let acquiring: Promise<void> | undefined;
  port.on("message", (command: GuestCommand<Value>) => {
    void (async () => {
      if (command.generation !== generation || command.sequence !== expected++) {
        throw new Error("Guest command correlation mismatch");
      }
      if (closed) {
        throw new Error("Guest worker closed");
      }
      if (command.kind === "close") {
        closed = true;
        try {
          if (acquiring) {
            await acquiring;
          }
          if (guest) {
            await owner.run(() => guest!.close());
          }
        } finally {
          await dispose();
        }
        port.postMessage({
          generation,
          sequence: command.sequence,
          kind: "closed",
        } satisfies GuestResponse<T, Request>);
        return;
      }
      if (advancing) {
        throw new Error("Guest command already in progress");
      }
      advancing = true;
      try {
        if (!guest) {
          if (command.kind !== "start") {
            throw new Error("Guest has not started");
          }
          // Acquisition owns any Guest resources until the worker boundary closes.
          // Returning from this task would dispose them before the first turn.
          acquiring = new Promise<void>((resolve, reject) => {
            void owner
              .run(function* () {
                try {
                  guest = yield* createGuest(input);
                } catch (error) {
                  reject(error);
                  return;
                }
                resolve();
                yield* suspend();
              })
              .catch(reject);
          });
          await acquiring;
        }
        const turn = await owner.run(() =>
          command.kind === "start" ? guest!.start() : guest!.resume(command.outcome),
        );
        port.postMessage({
          generation,
          sequence: command.sequence,
          kind: "turn",
          turn,
        } satisfies GuestResponse<T, Request>);
      } finally {
        advancing = false;
      }
    })().catch((error: unknown) => {
      port.postMessage({
        generation,
        sequence: command.sequence,
        kind: "error",
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      } satisfies GuestResponse<T, Request>);
    });
  });
}
