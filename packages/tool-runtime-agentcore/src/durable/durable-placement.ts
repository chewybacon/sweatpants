import { z } from "zod";
import type {
  AgentCoreRuntimeRelease,
  AgentCoreTaskPlacement,
} from "../placement/placement-types.ts";
import { durableEffectKey } from "@sweatpants/durable-effects";
import { effectContractDigest } from "@sweatpants/durable-effects/runtime";
import {
  CrankError,
  exactProgramKey,
  type DurableProgramManifest,
  type PinnedProgram,
  type SandboxAffinity,
} from "@sweatpants/durable-execution";
import {
  failure,
  parser,
  stableTupleHash,
  success,
  type ParseIssue,
  type ParseResult,
  type Parser,
  cloneJson,
} from "@sweatpants/foundation";

export const AGENTCORE_DURABLE_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_AGENTCORE_WORKSPACE_MOUNT = "/mnt/workspace";
export const DEFAULT_AGENTCORE_IDLE_TIMEOUT_SECONDS = 180;
export const DEFAULT_AGENTCORE_MAX_LIFETIME_SECONDS = 28_800;

const sandboxAffinitySchema = z
  .object({
    kind: z.enum(["invocation", "conversation", "workspace"]),
    key: z.string().min(1).max(512),
  })
  .strict();
const agentCoreRuntimeReleaseSchema = z
  .object({
    releaseId: z.string().min(1).max(512),
    runtimeArn: z.string().min(1).max(2_048),
    region: z.string().min(1).max(128),
    imageDigest: z.string().min(1).max(512),
    protocolVersion: z.literal(AGENTCORE_DURABLE_PROTOCOL_VERSION),
    registryDigest: z.string().min(1).max(512),
    iamProfile: z.string().min(1).max(512),
    networkProfile: z.string().min(1).max(512),
    filesystem: z
      .object({
        kind: z.literal("managed_session_storage"),
        mountPath: z.string().min(1).max(2_048),
      })
      .strict(),
    lifecycle: z
      .object({
        idleRuntimeSessionTimeoutSeconds: z.number().int(),
        maxLifetimeSeconds: z.number().int(),
      })
      .strict(),
  })
  .strict();
const pinnedProgramSchema = z
  .object({
    id: z.string().min(1).max(512),
    version: z.string().min(1).max(128),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const agentCoreTaskPlacementSchema = z
  .object({
    journalId: z.string().min(1).max(512),
    taskId: z.string().min(1).max(512),
    affinity: sandboxAffinitySchema,
    runtimeSessionId: z.string().min(1).max(512),
    release: agentCoreRuntimeReleaseSchema,
    program: pinnedProgramSchema,
    createdAt: z.iso.datetime({ offset: true }),
    terminalAt: z.iso.datetime({ offset: true }).optional(),
    lastComputeGeneration: z.string().min(1).max(512).optional(),
  })
  .strict();

const agentCoreRuntimeReleaseStructureParser = parser(agentCoreRuntimeReleaseSchema);
const agentCoreTaskPlacementStructureParser = parser(agentCoreTaskPlacementSchema);

export const sandboxAffinityParser: Parser<SandboxAffinity> = parser(sandboxAffinitySchema).map(
  (value) => cloneJson(value),
);
export const agentCoreRuntimeReleaseParser: Parser<AgentCoreRuntimeRelease> =
  agentCoreRuntimeReleaseStructureParser.andThen((value) =>
    verifyRuntimeReleaseResult(value as AgentCoreRuntimeRelease),
  );
export const agentCoreTaskPlacementParser: Parser<AgentCoreTaskPlacement> =
  agentCoreTaskPlacementStructureParser.andThen((value) => {
    const release = agentCoreRuntimeReleaseParser.parse(value.release);
    if (!release.ok) {
      return prefixFailure(release.issues, ["release"]);
    }
    return success(cloneJson({ ...value, release: release.value }) as AgentCoreTaskPlacement);
  });

/** Parses a closed affinity value at an AgentCore adapter ingress. */
export function parseSandboxAffinity(value: unknown): SandboxAffinity {
  const parsed = sandboxAffinityParser.parse(value);
  if (!parsed.ok) {
    throw new CrankError("invalid_command", "Unknown or empty sandbox affinity");
  }
  return parsed.value;
}

/** Parses and verifies closed AgentCore lifecycle metadata before nested access. */
export function parseAgentCoreRuntimeRelease(value: unknown): AgentCoreRuntimeRelease {
  const parsed = agentCoreRuntimeReleaseParser.parse(value);
  if (!parsed.ok) {
    const issue = parsed.issues[0];
    throw new CrankError(
      "placement_unavailable",
      issue?.code === "placement_unavailable"
        ? issue.message
        : "AgentCore release metadata is incomplete",
    );
  }
  return parsed.value;
}

export function parseAgentCoreTaskPlacement(value: unknown): AgentCoreTaskPlacement {
  const parsed = agentCoreTaskPlacementParser.parse(value);
  if (!parsed.ok) {
    const issue = parsed.issues[0];
    throw new CrankError(
      "placement_unavailable",
      issue?.code === "placement_unavailable"
        ? issue.message
        : "AgentCore task placement is malformed",
    );
  }
  return parsed.value;
}

/** Verifies AgentCore lifecycle and managed-storage policy after parsing. */
export function verifyAgentCoreRuntimeRelease(
  release: AgentCoreRuntimeRelease,
): AgentCoreRuntimeRelease {
  if (!release.filesystem.mountPath.startsWith("/")) {
    throw new CrankError("placement_unavailable", "Managed storage requires an absolute mount");
  }
  const { idleRuntimeSessionTimeoutSeconds: idle, maxLifetimeSeconds: maximum } = release.lifecycle;
  if (idle < 120 || idle > 300) {
    throw new CrankError("placement_unavailable", "AgentCore idle timeout must be 120-300 seconds");
  }
  if (maximum < idle || maximum > 28_800) {
    throw new CrankError("placement_unavailable", "AgentCore maximum lifetime is invalid");
  }
  return cloneJson(release);
}

function verifyRuntimeReleaseResult(
  release: AgentCoreRuntimeRelease,
): ParseResult<AgentCoreRuntimeRelease> {
  try {
    return success(verifyAgentCoreRuntimeRelease(release));
  } catch (error) {
    if (error instanceof CrankError) {
      return failure({ path: [], message: error.message, code: error.code });
    }
    throw error;
  }
}

function prefixFailure<T = never>(
  issues: readonly ParseIssue[],
  prefix: readonly (string | number)[],
): ParseResult<T> {
  return failure(issues.map((issue) => ({ ...issue, path: [...prefix, ...issue.path] })));
}

export interface InvocationPlacementRequest {
  readonly journalId: string;
  readonly rootTaskId: string;
  readonly program: PinnedProgram;
  readonly release: unknown;
  readonly now?: () => Date;
  readonly mintRuntimeSessionId?: (rootTaskId: string) => string;
}

/** Trusted invocation-affine resolver. Browser/model input is deliberately absent. */
export function createInvocationAgentCorePlacement(
  request: InvocationPlacementRequest,
): AgentCoreTaskPlacement {
  const release = parseAgentCoreRuntimeRelease(request.release);
  const affinity = parseSandboxAffinity({ kind: "invocation", key: request.rootTaskId });
  const runtimeSessionId =
    request.mintRuntimeSessionId?.(request.rootTaskId) ??
    stableTupleHash(["sp-ac", request.journalId, request.rootTaskId, release.releaseId]);
  if (!runtimeSessionId || runtimeSessionId.length > 256) {
    throw new CrankError("placement_unavailable", "Placement minted an invalid runtime session");
  }
  return {
    journalId: request.journalId,
    taskId: request.rootTaskId,
    affinity,
    runtimeSessionId,
    release,
    program: cloneJson(request.program),
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
      parseAgentCoreRuntimeRelease(input.release);
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
    if (!input.effectKeys.has(durableEffectKey(effect.name, effect.version))) {
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
