import { resource, type Operation } from "effection";
import { assertJson, canonicalDigest, type Json } from "@sweatpants/foundation";
import {
  CrankError,
  type DurableOperationDescriptor,
  type DurableProgramManifest,
  type PinnedProgram,
  type RecordAttemptContext,
} from "@sweatpants/durable-execution";
import {
  InstalledEffectPort,
  type ProgramBackend,
  type ProgramComputation,
  type ProgramExecutionState,
  type ProgramReply,
} from "@sweatpants/journal-authority";
import {
  assertKernelCompatibility,
  KernelExecutor,
  type KernelExecutionState,
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
        const kernelExecutor = prepared.kernel;
        let executionState: KernelExecutionState | undefined;
        let disposed = false;
        let failed = false;
        const computation: ProgramComputation = {
          start() {
            return resource<ProgramExecutionState>(function* (provideExecution) {
              yield* KernelExecutor.installDriver(kernelExecutor);
              // Snapshot selection and identity checks precede this middleware.
              // Outer observers see the same startup seam for start and restore.
              if (saved) {
                const snapshot = saved;
                yield* KernelExecutor.api.around(
                  {
                    *start([program]) {
                      return yield* kernelExecutor.restore(program, snapshot);
                    },
                  },
                  { at: "min" },
                );
              }
              const executor = yield* KernelExecutor.use();
              try {
                executionState = yield* executor.start(prepared.program, request.input);
              } catch (error) {
                failed = true;
                throw error;
              }
              const { execution } = executionState;
              function bind(
                boundary: KernelExecutionState["boundary"],
              ): ProgramExecutionState["boundary"] {
                if (boundary.kind === "failed") {
                  failed = true;
                  return {
                    kind: "failed",
                    error: new CrankError("workflow_failed", JSON.stringify(boundary.error)),
                  };
                }
                if (boundary.kind !== "suspended") {
                  return boundary;
                }
                const descriptor = options.bindOperation(
                  boundary.request.request,
                  boundary.request.site,
                );
                return {
                  kind: "suspended",
                  suspensionId: boundary.suspensionId,
                  request: {
                    kind: "record",
                    boundary: {
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
                    },
                  },
                };
              }
              // Translate the evaluator's value/throw vocabulary. The attachment
              // owns the driving loop; this adapter never performs host requests.
              let initial: ProgramExecutionState["boundary"];
              try {
                initial = bind(executionState.boundary);
              } catch (error) {
                failed = true;
                throw error;
              }
              yield* provideExecution({
                boundary: initial,
                execution: {
                  *resume(suspensionId, reply: ProgramReply) {
                    if (reply.kind !== "record") {
                      throw new CrankError("program_protocol_error", "Expected record reply");
                    }
                    try {
                      const outcome = reply.outcome;
                      let next: KernelExecutionState["boundary"];
                      if (outcome.status === "cancelled") {
                        next = yield* execution.cancel();
                      } else {
                        next = yield* execution.resume(
                          suspensionId,
                          outcome.status === "ok"
                            ? { kind: "value", value: outcome.value }
                            : { kind: "throw", value: assertJson(outcome.error) },
                        );
                      }
                      return bind(next);
                    } catch (error) {
                      failed = true;
                      throw error;
                    }
                  },
                  *cancel(reason) {
                    try {
                      const next = yield* execution.cancel(reason);
                      return bind(next);
                    } catch (error) {
                      failed = true;
                      throw error;
                    }
                  },
                  dispose: () => execution.dispose(),
                },
              });
            });
          },
          *capture() {
            // A thrown evaluator error has no resumable boundary. Preserve the
            // failed frontier with replay rather than masking it with capture errors.
            if (failed) {
              return { kind: "replay" };
            }
            if (disposed || !executionState) {
              throw new CrankError("program_protocol_error", "Computation is unavailable");
            }
            const snapshot = yield* executionState.execution.capture();
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
              if (executionState) {
                yield* executionState.execution.dispose();
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
