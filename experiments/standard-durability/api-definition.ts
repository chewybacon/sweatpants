import type { StandardSchemaV1 } from "@standard-schema/spec";

export type Outcome<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface OperationDefinition<
  Input extends StandardSchemaV1,
  Success extends StandardSchemaV1,
  Failure extends StandardSchemaV1,
> {
  readonly input: Input;
  readonly success: Success;
  readonly failure: Failure;
  readonly version: string;
  readonly retrySafety: "repeatable" | "unsafe";
}
export type AnyOperation = OperationDefinition<
  StandardSchemaV1,
  StandardSchemaV1,
  StandardSchemaV1
>;
export type OperationDefinitions = Readonly<Record<string, AnyOperation>>;
export interface ApiDefinition<D extends OperationDefinitions> {
  readonly id: string;
  readonly operations: D;
}
export type InputOf<D extends AnyOperation> = StandardSchemaV1.InferInput<D["input"]>;
export type ProviderInputOf<D extends AnyOperation> = StandardSchemaV1.InferOutput<D["input"]>;
export type OutcomeOf<D extends AnyOperation> = Outcome<
  StandardSchemaV1.InferOutput<D["success"]>,
  StandardSchemaV1.InferOutput<D["failure"]>
>;
export type Signature<D extends OperationDefinitions> = {
  [K in keyof D]: (input: ProviderInputOf<D[K]>) => OutcomeOf<D[K]>;
};

/** Immutable metadata, not a runtime binding. Schema implementations remain caller-owned. */
export function operation<
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
