import { resource, type Operation } from "effection";
import {
  assertKernelCompatibility,
  type KernelIdentity,
  type KernelSnapshot,
  type WorkflowKernel,
  type WorkflowProgram,
} from "@sweatpants/workflow-kernel";

/**
 * Opt-in dependencies for a kernel computation backend.
 * No registration, Wasm loading, or journal mutation happens on import.
 */
export interface KernelBackendDependencies {
  readonly kernelIdentity: KernelIdentity;
  readonly createKernel: () => Operation<WorkflowKernel>;
  /** Must verify the artifact's content digest, not just its claimed field. */
  readonly loadProgram: (digest: string) => Operation<WorkflowProgram>;
}

/**
 * Acquire a kernel resource in the caller's Effection scope. Scope exit releases
 * compute, including after identity failure or host cancellation; it never sends
 * logical workflow cancellation. Partial factory acquisition must be owned by
 * the factory itself. The host still verifies snapshot journal authority.
 */
export function* prepareWorkflow(
  options: KernelBackendDependencies,
  digest: string,
  snapshot?: KernelSnapshot,
): Operation<{ kernel: WorkflowKernel; program: WorkflowProgram }> {
  const program = yield* options.loadProgram(digest);
  if (program.digest !== digest) {
    throw new Error("Workflow loader returned a different program");
  }
  assertKernelCompatibility(options.kernelIdentity, program, snapshot);
  return yield* resource(function* (provide) {
    const kernel = yield* options.createKernel();
    try {
      assertKernelCompatibility(kernel.identity, program, snapshot);
      yield* provide({ kernel, program });
    } finally {
      yield* kernel.close();
    }
  });
}
