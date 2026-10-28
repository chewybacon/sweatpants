import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation, Outcome } from "@standard-durability/core";

export interface Latch<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export interface ProtocolRequest {
  readonly id: string;
  readonly token: string;
}

export interface ProtocolReply {
  readonly status: number;
  readonly body: string;
}

export interface ProtocolRig {
  readonly requests: readonly ProtocolRequest[];
  readonly aborted: readonly string[];
  send(request: ProtocolRequest, signal: AbortSignal): Promise<ProtocolReply>;
  waitForRequests(count: number): Promise<void>;
  reply(id: string, reply: ProtocolReply): void;
  fail(id: string, error: Error): void;
}

/** Scripted lossy notification transport; subscriptions are explicitly owned. */
export interface NotificationRig {
  drop: boolean;
  readonly subscriptions: number;
  subscribe(key: string): { readonly signal: AbortSignal; close(): void };
  publish(key: string): void;
}

/** Prototype request data; the hosting journal supplies invocation correlation. */
export interface CapabilityRequest {
  readonly effect: string;
  readonly input: unknown;
}

/**
 * Testing-only immutable exchange declaration. It owns no runtime or scoped driver.
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
  readonly id: string;
  readonly context: StandardSchemaV1<CallerContext, Context>;
  readonly response?: StandardSchemaV1<HandlerResponse, Response>;
  /** Construct a Guest operation; advancing it requests delivery without executing a handler. */
  call(context: CallerContext): Operation<Outcome<Response, Failure>, CapabilityRequest>;
}
