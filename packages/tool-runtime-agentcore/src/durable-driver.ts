import { CrankError } from "@sweatpants/durable-execution";
import type { Operation } from "effection";
import {
  exactProgramKey,
  type AttachProgramRequest,
  type DurableProgramManifest,
  type ProgramAttachment,
  type ProgramCommand,
  type ProgramDriver,
  type ProgramRestoreContext,
  type ProgramRestoreRequest,
  type ProgramShutdownReason,
  type ProgramStep,
  type RestoredProgramAttachment,
} from "@sweatpants/durable-execution";

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
  restoreContext?(request: AttachProgramRequest): Operation<ProgramRestoreContext>;
}

/** Creates an AgentCore transport driver; the caller owns the scoped client and cancellation. */
export function createAgentCoreDurableProgramDriver(
  transport: AgentCoreDurableProgramTransport,
  options: {
    readonly manifests?: ReadonlyMap<string, DurableProgramManifest>;
  } = {},
): ProgramDriver {
  return {
    ...(options.manifests
      ? {
          *manifest(program) {
            const manifest = options.manifests!.get(exactProgramKey(program));
            if (!manifest) {
              throw new CrankError(
                "unknown_target",
                `AgentCore program manifest is unavailable for ${program.id}`,
              );
            }
            return manifest;
          },
        }
      : {}),
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
    ...(transport.restoreContext
      ? {
          *restoreContext(request: AttachProgramRequest) {
            return yield* transport.restoreContext!(request);
          },
        }
      : {}),
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
