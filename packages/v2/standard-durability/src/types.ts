import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Outcome } from "./contracts.ts";

// Retained schema-definition prototype; not part of the public composition API.
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
