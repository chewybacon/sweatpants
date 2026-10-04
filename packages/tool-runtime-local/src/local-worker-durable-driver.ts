import {
  CrankError,
  exactProgramKey,
  REPLAY_CHECKPOINT_CAPABILITIES,
  type DurableToolRegistry,
  type ProgramAttachment,
  type ProgramDriver,
} from "@sweatpants/durable-execution";
import { useWorker } from "@effectionx/worker";
import type { Operation } from "effection";
import { useDurableWorkerPool, type DurableWorkerLease } from "./durable-worker-pool.ts";

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

class LocalWorkerAttachmentHandle {
  shutdown = false;

  constructor(readonly worker: DurableWorkerLease) {}

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
  return createDriver(options, function* () {
    const worker = yield* useWorker<
      DurableProgramWorkerRequest,
      DurableProgramWorkerResponse,
      DurableProgramWorkerResult,
      void
    >(options.workerUrl, { type: "module", name: options.name });
    return { send: (request) => worker.send(request), *release() {} };
  });
}

export interface RetainedLocalWorkerOptions extends LocalWorkerDurableProgramDriverOptions {
  /** Keep an unattached worker warm after a durable park. Zero disables retention. */
  idleTimeoutMs: number;
  /** Observe worker transport failures; defaults to console.error. */
  onWorkerError?: (error: unknown) => void;
}

/** Acquire an application-scoped driver; generator attachments still close at every park. */
export function* useLocalWorkerDurableProgramDriver(
  options: RetainedLocalWorkerOptions,
): Operation<ProgramDriver> {
  if (
    !Number.isSafeInteger(options.idleTimeoutMs) ||
    options.idleTimeoutMs < 0 ||
    options.idleTimeoutMs > 2_147_483_647
  )
    throw new Error("idleTimeoutMs must be an integer between 0 and 2147483647");
  if (options.idleTimeoutMs === 0) return createLocalWorkerDurableProgramDriver(options);
  const pool = yield* useDurableWorkerPool(options);
  return createDriver(options, () => pool.acquire());
}

function createDriver(
  options: LocalWorkerDurableProgramDriverOptions,
  acquire: () => Operation<DurableWorkerLease>,
): ProgramDriver {
  return {
    evaluatorKind: "worker",
    capabilities: REPLAY_CHECKPOINT_CAPABILITIES,
    *attach(request) {
      const worker = yield* acquire();
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
      let reusable = false;
      try {
        const response = yield* handle.worker.send({ type: "shutdown", reason });
        if (response.type === "rejected") {
          throw new CrankError(response.error.code, response.error.message);
        }
        if (response.type !== "shutdown_complete") {
          throw new CrankError("program_protocol_error", "Worker did not acknowledge shutdown");
        }
        reusable = reason === "parked";
      } finally {
        yield* handle.worker.release(reusable);
      }
    },

    *manifest(program) {
      const tool = options.registry?.get(exactProgramKey(program));
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
