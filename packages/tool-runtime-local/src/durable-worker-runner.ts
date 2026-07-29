import { type DurableEffectRegistry } from "@sweatpants/durable-effects";

import { type DurableToolRegistry } from "@sweatpants/durable-execution";
import { CrankError } from "@sweatpants/durable-execution";
import { workerMain } from "@effectionx/worker";
import type { Operation } from "effection";
import { createDurableEffectRegistry } from "@sweatpants/durable-effects/runtime";
import { createLocalProgramDriver, type ProgramAttachment } from "@sweatpants/durable-execution";
import { ExecutionDurableEffectRegistryContext } from "@sweatpants/durable-execution";

import type {
  DurableProgramWorkerRequest,
  DurableProgramWorkerResponse,
  DurableProgramWorkerResult,
} from "./durable-worker-protocol.ts";

/**
 * Runs one isolated durable-program evaluator. The worker owns only the live
 * generator attachment; all semantic state and effect execution remain host-side.
 */
export async function runDurableProgramWorker(
  registry: DurableToolRegistry,
  executionEffects: DurableEffectRegistry = createDurableEffectRegistry([]),
): Promise<void> {
  await workerMain<
    DurableProgramWorkerRequest,
    DurableProgramWorkerResponse,
    DurableProgramWorkerResult,
    void
  >(function* ({ messages }) {
    const driver = createLocalProgramDriver(registry, {
      detachedScope: true,
      executionEffects,
    });
    let attachment: ProgramAttachment | undefined;

    yield* ExecutionDurableEffectRegistryContext.with(executionEffects, function* () {
      yield* messages.forEach(function* (message): Operation<DurableProgramWorkerResponse> {
        try {
          switch (message.type) {
            case "attach": {
              if (attachment) {
                throw new CrankError("program_protocol_error", "Worker attachment already exists");
              }
              attachment = yield* driver.attach(message.request);
              return {
                type: "attached",
                attachment: {
                  attachmentId: attachment.attachmentId,
                  taskId: attachment.taskId,
                  driverKind: "worker",
                  route: attachment.route,
                  executionEpoch: attachment.executionEpoch,
                },
              };
            }
            case "step": {
              if (!attachment) {
                throw new CrankError("program_protocol_error", "Worker is not attached");
              }
              return { type: "step", step: yield* driver.step(attachment, message.command) };
            }
            case "shutdown": {
              if (attachment) {
                yield* driver.shutdown(attachment, message.reason);
                attachment = undefined;
              }
              return { type: "shutdown_complete" };
            }
          }
        } catch (error) {
          return {
            type: "rejected",
            error:
              error instanceof CrankError
                ? { code: error.code, message: error.message }
                : { code: "worker_program_error", message: "Durable worker program failed" },
          };
        }
      });
    });

    return { type: "closed" };
  });
}
