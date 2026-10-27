import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ApiDefinition, OperationDefinition, OperationDefinitions } from "./contracts.ts";

/** Immutable metadata, not a runtime binding. Schema implementations remain caller-owned. */
export function defineOperation<
  I extends StandardSchemaV1,
  S extends StandardSchemaV1,
  F extends StandardSchemaV1,
>(definition: OperationDefinition<I, S, F>): OperationDefinition<I, S, F> {
  if (!definition.version.trim()) {
    throw new Error("Operation version is required");
  }
  return Object.freeze({ ...definition });
}
export function defineApi<const D extends OperationDefinitions>(
  id: string,
  operations: D,
): ApiDefinition<D> {
  if (!id.trim() || Object.keys(operations).length === 0) {
    throw new Error("API identity and operations are required");
  }
  return Object.freeze({ id, operations: Object.freeze({ ...operations }) });
}
