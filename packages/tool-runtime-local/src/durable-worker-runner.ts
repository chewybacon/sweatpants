import { workerMain } from "@effectionx/worker";
import type { Operation } from "effection";
import {
  CrankError,
  createLocalGeneratorDriver,
  type DurableToolRegistry,
  type ProgramAttachment,
} from "@sweatpants/session-contract";

import type {
  DurableProgramWorkerRequest,
  DurableProgramWorkerResponse,
  DurableProgramWorkerResult,
} from "./durable-worker-protocol.ts";

/**
 * Runs one isolated durable-program evaluator. The worker owns only the live
 * generator attachment; all semantic state and effect execution remain host-side.
 */
export async function runDurableProgramWorker(registry: DurableToolRegistry): Promise<void> {
  await workerMain<
    DurableProgramWorkerRequest,
    DurableProgramWorkerResponse,
    DurableProgramWorkerResult,
    void
  >(function* ({ messages }) {
    const driver = createLocalGeneratorDriver(registry);
    let attachment: ProgramAttachment | undefined;

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

    return { type: "closed" };
  });
}
