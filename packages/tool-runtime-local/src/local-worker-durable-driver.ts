import { type DurableToolRegistry } from "@sweatpants/durable-execution";
import { CrankError } from "@sweatpants/durable-execution";
import { useWorker, type WorkerResource } from "@effectionx/worker";
import { type ProgramAttachment, type ProgramDriver } from "@sweatpants/session-contract";

import type {
  DurableProgramWorkerRequest,
  DurableProgramWorkerResponse,
  DurableProgramWorkerResult,
} from "./durable-worker-protocol.ts";

/** Composition options for a real worker-thread durable program evaluator. */
export interface LocalWorkerDurableProgramDriverOptions {
  /** Static worker bootstrap containing the exact pinned durable program registry. */
  workerUrl: string | URL;
  /** Optional diagnostic worker name. */
  name?: string;
  /** Host-side exact manifest inventory used before child worker attachment. */
  registry?: DurableToolRegistry;
}

let workerAttachmentCounter = 0;

type DurableWorkerResource = WorkerResource<
  DurableProgramWorkerRequest,
  DurableProgramWorkerResponse,
  DurableProgramWorkerResult
>;

class LocalWorkerAttachmentHandle {
  shutdown = false;

  constructor(readonly worker: DurableWorkerResource) {}

  toJSON(): never {
    throw new CrankError("invalid_descriptor", "Durable worker attachments are runtime-only");
  }
}

/**
 * Creates a concrete local worker-thread ProgramDriver. Each attachment owns a
 * worker resource; parking/shutdown discards the worker and fresh attach replays
 * from the host journal.
 */
export function createLocalWorkerDurableProgramDriver(
  options: LocalWorkerDurableProgramDriverOptions,
): ProgramDriver {
  return {
    *attach(request) {
      const worker = yield* useWorker<
        DurableProgramWorkerRequest,
        DurableProgramWorkerResponse,
        DurableProgramWorkerResult,
        void
      >(options.workerUrl, {
        type: "module",
        ...(options.name ? { name: options.name } : {}),
      });
      const response = yield* worker.send({ type: "attach", request });
      if (response.type === "rejected") {
        throw new CrankError(response.error.code, response.error.message);
      }
      if (response.type !== "attached") {
        throw new CrankError("program_protocol_error", "Worker did not acknowledge attachment");
      }
      workerAttachmentCounter += 1;
      return {
        ...response.attachment,
        attachmentId: `${response.attachment.attachmentId}:worker-${workerAttachmentCounter}`,
        driverKind: "worker",
        handle: new LocalWorkerAttachmentHandle(worker),
      };
    },

    *step(attachment, command) {
      const handle = attachmentHandle(attachment);
      if (handle.shutdown) {
        throw new CrankError("stale_program_capability", "Worker attachment is shut down");
      }
      const response = yield* handle.worker.send({ type: "step", command });
      if (response.type === "rejected") {
        throw new CrankError(response.error.code, response.error.message);
      }
      if (response.type !== "step") {
        throw new CrankError("program_protocol_error", "Worker returned an invalid step response");
      }
      return response.step;
    },

    *shutdown(attachment, reason) {
      const handle = attachmentHandle(attachment);
      if (handle.shutdown) {
        return;
      }
      handle.shutdown = true;
      const response = yield* handle.worker.send({ type: "shutdown", reason });
      if (response.type === "rejected") {
        throw new CrankError(response.error.code, response.error.message);
      }
      if (response.type !== "shutdown_complete") {
        throw new CrankError("program_protocol_error", "Worker did not acknowledge shutdown");
      }
    },

    *manifest(program) {
      const tool = options.registry?.get(`${program.id}@${program.version}#${program.digest}`);
      if (!tool) {
        throw new CrankError(
          "program_version_unavailable",
          `Local worker bundle is unavailable for ${program.id}@${program.version}#${program.digest}`,
        );
      }
      return tool.manifest;
    },
  };
}

function attachmentHandle(attachment: ProgramAttachment): LocalWorkerAttachmentHandle {
  if (!(attachment.handle instanceof LocalWorkerAttachmentHandle)) {
    throw new CrankError(
      "program_protocol_error",
      "Attachment is not owned by local worker driver",
    );
  }
  return attachment.handle;
}
