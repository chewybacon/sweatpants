import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ToolDefinition, JournalRequest } from "@sweatpants/agent-sdk";
import type { Json } from "@sweatpants/foundation/json";
import type { GuestWork, Outcome, Work } from "@sweatpants/foundation/computation";

/** Placement acquires computation; the host owns interpretation and acceptance. */
export interface PreparedToolExecution<Y = never> {
  readonly guests?: ReadonlyMap<
    string,
    (input: Json, callId: string) => GuestWork<Outcome<Json, Json>, JournalRequest, Y, Json, Json>
  >;
  readonly setup?: Work<void, Y>;
}

/** Preparation validates routes without acquiring live resources. */
export interface ToolRegistryAdapter<T = ToolDefinition, Y = never> {
  prepare(tools: readonly T[], routeId: string): PreparedToolExecution<Y>;
}

/** One definition retains its concrete parameter and completion types through acquisition. */
export interface PreparedToolInvocation<P extends StandardSchemaV1, Result, Y> {
  readonly setup?: Work<void, Y>;
  guest(
    input: StandardSchemaV1.InferInput<P>,
    callId: string,
  ): GuestWork<Result, JournalRequest, Y, Json, Json>;
}

/** Concrete placement; registry erasure is a separate admission capability. */
export interface ToolExecutionAdapter<Y = never> {
  /** Concrete preparation capability; retained registry-only adapters omit it. */
  readonly singleTool: true;
  prepare<P extends StandardSchemaV1, Result>(
    tool: ToolDefinition<P, Result>,
    routeId: string,
  ): PreparedToolInvocation<P, Result, Y>;
}
