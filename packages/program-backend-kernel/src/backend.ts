import { resource, type Operation } from "effection";
import { assertJson, canonicalDigest, type Json } from "@sweatpants/foundation";
import {
  CrankError,
  DurableProgramCancellation,
  type DurableOperationDescriptor,
  type DurableProgramManifest,
  type PinnedProgram,
  type RecordAttemptContext,
} from "@sweatpants/durable-execution";
import {
  InstalledEffectPort,
  ProgramEffectRuntimeContext,
  type ProgramBackend,
  type ProgramComputation,
} from "@sweatpants/journal-authority";
import {
  assertKernelCompatibility,
  type KernelActivation,
  type KernelSnapshot,
} from "@sweatpants/workflow-kernel";
import { prepareWorkflow, type KernelBackendDependencies } from "./prepare.ts";

const checkpointFormat = "sweatpants.kernel-backend.v1";

export interface KernelProgramBackendOptions extends KernelBackendDependencies {
  manifest(program: PinnedProgram): Operation<DurableProgramManifest>;
  /** Bind portable kernel requests to existing installed operation contracts. */
  bindOperation(request: Json, site: string): DurableOperationDescriptor;
}

/** Adapts a kernel to the existing attachment runtime, not a second ProgramDriver. */
export function createKernelProgramBackend(options: KernelProgramBackendOptions): ProgramBackend {
  return {
    capabilities: {
      replay: { kind: "replay", version: 1 },
      continuation: { kind: "continuation", version: "1", format: checkpointFormat },
    },
    *manifest(program) {
      return yield* options.manifest(program);
    },
    open(request, checkpoint) {
      return resource<ProgramComputation>(function* (provide) {
        let saved: KernelSnapshot | undefined;
        if (checkpoint) {
          const value = checkpoint.state;
          if (
            checkpoint.format !== checkpointFormat ||
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            value.programDigest !== request.program.digest ||
            canonicalDigest(value.kernel ?? null) !== canonicalDigest(options.kernelIdentity) ||
            !("state" in value)
          ) {
            throw new CrankError("program_protocol_error", "Workflow kernel snapshot differs");
          }
          // Check claimed identity before passing opaque state to the kernel.
          saved = value as unknown as KernelSnapshot;
        }
        const prepared = yield* prepareWorkflow(options, request.program.digest, saved);
        let activation: KernelActivation | undefined;
        let disposed = false;
        const computation: ProgramComputation = {
          *run() {
            activation = saved
              ? yield* prepared.kernel.restore(prepared.program, saved)
              : yield* prepared.kernel.start(prepared.program, request.input);
            const runtime = yield* ProgramEffectRuntimeContext.expect();
            for (;;) {
              const { execution, boundary }: KernelActivation = activation;
              if (boundary.kind === "terminal") {
                if (boundary.outcome.kind === "returned") {
                  return boundary.outcome.value;
                }
                if (boundary.outcome.kind === "cancelled") {
                  throw new DurableProgramCancellation();
                }
                throw new CrankError("workflow_failed", JSON.stringify(boundary.outcome.value));
              }
              const descriptor = options.bindOperation(boundary.request, boundary.site);
              try {
                const outcome = yield* runtime.perform({
                  serializable: { type: "operation", descriptor },
                  *execute(attempt: RecordAttemptContext) {
                    if (descriptor.kind !== "effect") {
                      throw new CrankError(
                        "program_protocol_error",
                        "Operation settles through the host",
                      );
                    }
                    return yield* InstalledEffectPort.api.operations.run(descriptor, attempt);
                  },
                });
                const next =
                  outcome.status === "cancelled"
                    ? yield* execution.cancel()
                    : yield* execution.resume(
                        outcome.status === "ok"
                          ? { kind: "value", value: outcome.value }
                          : { kind: "throw", value: assertJson(outcome.error) },
                      );
                activation = { execution, boundary: next };
              } catch (error) {
                if (!(error instanceof DurableProgramCancellation)) {
                  throw error;
                }
                activation = { execution, boundary: yield* execution.cancel() };
              }
            }
          },
          *capture() {
            if (disposed || !activation) {
              throw new CrankError("program_protocol_error", "Computation is unavailable");
            }
            const snapshot = yield* activation.execution.capture();
            assertKernelCompatibility(options.kernelIdentity, prepared.program, snapshot);
            return {
              kind: "continuation",
              format: checkpointFormat,
              programDigest: request.program.digest,
              state: assertJson(snapshot),
            };
          },
          *dispose() {
            if (disposed) {
              return;
            }
            disposed = true;
            try {
              if (activation) {
                yield* activation.execution.dispose();
              }
            } finally {
              yield* prepared.kernel.close();
            }
          },
        };
        try {
          yield* provide(computation);
        } finally {
          yield* computation.dispose();
        }
      });
    },
  };
}
