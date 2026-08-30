/**
 * Pull-kind policy registry: the single source of truth for how each parked
 * interaction kind resolves. Kernel layers consume policies generically;
 * host layers register resolvers against the same kind names.
 *
 * Leaf module — imports only downward (types + foundation). Kind modules
 * depend on this file; nothing here depends on a kind.
 */
import type { Operation } from "effection";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import type { z } from "zod";
import {
  CrankError,
  type DurableOperationDescriptor,
  type DurableProgramManifest,
} from "@sweatpants/durable-execution";
import type { Json } from "@sweatpants/foundation";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import type { ResolutionAuthority } from "../contract/authority-contract.ts";

/** Structural contract hosts implement to settle one kind of parked pull. */
export interface PullResolutionContext {
  readonly sessionId: string;
  readonly taskId: string;
  readonly pullId: string;
  /**
   * Placement evidence for the attachment whose activation exposed the park.
   * Supplied by the settle site, which owns that binding by construction;
   * resolvers MUST NOT reconstruct it from host-side mutable state.
   */
  readonly placement: {
    readonly program: { readonly id: string; readonly version: string; readonly digest: string };
    readonly route: Json;
    readonly driverKind: string;
    readonly executionEpoch: number;
  };
}

export interface PullResolver {
  readonly kind: string;
  audience(descriptor: Json): string;
  perform(ctx: PullResolutionContext, descriptor: Json): Operation<OperationOutcome>;
  /** Runs only after Authority accepted or deduplicated the durable outcome. */
  afterResolve?(
    ctx: PullResolutionContext,
    descriptor: Json,
    outcomeDigest: string,
  ): Operation<void>;
}

/** Registry construction rejects duplicate kinds at build time. */
export function createPullResolverRegistry(
  resolvers: readonly PullResolver[],
): ReadonlyMap<string, PullResolver> {
  const map = new Map<string, PullResolver>();
  for (const resolver of resolvers) {
    if (map.has(resolver.kind)) {
      throw new CrankError("invalid_descriptor", `Duplicate pull resolver kind: ${resolver.kind}`);
    }
    map.set(resolver.kind, resolver);
  }
  return map;
}

/**
 * Kernel-side policy declared by each kind: how reserves authorize, how
 * resolution authorities derive, which pending reason surfaces, and the
 * descriptor schema shared with the snapshot codec.
 */
export interface PullKindPolicy {
  readonly kind: string;
  /** Pending reason surfaced on park; defaults to the kind name. */
  readonly pendingReason?: string;
  /** Zod schema for the descriptor variant; consumed by the snapshot codec. */
  readonly descriptorSchema: z.ZodType;
  /** Absent for executable (non-parking) descriptor channels. */
  readonly resolutionAuthority?: (
    descriptor: DurableOperationDescriptor,
    audience: string,
  ) => ResolutionAuthority;
  /**
   * Reserve-time resolution target for kinds whose policy is pure data
   * (no manifest coupling). Manifest-coupled kinds keep structural cases.
   */
  /** Journal effect label for the generic pull boundary. */
  readonly journalLabel?: (descriptor: Json) => string;
  readonly resolutionTarget?: (
    descriptor: DurableOperationDescriptor,
    manifest: DurableProgramManifest,
  ) => {
    resultDescriptor: PortableSchemaDescriptor;
    audience: string;
    inputDigest?: string;
  };
}

const registry = new Map<string, PullKindPolicy>();

/** Registers one kind policy; duplicate registration is an invariant breach. */
export function registerPullKind(policy: PullKindPolicy): void {
  if (registry.has(policy.kind)) {
    throw new CrankError("invalid_descriptor", `Duplicate pull kind policy: ${policy.kind}`);
  }
  registry.set(policy.kind, policy);
}

export function pullKindPolicy(kind: string): PullKindPolicy | undefined {
  return registry.get(kind);
}

/** All registered policies, in registration order. Snapshot codec consumes this. */
export function registeredPullKinds(): readonly PullKindPolicy[] {
  return [...registry.values()];
}
