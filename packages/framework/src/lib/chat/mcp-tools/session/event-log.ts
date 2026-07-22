/**
 * Tool session event log kernel.
 *
 * The shared in-memory machinery every ToolSession implementation needs:
 * monotonic LSN assignment, status derivation from event types, terminal
 * settlement, and replayable event streams. Runtime packages (in-process,
 * worker, remote facades) own transport and lifecycle; this kernel owns the
 * event-log semantics so they cannot drift.
 */
import { action, resource, type Operation, type Stream, type Subscription } from "effection";
import type { ToolSessionEvent, ToolSessionStatus } from "./types.ts";

export function isTerminalToolSessionStatus(status: ToolSessionStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled" || status === "orphaned"
  );
}

/**
 * The status a session transitions to when it emits `event`, or undefined for
 * no transition. Progress/log events only upgrade an initializing session;
 * they never demote an awaiting state.
 */
export function statusForToolSessionEvent(
  event: Pick<ToolSessionEvent, "type">,
  current: ToolSessionStatus,
): ToolSessionStatus | undefined {
  switch (event.type) {
    case "elicit_request":
      return "awaiting_elicit";
    case "sample_request":
      return "awaiting_sample";
    case "result":
      return "completed";
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "progress":
    case "log":
      return current === "initializing" ? "running" : undefined;
    default:
      return undefined;
  }
}

export interface ToolSessionEventLog<TResult = unknown> {
  /** Current session status. */
  readonly status: ToolSessionStatus;
  /** LSN of the most recently appended event. */
  readonly lastLsn: number;
  /** All appended events in LSN order. */
  readonly buffer: readonly ToolSessionEvent<TResult>[];
  /** Reserve the next LSN without appending (for correlating request ids). */
  peekNextLsn(): number;
  /**
   * Append an event: assigns LSN and timestamp, derives the status
   * transition, and wakes settled/stream waiters.
   */
  append(
    event: { type: ToolSessionEvent<TResult>["type"] } & Record<string, unknown>,
  ): ToolSessionEvent<TResult>;
  /** Explicit status transition (e.g. running after a respond). */
  setStatus(status: ToolSessionStatus): void;
  /** End the event stream. Live subscribers complete after draining. */
  close(): void;
  /** Resolves when the session reaches a terminal status; no timer polling. */
  settled(): Operation<ToolSessionStatus>;
  /**
   * Replayable event stream. Events with `lsn > afterLSN` are replayed from
   * the buffer, then the stream waits for live events until closed.
   */
  events(afterLSN?: number): Stream<ToolSessionEvent<TResult>, void>;
}

export function createToolSessionEventLog<TResult = unknown>(
  initialStatus: ToolSessionStatus = "initializing",
): ToolSessionEventLog<TResult> {
  let status: ToolSessionStatus = initialStatus;
  let lsn = 0;
  let closed = false;
  const buffer: ToolSessionEvent<TResult>[] = [];
  const settledWaiters = new Set<(status: ToolSessionStatus) => void>();
  const eventWaiters = new Set<() => void>();

  function notifyEventWaiters(): void {
    for (const resolve of eventWaiters) {
      resolve();
    }
    eventWaiters.clear();
  }

  function notifySettledIfTerminal(): void {
    if (!isTerminalToolSessionStatus(status)) {
      return;
    }
    for (const resolve of settledWaiters) {
      resolve(status);
    }
    settledWaiters.clear();
  }

  return {
    get status() {
      return status;
    },
    get lastLsn() {
      return lsn;
    },
    get buffer() {
      return buffer;
    },

    peekNextLsn() {
      return lsn + 1;
    },

    append(event) {
      const fullEvent = {
        ...event,
        lsn: ++lsn,
        timestamp: Date.now(),
      } as ToolSessionEvent<TResult>;
      buffer.push(fullEvent);
      const next = statusForToolSessionEvent(fullEvent, status);
      if (next !== undefined) {
        status = next;
        notifySettledIfTerminal();
      }
      notifyEventWaiters();
      return fullEvent;
    },

    setStatus(next) {
      status = next;
      notifySettledIfTerminal();
    },

    close() {
      closed = true;
      notifyEventWaiters();
    },

    *settled(): Operation<ToolSessionStatus> {
      return yield* action<ToolSessionStatus>((resolve) => {
        if (isTerminalToolSessionStatus(status)) {
          resolve(status);
        } else {
          settledWaiters.add(resolve);
        }
        return () => settledWaiters.delete(resolve);
      });
    },

    events(afterLSN?: number): Stream<ToolSessionEvent<TResult>, void> {
      return resource<Subscription<ToolSessionEvent<TResult>, void>>(function* (provide) {
        let deliveredThroughLSN = afterLSN ?? 0;

        yield* provide({
          *next(): Operation<IteratorResult<ToolSessionEvent<TResult>, void>> {
            while (true) {
              // The buffer is LSN-ordered, so the first event past the cursor
              // is the next one to deliver regardless of replay vs live.
              const nextEvent = buffer.find((event) => event.lsn > deliveredThroughLSN);
              if (nextEvent) {
                deliveredThroughLSN = nextEvent.lsn;
                return { done: false, value: nextEvent };
              }
              if (closed) {
                return { done: true, value: undefined };
              }
              yield* action<void>((resolve) => {
                eventWaiters.add(resolve);
                return () => eventWaiters.delete(resolve);
              });
            }
          },
        });
      });
    },
  };
}
