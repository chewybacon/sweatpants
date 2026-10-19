import { assertJson, canonicalDigest, type Json } from "@sweatpants/foundation";
import type { DurableProgramManifest } from "@sweatpants/durable-execution";
import type {
  KernelIdentity,
  WorkflowImplementation,
  WorkflowProgram,
} from "@sweatpants/workflow-kernel";

/** Persistable code and its host contract. Runtime handles never enter this bundle. */
export interface KernelProgramBundle {
  readonly artifact: WorkflowProgram & { readonly code: Json };
  readonly manifest: DurableProgramManifest;
}

function digest(
  code: Json,
  identity: KernelIdentity,
  contract: Omit<DurableProgramManifest, "digest">,
): string {
  return canonicalDigest({ format: "sweatpants.kernel-program.v1", code, identity, contract });
}

/** Pin the exact linked implementation, kernel identity and durable contract. */
export function createKernelProgramBundle(
  implementation: WorkflowImplementation,
  identity: KernelIdentity,
  contract: Omit<DurableProgramManifest, "digest">,
): KernelProgramBundle {
  if (implementation.format !== identity.programFormat) {
    throw Error("Program format differs from kernel");
  }
  const code = structuredClone(assertJson(implementation.payload));
  const kernel = structuredClone(identity);
  const descriptor = structuredClone(contract);
  const programDigest = digest(code, kernel, descriptor);
  return {
    artifact: { digest: programDigest, kernel, code },
    manifest: { ...descriptor, digest: programDigest },
  };
}

/** Verify content on every load; claimed digests alone do not establish identity. */
export function loadKernelProgram(
  bundle: KernelProgramBundle,
  requestedDigest: string,
): WorkflowProgram {
  const { digest: manifestDigest, ...contract } = bundle.manifest;
  const actual = digest(assertJson(bundle.artifact.code), bundle.artifact.kernel, contract);
  if (
    actual !== requestedDigest ||
    actual !== bundle.artifact.digest ||
    actual !== manifestDigest
  ) {
    throw Error("Kernel program content digest differs");
  }
  return structuredClone(bundle.artifact);
}
