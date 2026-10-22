import { createWorkflowProgramDriver } from "@sweatpants/journal-authority";
import type { ProgramDriver } from "@sweatpants/durable-execution";
import type { WorkflowRuntime } from "@sweatpants/flowmode-runtime";
import { createKernelProgramBackend, type KernelProgramBackendOptions } from "./backend.ts";
import { loadKernelProgram, type KernelProgramBundle } from "./program.ts";

export interface KernelProgramOptions {
  readonly bundle: KernelProgramBundle;
  readonly runtime: WorkflowRuntime;
  readonly bindOperation: KernelProgramBackendOptions["bindOperation"];
}

export interface KernelProgram extends KernelProgramBundle {
  createDriver(): ProgramDriver;
}

/** Assemble a language runtime through the existing authority attachment protocol. */
export function createKernelProgram({
  bundle,
  runtime,
  bindOperation,
}: KernelProgramOptions): KernelProgram {
  return {
    ...bundle,
    createDriver() {
      return createWorkflowProgramDriver(
        createKernelProgramBackend({
          kernelIdentity: runtime.kernelIdentity,
          *manifest(program) {
            loadKernelProgram(bundle, program.digest);
            return structuredClone(bundle.manifest);
          },
          *loadProgram(digest) {
            return loadKernelProgram(bundle, digest);
          },
          createKernel: () => runtime.createKernel(),
          bindOperation,
        }),
      );
    },
  };
}
