import type { Guest, GuestWork, CheckpointAdapter } from "@sweatpan.ts/execution";
import type { Operation } from "@standard-durability/core";
import type { Transport, WireCodec } from "@sweatpan.ts/connection";

/** One sequential remote incarnation; never shared by independent proxies. */
export interface WorkerGuestOptions {
  readonly incarnation: string;
  readonly port: Transport;
  readonly codec: WireCodec;
  /** Assembly-owned disconnect/deadline signal, independent of native scope cancellation.
   * Must also fire when disposal acknowledgement is abandoned. */
  readonly failure: AbortSignal;
  /** Force physical shutdown and join remote resources, even after lost communication. */
  terminate(): Promise<void>;
}

/** Worker assembly acquires inside the server scope, preserving evaluator resources. */
export interface GuestWorkerOptions<R, Q, Y, V, E> {
  readonly incarnation: string;
  readonly port: Transport;
  readonly codec: WireCodec;
  acquire(): Operation<Guest<R, Q, Y, V, E>, Y>;
  /** Evaluator-owned snapshot capability; format is checked before capture/restore. */
  readonly checkpoints?: CheckpointAdapter<R, Q, Y, V, E, unknown>;
}

/** Placement opens a fresh pinned incarnation for acquisition or checkpoint restoration. */
export interface WorkerExecutionOptions<Y> {
  readonly checkpointFormat: string;
  open(): Operation<WorkerGuestOptions, Y>;
}

/** Ordinary recovery capabilities implemented through the serialized Guest protocol. */
export interface WorkerExecution<R, Q, Y, V, E> {
  readonly acquire: GuestWork<R, Q, Y, V, E>;
  readonly checkpoints: CheckpointAdapter<R, Q, Y, V, E, unknown>;
}

/** In-process placement uses the same byte protocol and independent evaluator scope as a worker. */
export interface LocalExecutionOptions<R, Q, Y, V, E> {
  readonly codec: WireCodec;
  readonly acquire: GuestWork<R, Q, Y, V, E>;
  readonly checkpoints?: CheckpointAdapter<R, Q, Y, V, E, unknown>;
}

/** Default local hosted assembly; checkpoint support is explicit evaluator capability. */
export interface LocalExecution<R, Q, Y, V, E> {
  readonly acquire: GuestWork<R, Q, Y, V, E>;
  readonly checkpoints: CheckpointAdapter<R, Q, Y, V, E, unknown> | undefined;
}
