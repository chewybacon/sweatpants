import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation, Outcome } from "@standard-durability/core";
import type { CapabilityRequest, EffectDefinition } from "./contracts.ts";
type Success<R> = R extends { readonly ok: true; readonly value: infer V } ? V : never;
type Failure<R> = R extends { readonly ok: false; readonly error: infer E } ? E : never;
type EffectImplementation<C, R, Y> = (context: C) => Operation<R, Y>;

type Input<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S>;
type Output<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>;

/**
 * Define an exchange without constructing a runtime, registry or scoped API.
 * Handlers return Outcome; exceptions are delivery errors. A response schema transforms
 * only success values. Default implementations infer both success and failure types.
 * Schema-only declarations have unknown failure data until the author narrows it.
 * Default implementations retain their yielded protocol; only compatible hosts may
 * install them. Schemas and closure dependencies are not cloned or deep-frozen.
 */
export function defineEffect<S extends StandardSchemaV1, O extends StandardSchemaV1>(declaration: {
  key: string;
  context: S;
  response: O;
}): EffectDefinition<Output<S>, Output<O>, Input<S>, Input<O>>;
export function defineEffect<
  S extends StandardSchemaV1,
  O extends StandardSchemaV1,
  R extends Outcome<Input<O>, unknown>,
  Y,
>(
  declaration: { key: string; context: S; response: O },
  implementation: EffectImplementation<Output<S>, R, Y>,
): EffectDefinition<Output<S>, Output<O>, Input<S>, Input<O>, Failure<R>> & {
  readonly implementation: EffectImplementation<Output<S>, R, Y>;
};
export function defineEffect<S extends StandardSchemaV1, R extends Outcome<unknown, unknown>, Y>(
  declaration: { key: string; context: S },
  implementation: EffectImplementation<Output<S>, R, Y>,
): EffectDefinition<Output<S>, Success<R>, Input<S>, Success<R>, Failure<R>> & {
  readonly implementation: EffectImplementation<Output<S>, R, Y>;
};
export function defineEffect(
  declaration: { key: string; context: StandardSchemaV1; response?: StandardSchemaV1 },
  implementation?: EffectImplementation<never, unknown, unknown>,
): EffectDefinition {
  const { key, context, response } = declaration;
  if (!key.trim() || key === "$record") {
    throw new Error("Empty or reserved effect key");
  }
  return Object.freeze({
    id: key,
    context,
    response,
    implementation,
    *call(context: unknown): Operation<Outcome<unknown, unknown>, CapabilityRequest> {
      // This call owns the correlation between its suspension and its accepted reply.
      return (yield { effect: key, input: context }) as Outcome<unknown, unknown>;
    },
  });
}
