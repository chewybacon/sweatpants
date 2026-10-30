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

/** Controlled child computation. Its host supplies a fresh child-owned context. */
export type Branch<C, Y, R = unknown> = (context: C) => Operation<R, Y>;

/** Ordered durable child computations, reconstructed through their parent on recovery. */
export interface All<C, Y> {
  /**
   * Run factories as owned children and return results in declaration order.
   * Empty calls return locally. Returned failure Outcomes remain data. Captures must
   * be reproducible by parent replay; shared mutable captures are not supported.
   * Each factory must use its supplied child context for scope and local capabilities.
   */
  <const B extends readonly Branch<C, Y>[]>(
    ...branches: B
  ): Operation<
    {
      -readonly [K in keyof B]: B[K] extends Branch<C, Y, infer R> ? R : never;
    },
    CapabilityRequest
  >;
}

/** Nonempty owned race; first terminal completion wins, then loser cleanup is joined. */
export interface Race<C, Y> {
  /** Returned failure Outcomes can win. Delivery exceptions remain unsettled. */
  <const B extends readonly [Branch<C, Y>, ...Branch<C, Y>[]]>(
    ...branches: B
  ): Operation<B[number] extends Branch<C, Y, infer R> ? R : never, CapabilityRequest>;
}
