import type { StandardA2ATelemetryEvent } from "./standard-a2a-host.ts";

export interface StandardA2AMetricsSnapshot {
  readonly requests: number;
  readonly errors: number;
  readonly states: Readonly<Record<string, number>>;
  readonly actions: Readonly<Record<string, number>>;
  readonly errorCodes: Readonly<Record<string, number>>;
}

/** Bounded, body-free metrics sink suitable for createStandardA2AHost.onTelemetry. */
export function createStandardA2AMetrics(): {
  readonly observe: (event: StandardA2ATelemetryEvent) => void;
  readonly snapshot: () => StandardA2AMetricsSnapshot;
} {
  let requests = 0;
  let errors = 0;
  const states = new Map<string, number>();
  const actions = new Map<string, number>();
  const errorCodes = new Map<string, number>();
  const increment = (map: Map<string, number>, key: string) => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  return Object.freeze({
    observe(event) {
      if (event.type === "request") {
        requests += 1;
      }
      if (event.type === "error") {
        errors += 1;
      }
      if (event.state) {
        increment(states, event.state);
      }
      if (event.action) {
        increment(actions, event.action);
      }
      if (event.code) {
        increment(errorCodes, event.code);
      }
    },
    snapshot() {
      return Object.freeze({
        requests,
        errors,
        states: Object.freeze(Object.fromEntries(states)),
        actions: Object.freeze(Object.fromEntries(actions)),
        errorCodes: Object.freeze(Object.fromEntries(errorCodes)),
      });
    },
  });
}
