import type { Operation } from "effection";
import type { Execution, ExecutionBoundary, Executor, Json } from "@sweatpants/foundation";

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

export interface KernelRequest {
  readonly site: string;
  readonly request: Json;
}

export type KernelBoundary = ExecutionBoundary<KernelRequest, Json, Json>;

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
 * Bound, live execution. Private JS/Wasm handles never leave the
 * implementation. Operations on one execution must be serialized by the host.
 * resume stops at the next effect/terminal boundary; it does not execute effects.
 */
export interface KernelExecution extends Execution<KernelRequest, KernelReply, Json, Json> {
  capture(): Operation<KernelSnapshot>;
}

/** Execution/boundary pair with capture on the handle; no separate lifecycle. */
export interface KernelExecutionState {
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
export interface WorkflowKernel extends Executor<
  WorkflowProgram,
  Json,
  KernelRequest,
  KernelReply,
  Json,
  Json
> {
  readonly identity: KernelIdentity;
  start(program: WorkflowProgram, input: Json): Operation<KernelExecutionState>;
  restore(program: WorkflowProgram, snapshot: KernelSnapshot): Operation<KernelExecutionState>;
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

export { createKernelExecution, KernelExecutor } from "./execution.ts";

export type {
  ExecutionInspection,
  InspectedBoundary,
  InspectedCall,
  InspectedEnvironment,
  InspectedBinding,
  InspectedValue,
  InspectedUnwind,
  PendingCompletion,
} from "./inspection.ts";

export type {
  CompiledWorkflow,
  WorkflowCompiler,
  WorkflowImplementation,
  WorkflowSource,
  WorkflowSourceValidator,
  WorkflowBinding,
  WorkflowLinker,
  WorkflowRuntime,
} from "./authoring.ts";
