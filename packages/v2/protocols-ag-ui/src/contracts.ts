import type {
  CustomEvent,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
} from "@ag-ui/core";
import type { Operation } from "@standard-durability/core";
import type { Stream } from "@sweatpan.ts/runtime";

/** Supported run/text/custom projection subset, not the complete AG-UI protocol. */
export type AgUiRunEvent<V> =
  | RunStartedEvent
  | RunFinishedEvent
  | (TextMessageStartEvent & { role: "assistant" })
  | TextMessageContentEvent
  | TextMessageEndEvent
  | (Omit<CustomEvent, "value"> & { value: V })
  | RunErrorEvent;

/** Host-selected public projection. Never send private journal/provider data blindly.
 * Publications after execution ends are ignored. Custom values must be cloneable. */
export interface AgUiRunPublisher<V> {
  /** Cumulative provisional text. A non-prefix replacement opens a new message. */
  text(snapshot: string): void;
  endText(): void;
  custom(name: string, value: V): void;
}
export interface AgUiRunOptions<R, V, Y> {
  readonly threadId: string;
  /** Optional externally assigned attempt identity; generated on execution otherwise. */
  readonly runId?: string;
  /** Public-safe failure text; the original error still propagates to the owner. */
  readonly errorMessage: string;
  execute(publish: AgUiRunPublisher<V>): Operation<R, Y>;
}
export interface AgUiRun<R, V, Y> {
  /** Explicit, single-use producer. Caller owns cancellation and joins cleanup.
   * Finished denotes this attempt, which may leave a durable turn parked. */
  run(signal?: AbortSignal): Operation<R, Y>;
  /** Independent readers over this object's in-memory retained events. Offsets are
   * attempt-local, not durable cursors. Reading never starts or cancels production.
   * Retention lasts until the object is released; bound attempt length in the host. */
  events(offset?: number): Stream<AgUiRunEvent<V>, void, Y>;
}
