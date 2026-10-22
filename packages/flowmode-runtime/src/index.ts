import type { WorkflowInspection } from "./inspection.ts";
import type { Operation } from "effection";
import type {
  CheckpointExecution,
  ExecutionState,
  ExecutionBoundary,
  Executor,
  Exchange,
  Flow,
  Json,
} from "@sweatpants/foundation";

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
  readonly code: Json;
}

export interface ExchangeRequest {
  readonly site: string;
  readonly binding: string;
  readonly input: Json;
}

export type WorkflowExchange = Exchange<ExchangeRequest, ExchangeReply>;
export type WorkflowFlow = Flow<Json, Json, ExchangeRequest, ExchangeReply>;

export type WorkflowBoundary = ExecutionBoundary<ExchangeRequest, Json, Json>;

export type ExchangeReply =
  | { readonly kind: "value"; readonly value: Json }
  | { readonly kind: "throw"; readonly value: Json };

/** Kernel-owned state. Journal cursor/receipt authority belongs to the host envelope. */
export interface KernelSnapshot {
  readonly kernel: KernelIdentity;
  readonly programDigest: string;
  readonly state: Json;
}

/**
 * Bound, live execution. Private JS/Wasm handles never leave the
 * implementation. Operations on one execution must be serialized by the host.
 * resume stops at the next effect/terminal boundary; it does not execute effects.
 */
export interface WorkflowExecution extends CheckpointExecution<
  ExchangeRequest,
  ExchangeReply,
  Json,
  Json,
  KernelSnapshot
> {
  /** Optional, detached diagnostics; never a recovery capability. */
  inspect?(): Operation<WorkflowInspection>;
}

export type WorkflowExecutionState = ExecutionState<WorkflowExecution, WorkflowBoundary>;

/**
 * Instance-local evaluator. Operations may suspend for transport or scheduling.
 * Operation does not make synchronous Wasm interruptible: implementations must
 * bound each compute slice. Programs and snapshots require kernel-owned format
 * validation; JSON payloads are not permission to bypass target format checks.
 *
 * restore does not execute the prefix or issue external effects. cancel may
 * yield cleanup effects; repeated cancellation must not interrupt cleanup.
 * Captures must be detached and portable. Closed instances/executions reject use.
 */
export interface WorkflowKernel extends Executor<
  WorkflowProgram,
  Json,
  ExchangeRequest,
  ExchangeReply,
  Json,
  Json
> {
  readonly identity: KernelIdentity;
  start(program: WorkflowProgram, input: Json): Operation<WorkflowExecutionState>;
  restore(program: WorkflowProgram, snapshot: KernelSnapshot): Operation<WorkflowExecutionState>;
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

export {
  createKernelExecution,
  KernelExecutor,
  type WorkflowExecutionDriver,
  type WorkflowExecutionOptions,
} from "./execution.ts";
export { createWorkflowFlow, WorkflowFailure } from "./flow.ts";

export type {
  WorkflowInspection,
  ExecutionInspection,
  InspectedBoundary,
  InspectedCall,
  InspectedEnvironment,
  InspectedBinding,
  InspectedValue,
  InspectedUnwind,
  PendingCompletion,
} from "./inspection.ts";

export type * from "./authoring.ts";
export { assertWorkflowLink, requireCompiledWorkflow } from "./link.ts";

export { createWorkflowGuidance } from "./guidance.ts";
export * from "./composition.ts";
export { registerCompiledWorkflows, getCompiledWorkflow } from "./compiled-tool.ts";

export { decodeExchange } from "./exchange-codec.ts";
