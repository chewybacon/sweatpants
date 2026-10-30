import type { Operation } from "@standard-durability/core";

/** Ordered byte transport. Assembly supplies disconnect detection and owns remote resources. */
export interface Transport {
  /** Send one complete encoded frame, preserving order; throw on known send failure. */
  postMessage(value: Uint8Array): void;
  /** Message events expose bytes as event.data; messageerror denotes transport failure. */
  addEventListener(type: "message" | "messageerror", listener: (event: unknown) => void): void;
  /** Remove the same callback identity previously registered. */
  removeEventListener(type: "message" | "messageerror", listener: (event: unknown) => void): void;
  /** Begin delivery of buffered/new messages after listeners have been registered. */
  start(): void;
  /** Idempotently release this local endpoint; remote shutdown is assembly-owned. */
  close(): void;
}

/** Matching representation at both endpoints; application values must survive encoding. */
export interface WireCodec {
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
}

/** One response obligation. These local methods never cross the transport. */
export interface IncomingExchange<Y> {
  readonly value: unknown;
  /** Publish one successful transport reply; authored failure Outcomes remain ordinary values. */
  respond(value: unknown): Operation<void, Y>;
  /** Publish a delivery diagnostic, not an authored failure Outcome. */
  reject(message: string): Operation<void, Y>;
}

/** Scope-owned physical conversation. Payload validation belongs to the application protocol. */
export interface Connection<Y> {
  /** Wait for a correlated reply while continuing to admit reverse requests. No automatic retry. */
  exchange(value: unknown): Operation<unknown, Y>;
  /** One consumer at a time. The consumer owns scheduling and replying to each received request. */
  receive(): Operation<IncomingExchange<Y>, Y>;
  /** Retained failure notification, including explicit close. May interrupt consumer-owned work. */
  readonly failure: AbortSignal;
  /** Close locally and reject pending replies. Does not join remote resources or consumer tasks. */
  close(): void;
}

/** Fresh transport per connection. No journal, authority, handler or timeout policy is installed. */
export interface ConnectionOptions {
  readonly transport: Transport;
  readonly codec: WireCodec;
  /** Independent assembly failure/deadline signal; remains effective during scope finalization. */
  readonly failure: AbortSignal;
  /** Maximum incoming requests awaiting replies, including queued requests. Zero rejects all incoming calls; overflow fails closed. */
  readonly maxIncoming?: number;
}
