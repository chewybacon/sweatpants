import { definePort } from "@sweatpants/foundation/port";
import { assertJson, canonicalDigest, type Json } from "@sweatpants/foundation";
import type { Operation } from "effection";
import { createMontyKernel, playgroundIdentity } from "./kernel.mjs";
import type { KernelSnapshot } from "@sweatpants/flowmode-runtime";

export type MontyCommand = { source: string } & (
  | { action: "start" }
  | { action: "resume"; snapshot: Json; reply: Json }
  | { action: "cancel"; snapshot: Json; reason: string }
);
export interface MontyEvaluationDriver {
  execute(command: MontyCommand): Operation<Record<string, Json>>;
}
export const MontyEvaluationPort = definePort<MontyEvaluationDriver>("workflow-monty-evaluation", {
  *execute() {
    throw Error("Python evaluation driver is not installed");
  },
});

/** Each journaled compute turn owns and disposes a fresh Wasm instance. */
export function createMontyEvaluationDriver(
  loadModule: Parameters<typeof createMontyKernel>[0],
): MontyEvaluationDriver {
  return {
    *execute(command) {
      const kernel = createMontyKernel(loadModule, { profile: "playground" });
      const program = {
        kernel: playgroundIdentity,
        digest: canonicalDigest({ source: command.source, kernel: playgroundIdentity }),
        code: command.source,
      };
      try {
        const state =
          command.action === "start"
            ? yield* kernel.start(program, null)
            : yield* kernel.restore(program, command.snapshot as unknown as KernelSnapshot);
        let boundary = state.boundary;
        if (command.action !== "start") {
          if (boundary.kind !== "suspended") {
            throw Error("Python execution is not suspended");
          }
          boundary =
            command.action === "cancel"
              ? yield* state.execution.cancel(command.reason)
              : yield* state.execution.resume(boundary.suspensionId, {
                  kind: "value",
                  value: command.reply,
                });
        }
        return {
          boundary: assertJson(boundary),
          snapshot:
            boundary.kind === "suspended" ? assertJson(yield* state.execution.capture()) : null,
        };
      } finally {
        yield* kernel.close();
      }
    },
  };
}
