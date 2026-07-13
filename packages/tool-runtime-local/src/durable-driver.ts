import type { Operation } from "effection";
import {
  createLocalGeneratorDriver,
  type AttachProgramRequest,
  type DurableToolRegistry,
  type ProgramAttachment,
  type ProgramCommand,
  type ProgramDriver,
  type ProgramShutdownReason,
  type ProgramStep,
} from "@sweatpants/session-contract";

/** In-process canonical driver used as the semantic baseline. */
export function createLocalDurableProgramDriver(registry?: DurableToolRegistry): ProgramDriver {
  return createLocalGeneratorDriver(registry);
}

/** Typed worker binding. Implementations own serialization and worker lifetime. */
export interface DurableWorkerProgramTransport {
  attach(request: AttachProgramRequest): Operation<ProgramAttachment>;
  step(attachment: ProgramAttachment, command: ProgramCommand): Operation<ProgramStep>;
  shutdown(attachment: ProgramAttachment, reason: ProgramShutdownReason): Operation<void>;
}

/** Creates a worker-backed driver over a caller-owned serializable transport. */
export function createWorkerDurableProgramDriver(
  transport: DurableWorkerProgramTransport,
): ProgramDriver {
  return {
    *attach(request) {
      const attachment = yield* transport.attach(request);
      return { ...attachment, driverKind: "worker" };
    },
    *step(attachment, command) {
      return yield* transport.step(attachment, command);
    },
    *shutdown(attachment, reason) {
      yield* transport.shutdown(attachment, reason);
    },
  };
}
