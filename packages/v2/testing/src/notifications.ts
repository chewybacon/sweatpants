import type { NotificationRig } from "./contracts.ts";

/** Simulate duplicate or dropped wakeups without changing authoritative storage. */
export function createNotificationRig(): NotificationRig {
  const published: string[] = [];
  const listeners = new Map<string, Set<AbortController>>();
  return {
    drop: false,
    get subscriptions() {
      return [...listeners.values()].reduce((sum, entries) => sum + entries.size, 0);
    },
    subscribe(key) {
      const controller = new AbortController();
      const entries = listeners.get(key) ?? new Set<AbortController>();
      listeners.set(key, entries);
      entries.add(controller);
      return {
        signal: controller.signal,
        close() {
          entries.delete(controller);
          if (!entries.size) {
            listeners.delete(key);
          }
        },
      };
    },
    published,
    driver(runtime) {
      const rig = this;
      return {
        *subscribe(grant) {
          const subscription = rig.subscribe(grant.attemptId);
          yield* runtime.composition.ensure(function* () {
            subscription.close();
          });
          return subscription.signal;
        },
        *publish(grant) {
          rig.publish(grant.attemptId);
        },
      };
    },
    publish(key) {
      published.push(key);
      if (!this.drop) {
        for (const controller of listeners.get(key) ?? []) {
          controller.abort(new Error("Attempt invalidated"));
        }
      }
    },
  };
}
