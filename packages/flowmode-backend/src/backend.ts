import { resource, type Operation } from "effection";
import { assertJson, canonicalDigest } from "@sweatpants/foundation";
import {
  CrankError,
  type DurableOperationDescriptor,
  type DurableProgramManifest,
  type PinnedProgram,
} from "@sweatpants/durable-execution";
import type {
  ProgramBackend,
  ProgramComputation,
  ProgramExecutionState,
} from "@sweatpants/journal-authority";
import {
  assertKernelCompatibility,
  KernelExecutor,
  createWorkflowRuntime,
  type WorkflowRuntimeOptions,
  type ExchangeRequest,
  type KernelSnapshot,
} from "@sweatpants/flowmode-runtime";
import { prepareWorkflow, type KernelBackendDependencies } from "./prepare.ts";
import { createKernelGuest, startKernelGuest, type KernelGuest } from "./guest.ts";

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
        let cursor: KernelGuest | undefined;
        let execution: ProgramExecutionState["execution"] | undefined;
        let disposed = false;
        let failed = false;
        function* disposeExecution(): Operation<void> {
          if (execution) {
            yield* execution.dispose();
          } else if (cursor) {
            yield* cursor.guest.close();
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
              cursor = yield* createKernelGuest(() =>
                executor.start(prepared.program, request.input),
              );
              const state = yield* startKernelGuest(
                cursor,
                (exchangeRequest) => options.bindOperation(exchangeRequest),
                () => {
                  failed = true;
                },
              );
              execution = state.execution;
              yield* provideExecution(state);
            });
          },
          *capture() {
            // A failed guest or transport turn has no resumable boundary. Preserve the
            // failed frontier with replay rather than masking it with capture errors.
            if (failed) {
              return { kind: "replay" };
            }
            if (disposed || !cursor) {
              throw new CrankError("program_protocol_error", "Computation is unavailable");
            }
            const snapshot = yield* cursor.capture();
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
