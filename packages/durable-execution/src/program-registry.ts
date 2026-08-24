import { stableTupleHash } from "@sweatpants/foundation";

import { CrankError } from "./errors.ts";
import { verifyProgramIdentityProvenance } from "./program-identity.ts";
import type { DurableTool } from "./program-authoring.ts";
import type { PinnedProgram } from "./program-contract.ts";
import type { AttachProgramRequest } from "./program-driver-contract.ts";
import type { DurableToolRegistry } from "./program-driver-context.ts";

/** Builds an exact pinned-program registry and rejects duplicate identities. */
export function createDurableToolRegistry(tools: Iterable<DurableTool>): DurableToolRegistry {
  const registry = new Map<string, DurableTool>();
  for (const tool of tools) {
    verifyProgramIdentityProvenance(tool);
    const key = exactProgramKey({
      id: tool.manifest.programId,
      version: tool.manifest.version,
      digest: tool.manifest.digest,
    });
    if (registry.has(key)) {
      throw new CrankError("invalid_manifest", `Duplicate durable program ${key}`);
    }
    registry.set(key, tool);
  }
  return registry;
}

/** Canonical exact-key format shared by program registries and hosts. */
export function exactProgramKey(program: PinnedProgram): string {
  return stableTupleHash([program.id, program.version, program.digest]);
}

/** Derives a stable attachment identifier from pinned program and task identity. */
export function stableProgramAttachmentId(request: AttachProgramRequest): string {
  return stableTupleHash([
    "attachment-seed",
    request.sessionId,
    request.taskId,
    request.executionEpoch,
    request.program.id,
    request.program.version,
    request.program.digest,
  ]);
}
