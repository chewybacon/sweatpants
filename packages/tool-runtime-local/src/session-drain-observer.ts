import { action, type Operation } from "effection";
import { ToolSessionStoreApi } from "./session-store-port.ts";

export interface ToolSessionDrainObserver {
  /** Event-driven wait until every observed session has been removed. */
  drained(): Operation<void>;
  /** Session IDs currently held by the observed store. */
  sessionIds(): readonly string[];
}

/**
 * Installs observation-only middleware that tracks tool session lifetime.
 *
 * Registry cleanup after release is settlement-driven, so tests synchronize on
 * removal rather than sampling storage. This adds no method to the store type
 * and changes no accepted result.
 */
export function* observeToolSessionDrain(): Operation<ToolSessionDrainObserver> {
  const live = new Set<string>();
  const waiters = new Set<() => void>();

  function notify(): void {
    if (live.size > 0) {
      return;
    }
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      waiter();
    }
  }

  yield* ToolSessionStoreApi.around({
    *set([sessionId, entry], next) {
      live.add(sessionId);
      return yield* next(sessionId, entry);
    },
    *delete([sessionId], next) {
      const result = yield* next(sessionId);
      live.delete(sessionId);
      notify();
      return result;
    },
  });

  return {
    drained(): Operation<void> {
      return action<void>((resolve) => {
        if (live.size === 0) {
          resolve();
          return () => {};
        }
        waiters.add(resolve);
        return () => {
          waiters.delete(resolve);
        };
      });
    },
    sessionIds: () => [...live],
  };
}
