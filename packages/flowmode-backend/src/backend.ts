import { resource, type Operation } from "effection";
import { assertJson, canonicalDigest } from "@sweatpants/foundation";
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
  EffectionKernel,
  ProgramEffectRuntimeContext,
  type ProgramBackend,
  type ProgramComputation,
  type ProgramExecutionState,
} from "@sweatpants/journal-authority";
import {
  assertKernelCompatibility,
  KernelExecutor,
  createWorkflowFlow,
  createWorkflowRuntime,
  WorkflowFailure,
  type WorkflowExchange,
  type WorkflowRuntimeOptions,
  type WorkflowExecutionState,
  type ExchangeRequest,
  type KernelSnapshot,
} from "@sweatpants/flowmode-runtime";
import { prepareWorkflow, type KernelBackendDependencies } from "./prepare.ts";

const checkpointFormat = "sweatpants.kernel-backend.v1";

export interface KernelProgramBackendOptions extends KernelBackendDependencies {
  runtimeMiddleware?: WorkflowRuntimeOptions["middleware"];
  manifest(program: PinnedProgram): Operation<DurableProgramManifest>;
  /** Bind portable kernel requests to existing installed operation contracts. */
  bindOperation(request: ExchangeRequest): DurableOperationDescriptor;
}

/** Adapts a kernel to the existing attachment runtime, not a second ProgramDriver. */
export function createKernelProgramBackend(options: KernelProgramBackendOptions): ProgramBackend {
  const runtime = createWorkflowRuntime({ driver: options, middleware: options.runtimeMiddleware });
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
          saved = {
            kernel: options.kernelIdentity,
            programDigest: value.programDigest,
            state: value.state,
          };
        }
        const prepared = yield* prepareWorkflow(
          {
            kernelIdentity: runtime.kernelIdentity,
            createKernel: () => runtime.createKernel(),
            loadProgram: (digest) => options.loadProgram(digest),
          },
          request.program.digest,
          saved,
        );
        const kernelExecutor = prepared.kernel;
        let executionState: WorkflowExecutionState | undefined;
        let flowExecution: ProgramExecutionState["execution"] | undefined;
        let disposed = false;
        let failed = false;
        function* disposeExecution(): Operation<void> {
          // Revoke the live exchange before releasing the guest it would resume.
          if (flowExecution) {
            yield* flowExecution.dispose();
          }
          if (executionState) {
            yield* executionState.execution.dispose();
          }
        }
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
              const flow = createWorkflowFlow(function* (input) {
                executionState = yield* executor.start(prepared.program, input);
                return executionState;
              });
              const exchange: WorkflowExchange = function* (exchangeRequest) {
                const descriptor = options.bindOperation(exchangeRequest);
                const runtime = yield* ProgramEffectRuntimeContext.expect();
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
                if (outcome.status === "cancelled") {
                  throw new DurableProgramCancellation();
                }
                return outcome.status === "ok"
                  ? { kind: "value", value: outcome.value }
                  : { kind: "throw", value: assertJson(outcome.error) };
              };
              // The existing evaluator exposes Flow's exchanges as attachment
              // boundaries. Its JS stack is ephemeral; capture still reads the VM.
              const state = yield* EffectionKernel.start(function* (input) {
                try {
                  return yield* flow(input, exchange);
                } catch (error) {
                  if (!(error instanceof DurableProgramCancellation)) {
                    failed = true;
                  }
                  if (error instanceof WorkflowFailure) {
                    throw new CrankError("workflow_failed", error.message);
                  }
                  throw error;
                }
              }, request.input);
              flowExecution = state.execution;
              yield* provideExecution({
                boundary: state.boundary,
                execution: {
                  resume: (id, reply) => state.execution.resume(id, reply),
                  cancel: (reason) => state.execution.cancel(reason),
                  dispose: disposeExecution,
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
              yield* disposeExecution();
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
