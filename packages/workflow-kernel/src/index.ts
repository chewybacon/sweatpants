import type { Operation } from "effection";
import type { Json } from "@sweatpants/foundation";

export interface KernelIdentity {
  readonly kind: string;
  readonly version: string;
  readonly programFormat: string;
  readonly snapshotFormat: string;
}

/** Content digest verification belongs to the artifact loader, before start. */
export interface WorkflowProgram {
  readonly digest: string;
  readonly kernel: KernelIdentity;
  readonly code: unknown;
}

export type KernelOutcome =
  | { readonly kind: "returned"; readonly value: Json }
  | { readonly kind: "thrown"; readonly value: Json }
  | { readonly kind: "cancelled" };

export type KernelBoundary =
  | {
      readonly kind: "effect";
      /** Stable source address, not a journal pull ID. */
      readonly site: string;
      readonly request: Json;
    }
  | { readonly kind: "terminal"; readonly outcome: KernelOutcome };

export type KernelReply =
  | { readonly kind: "value"; readonly value: Json }
  | { readonly kind: "throw"; readonly value: Json };

/** Kernel-owned state. Journal cursor/receipt authority belongs to the host envelope. */
export interface KernelSnapshot {
  readonly kernel: KernelIdentity;
  readonly programDigest: string;
  readonly state: unknown;
}

/**
 * Bound, activation-local execution. Private JS/Wasm handles never leave the
 * implementation. Operations on one execution must be serialized by the host.
 * resume stops at the next effect/terminal boundary; it does not execute effects.
 */
export interface KernelExecution {
  resume(reply: KernelReply): Operation<KernelBoundary>;
  cancel(): Operation<KernelBoundary>;
  capture(): Operation<KernelSnapshot>;
  /** Release compute only. Idempotent; never runs logical cleanup. */
  dispose(): Operation<void>;
}

export interface KernelActivation {
  readonly execution: KernelExecution;
  readonly boundary: KernelBoundary;
}

/**
 * Instance-local evaluator. Operations may suspend for transport or scheduling.
 * Operation does not make synchronous Wasm interruptible: implementations must
 * bound each compute slice. Programs and snapshots require kernel-owned format
 * validation; unknown payloads are not permission to persist arbitrary objects.
 *
 * restore does not execute the prefix or issue external effects. cancel may
 * yield cleanup effects; repeated cancellation must not interrupt cleanup.
 * Captures must be detached and portable. Closed instances/executions reject use.
 */
export interface WorkflowKernel {
  readonly identity: KernelIdentity;
  start(program: WorkflowProgram, input: Json): Operation<KernelActivation>;
  restore(program: WorkflowProgram, snapshot: KernelSnapshot): Operation<KernelActivation>;
  /** Idempotently release all instance resources, without logical unwind. */
  close(): Operation<void>;
}

export class KernelCompatibilityError extends Error {
  readonly code = "kernel_incompatible";
}

/** Exact compatibility for the first increment; this is not a migration policy. */
export function assertKernelCompatibility(
  installed: KernelIdentity,
  program: WorkflowProgram,
  snapshot?: KernelSnapshot,
): void {
  const matches = (other: KernelIdentity) =>
    installed.kind === other.kind &&
    installed.version === other.version &&
    installed.programFormat === other.programFormat &&
    installed.snapshotFormat === other.snapshotFormat;
  if (!matches(program.kernel)) {
    throw new KernelCompatibilityError("Program requires a different kernel");
  }
  if (snapshot && (!matches(snapshot.kernel) || snapshot.programDigest !== program.digest)) {
    throw new KernelCompatibilityError("Snapshot does not match the pinned program and kernel");
  }
}
