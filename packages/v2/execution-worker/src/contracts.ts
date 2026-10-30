import type { Guest } from "@sweatpan.ts/execution";
import type { Operation } from "@standard-durability/core";

/** Explicit, matching representation on both sides; must preserve all application values. */
export interface GuestWireCodec {
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
}

/** Dedicated MessagePort-like channel. Assembly owns worker creation and termination. */
export interface GuestMessagePort {
  postMessage(value: Uint8Array): void;
  addEventListener(type: "message" | "messageerror", listener: (event: unknown) => void): void;
  removeEventListener(type: "message" | "messageerror", listener: (event: unknown) => void): void;
  start(): void;
  close(): void;
}

/** One sequential remote incarnation; never shared by independent proxies. */
export interface WorkerGuestOptions {
  readonly incarnation: string;
  readonly port: GuestMessagePort;
  readonly codec: GuestWireCodec;
  /** Assembly-owned disconnect/deadline signal, independent of native scope cancellation.
   * Must also fire when disposal acknowledgement is abandoned. */
  readonly failure: AbortSignal;
  /** Force physical shutdown and join remote resources, even after lost communication. */
  terminate(): Promise<void>;
}

/** Worker assembly acquires inside the server scope, preserving evaluator resources. */
export interface GuestWorkerOptions<R, Q, Y, V, E> {
  readonly incarnation: string;
  readonly port: GuestMessagePort;
  readonly codec: GuestWireCodec;
  acquire(): Operation<Guest<R, Q, Y, V, E>, Y>;
}
