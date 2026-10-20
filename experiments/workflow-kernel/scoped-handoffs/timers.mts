import type { Operation } from "effection";
import { definePort } from "@sweatpants/foundation/port";
import type { WaitDescriptor } from "@sweatpants/durable-execution";

export const durableTimerUnavailable = {
  code: "durable_timer_not_implemented",
  message:
    "Durable workflow timers are not implemented: journal-accepted deadlines, shutdown-safe activation wakeups, and ordered timer settlements are required. An in-process timer is not a durable wakeup.",
} as const;

export class DurableTimerNotImplemented extends Error {
  readonly code = durableTimerUnavailable.code;
  constructor() {
    super(durableTimerUnavailable.message);
    this.name = "DurableTimerNotImplemented";
  }
}

/** Scoped authoring contract. No timer starts and no body runs in these stubs.
 * Durations are milliseconds; absolute deadlines are Unix epoch milliseconds.
 * Relative durations must resolve once at authority acceptance, never on restore.
 * Expiry must cancel/drain the body, including suspended cleanup, before throwing.
 * Guest/host destruction is disposal, not expiry or logical cancellation.
 */
export const scopedTimers = {
  *sleep(_durationMs: number): Operation<void> {
    throw new DurableTimerNotImplemented();
  },
  *timebox<T>(_durationMs: number, _body: () => Operation<T>): Operation<T> {
    throw new DurableTimerNotImplemented();
  },
  *deadline<T>(_atMs: number, _body: () => Operation<T>): Operation<T> {
    throw new DurableTimerNotImplemented();
  },
};

/** An already accepted wait; the authority resolves durationMs to notBefore.
 * Reuse the journal's wait vocabulary rather than introduce a second timer effect.
 */
export interface AcceptedTimerWakeup {
  readonly sessionId: string;
  readonly taskId: string;
  readonly pullId: string;
  readonly wait: Readonly<Omit<WaitDescriptor, "durationMs" | "notBefore"> & { notBefore: string }>;
}

/** Hosting edge, NOT a guest scheduler or authority settlement API.
 * No driver exists yet. A future driver must:
 * - durably arm an idempotent wakeup by accepted pull identity;
 * - survive destruction of the registering process and Wasm instance;
 * - wake an activation at/after notBefore, including overdue recovery;
 * - tolerate duplicate/late wakes, which recheck current journal truth;
 * - never settle effects, choose race winners, or receive closures/live handles.
 * The authority must reconcile accepted waits after a crash between acceptance
 * and arming, and record timer settlement delivery order through its normal path.
 * Disarming is idempotent; it is not proof of cancellation or removal of history.
 */
export const DurableTimerWakeupPort = definePort("durable-timer-wakeup", {
  *arm(_timer: AcceptedTimerWakeup): Operation<void> {
    throw new DurableTimerNotImplemented();
  },
  *disarm(_timer: AcceptedTimerWakeup): Operation<void> {
    throw new DurableTimerNotImplemented();
  },
});
