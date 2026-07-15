import type { Operation } from "effection";
import type {
  AttachProgramRequest,
  ProgramAttachment,
  ProgramCommand,
  ProgramDriver,
  ProgramRestoreRequest,
  ProgramShutdownReason,
  ProgramStep,
  RestoredProgramAttachment,
} from "@sweatpants/session-contract";

/**
 * Controlled typed transport for crank-native AgentCore programs. Runtime
 * invocation/container handles remain inside the opaque attachment handle and
 * are never journal descriptors.
 */
export interface AgentCoreDurableProgramTransport {
  attach(request: AttachProgramRequest): Operation<ProgramAttachment>;
  step(attachment: ProgramAttachment, command: ProgramCommand): Operation<ProgramStep>;
  shutdown(attachment: ProgramAttachment, reason: ProgramShutdownReason): Operation<void>;
  restore?(request: ProgramRestoreRequest): Operation<RestoredProgramAttachment>;
}

/** Creates an AgentCore transport driver; the caller owns the scoped client and cancellation. */
export function createAgentCoreDurableProgramDriver(
  transport: AgentCoreDurableProgramTransport,
): ProgramDriver {
  return {
    *attach(request) {
      const attachment = yield* transport.attach(request);
      return { ...attachment, driverKind: "agentcore" };
    },
    *step(attachment, command) {
      return yield* transport.step(attachment, command);
    },
    *shutdown(attachment, reason) {
      yield* transport.shutdown(attachment, reason);
    },
    ...(transport.restore
      ? {
          *restore(request: ProgramRestoreRequest) {
            const restored = yield* transport.restore!(request);
            return {
              ...restored,
              attachment: { ...restored.attachment, driverKind: "agentcore" },
            };
          },
        }
      : {}),
  };
}
