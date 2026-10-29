import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation, Outcome } from "@standard-durability/core";

/** Exchange request data; the hosting journal supplies invocation correlation. */
export interface CapabilityRequest {
  /** Stable registered definition key; invocation identity belongs to the journal. */
  readonly effect: string;
  /** Caller schema input; normalized once during delivery. */
  readonly input: unknown;
}

/**
 * Immutable exchange declaration. It owns no runtime or scoped driver.
 * Context/response schemas remain caller-owned; their transformations run at delivery.
 * Calls return authored success/failure data. Exceptions remain delivery errors.
 * Without an inferred default, failure data is unknown.
 */
export interface EffectDefinition<
  Context = unknown,
  Response = unknown,
  CallerContext = Context,
  HandlerResponse = Response,
  Failure = unknown,
> {
  /** Immutable identity within a host assembly. */
  readonly id: string;
  /** Converts caller input to handler context at delivery. */
  readonly context: StandardSchemaV1<CallerContext, Context>;
  /** Optional transformation of successful handler values; failures bypass it. */
  readonly response?: StandardSchemaV1<HandlerResponse, Response>;
  /** Construct a Guest operation; advancing it requests delivery without executing a handler. */
  call(context: CallerContext): Operation<Outcome<Response, Failure>, CapabilityRequest>;
}
