import type { GuestCommand, GuestResponse, GuestWork } from "@sweatpan.ts/execution";
import type { Runtime } from "@sweatpan.ts/runtime";

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

/** Serialized in-process execution peer, with deterministic response fault injection. */
export interface WorkerGuestRigOptions<R, Q, Y, V, E> {
  /** Simulate independent transport failure, including during native finalization. */
  readonly failure?: AbortSignal;
  readonly runtime: Runtime<Y>;
  readonly acquire: GuestWork<R, Q, Y, V, E>;
  /** Replace an outbound command to simulate stale/duplicate delivery. */
  readonly command?: (command: GuestCommand<V, E>) => GuestCommand<V, E>;
  /** Undefined drops the reply after execution; replacement simulates correlation faults. */
  readonly response?: (response: GuestResponse<R, Q>) => GuestResponse<R, Q> | undefined;
}

/** MessageChannel uses V8 bytes; no live continuation or callback crosses the port. */
export interface WorkerGuestRig<R, Q, Y, V, E> {
  readonly acquire: GuestWork<R, Q, Y, V, E>;
  readonly commands: readonly GuestCommand<V, E>[];
  readonly responses: readonly GuestResponse<R, Q>[];
  readonly terminations: number;
  /** Inject a malformed peer command; resolves after the server receives the bytes. */
  inject(command: GuestCommand<V, E>): Promise<void>;
  /** Join every simulated remote scope. */
  close(): Promise<void>;
}

/** Experimental two-peer request/reply fixture, not a production RPC capability. */
export interface DuplexExchangeRigOptions<L, LR, R, RR> {
  left(request: L, signal: AbortSignal): Promise<LR>;
  right(request: R, signal: AbortSignal): Promise<RR>;
  /** False discards a response after its handler completed; owner must close to abandon it. */
  deliver?(from: "left" | "right", response: unknown): boolean;
}

/** V8-encoded MessageChannel: either peer can request while its own reply is outstanding. */
export interface DuplexExchangeRig<L, LR, R, RR> {
  left: { exchange(request: R): Promise<RR>; readonly pending: number };
  right: { exchange(request: L): Promise<LR>; readonly pending: number };
  readonly requests: readonly { from: "left" | "right"; id: number; value: unknown }[];
  /** Abort both handlers, reject outstanding exchanges, close ports, and join handlers. */
  close(): Promise<void>;
}
