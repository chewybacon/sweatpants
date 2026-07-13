import type { Operation } from "effection";

import type { ActivationOutcome, CrankRuntime, CrankStore } from "./types.ts";

export type CrankRuntimeResolver = (
  sessionId: string,
) => Operation<CrankRuntime | undefined> | CrankRuntime | undefined;

/**
 * Drain one durable runnable snapshot. Hosts call this from their activation
 * worker and at startup. Duplicate calls are safe because each runtime claims a
 * fenced owner before executing.
 */
export function* drainRunnableCrankSessions(
  store: CrankStore,
  resolveRuntime: CrankRuntimeResolver,
): Operation<Array<{ sessionId: string; outcome: ActivationOutcome | "unavailable" }>> {
  const results: Array<{ sessionId: string; outcome: ActivationOutcome | "unavailable" }> = [];
  for (const sessionId of yield* store.runnableSessions()) {
    const resolved = resolveRuntime(sessionId);
    const runtime = isOperation(resolved) ? yield* resolved : resolved;
    if (!runtime) {
      results.push({ sessionId, outcome: "unavailable" });
      continue;
    }
    results.push({ sessionId, outcome: yield* runtime.activate(sessionId) });
  }
  return results;
}

function isOperation<T>(value: Operation<T> | T): value is Operation<T> {
  return Boolean(
    value && typeof value === "object" && typeof (value as { next?: unknown }).next === "function",
  );
}
