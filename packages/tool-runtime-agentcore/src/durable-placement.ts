import type { AgentCoreRuntimeRelease, AgentCoreTaskPlacement } from "./placement-types.ts";
import {
  CrankError,
  canonicalSnapshot,
  effectContractDigest,
  exactProgramKey,
  stableOpaqueId,
  type DurableProgramManifest,
  type PinnedProgram,
  type SandboxAffinity,
} from "@sweatpants/session-contract";

export const AGENTCORE_DURABLE_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_AGENTCORE_WORKSPACE_MOUNT = "/mnt/workspace";
export const DEFAULT_AGENTCORE_IDLE_TIMEOUT_SECONDS = 180;
export const DEFAULT_AGENTCORE_MAX_LIFETIME_SECONDS = 28_800;

/** Validates a closed trusted affinity value. V1 resolves invocation only. */
export function validateSandboxAffinity(value: SandboxAffinity): SandboxAffinity {
  if (!value.key || !["invocation", "conversation", "workspace"].includes(value.kind)) {
    throw new CrankError("invalid_command", "Unknown or empty sandbox affinity");
  }
  return canonicalSnapshot(value).value;
}

/** Rejects mutable/unsafe lifecycle metadata before a release enters readiness. */
export function validateAgentCoreRuntimeRelease(
  release: AgentCoreRuntimeRelease,
): AgentCoreRuntimeRelease {
  if (
    !release.releaseId ||
    !release.runtimeArn ||
    !release.region ||
    !release.imageDigest ||
    !release.registryDigest ||
    !release.iamProfile ||
    !release.networkProfile ||
    release.protocolVersion !== AGENTCORE_DURABLE_PROTOCOL_VERSION
  ) {
    throw new CrankError("placement_unavailable", "AgentCore release metadata is incomplete");
  }
  if (
    release.filesystem.kind !== "managed_session_storage" ||
    !release.filesystem.mountPath.startsWith("/")
  ) {
    throw new CrankError("placement_unavailable", "Managed storage requires an absolute mount");
  }
  const { idleRuntimeSessionTimeoutSeconds: idle, maxLifetimeSeconds: maximum } = release.lifecycle;
  if (!Number.isInteger(idle) || idle < 120 || idle > 300) {
    throw new CrankError("placement_unavailable", "AgentCore idle timeout must be 120-300 seconds");
  }
  if (!Number.isInteger(maximum) || maximum < idle || maximum > 28_800) {
    throw new CrankError("placement_unavailable", "AgentCore maximum lifetime is invalid");
  }
  return canonicalSnapshot(release).value;
}

export interface InvocationPlacementRequest {
  readonly journalId: string;
  readonly rootTaskId: string;
  readonly program: PinnedProgram;
  readonly release: AgentCoreRuntimeRelease;
  readonly now?: () => Date;
  readonly mintRuntimeSessionId?: (rootTaskId: string) => string;
}

/** Trusted invocation-affine resolver. Browser/model input is deliberately absent. */
export function createInvocationAgentCorePlacement(
  request: InvocationPlacementRequest,
): AgentCoreTaskPlacement {
  const release = validateAgentCoreRuntimeRelease(request.release);
  const affinity = validateSandboxAffinity({ kind: "invocation", key: request.rootTaskId });
  const runtimeSessionId =
    request.mintRuntimeSessionId?.(request.rootTaskId) ??
    stableOpaqueId("sp-ac", [request.journalId, request.rootTaskId, release.releaseId]);
  if (!runtimeSessionId || runtimeSessionId.length > 256) {
    throw new CrankError("placement_unavailable", "Placement minted an invalid runtime session");
  }
  return {
    journalId: request.journalId,
    taskId: request.rootTaskId,
    affinity,
    runtimeSessionId,
    release,
    program: canonicalSnapshot(request.program).value,
    createdAt: (request.now?.() ?? new Date()).toISOString(),
  };
}

export interface AgentCoreSamplingReadinessInput {
  readonly required: boolean;
  readonly protocolVersion?: number;
  readonly effectContractDigest?: string;
  readonly deliveryAvailable?: boolean;
  readonly requestedClassifications?: readonly string[];
  readonly allowedClassifications?: ReadonlySet<string>;
}

export interface AgentCoreDurableReadinessInput {
  readonly release?: AgentCoreRuntimeRelease;
  readonly program: PinnedProgram;
  readonly registry: ReadonlyMap<string, DurableProgramManifest>;
  readonly driverAvailable: boolean;
  readonly effectKeys: ReadonlySet<string>;
  readonly schemaDigests: ReadonlySet<string>;
  readonly manifest: DurableProgramManifest;
  readonly sampling?: AgentCoreSamplingReadinessInput;
}

export interface AgentCoreDurableReadiness {
  readonly ready: boolean;
  readonly missing: readonly (
    | "release"
    | "program"
    | "driver"
    | "effect"
    | "schema"
    | "sampling_protocol"
    | "sampling_effect"
    | "sampling_delivery"
    | "sampling_classification"
  )[];
}

/** Reconciles every exact artifact needed before exposing a durable contract. */
export function reconcileAgentCoreDurableReadiness(
  input: AgentCoreDurableReadinessInput,
): AgentCoreDurableReadiness {
  const missing = new Set<AgentCoreDurableReadiness["missing"][number]>();
  try {
    if (!input.release) {
      missing.add("release");
    } else {
      validateAgentCoreRuntimeRelease(input.release);
    }
  } catch {
    missing.add("release");
  }
  const registered = input.registry.get(exactProgramKey(input.program));
  if (!registered || registered.digest !== input.program.digest) {
    missing.add("program");
  }
  if (!input.driverAvailable) {
    missing.add("driver");
  }
  for (const effect of Object.values(input.manifest.effects)) {
    if (!input.effectKeys.has(`${effect.name}@${effect.version}`)) {
      missing.add("effect");
    }
  }
  const schemaDigests = [
    input.manifest.inputSchema.digest,
    input.manifest.outputSchema.digest,
    ...Object.values(input.manifest.elicits).flatMap((elicit) => [
      elicit.response.digest,
      ...(elicit.context ? [elicit.context.digest] : []),
    ]),
    ...Object.values(input.manifest.effects).flatMap((effect) => [
      effect.inputSchema.digest,
      effect.outputSchema.digest,
      ...(effect.cancellation ? [effect.cancellation.partialSchema.digest] : []),
    ]),
  ];
  if (schemaDigests.some((digest) => !input.schemaDigests.has(digest))) {
    missing.add("schema");
  }
  if (input.sampling?.required) {
    const modelSample = Object.values(input.manifest.effects).find(
      (effect) => effect.name === "model.sample",
    );
    if (input.sampling.protocolVersion !== 1) {
      missing.add("sampling_protocol");
    }
    if (!modelSample || input.sampling.effectContractDigest !== effectContractDigest(modelSample)) {
      missing.add("sampling_effect");
    }
    if (!input.sampling.deliveryAvailable) {
      missing.add("sampling_delivery");
    }
    if (
      (input.sampling.requestedClassifications ?? []).some(
        (classification) => !input.sampling?.allowedClassifications?.has(classification),
      )
    ) {
      missing.add("sampling_classification");
    }
  }
  return { ready: missing.size === 0, missing: [...missing] };
}
