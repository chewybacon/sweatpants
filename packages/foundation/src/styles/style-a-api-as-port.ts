/**
 * Style A — the Api *is* the port.
 *
 * There is no separate driver interface and no facade. The API core defines the
 * only shape, and a driver is installed as terminal middleware that answers
 * without delegating to `next`.
 */
import type { Operation } from "effection";
import { createApi } from "effection/experimental";

export interface ExecutionRecord {
  readonly executionId: string;
  readonly payload: string;
}

export type CommitResult =
  | { readonly status: "accepted"; readonly revision: number }
  | { readonly status: "conflict"; readonly actualRevision: number | null };

export class StoreUnavailable extends Error {
  readonly code = "store_unavailable";
  constructor() {
    super("No execution store driver is installed");
    this.name = "StoreUnavailable";
  }
}

function unavailable(): never {
  throw new StoreUnavailable();
}

/** One declaration: the port, the call site, and the middleware seam. */
export const StoreApiA = createApi("style-a-execution-store", {
  *load(_executionId: string): Operation<ExecutionRecord | null> {
    return unavailable();
  },
  *commit(_record: ExecutionRecord, _expectedRevision: number | null): Operation<CommitResult> {
    return unavailable();
  },
});

/**
 * Writing a driver in Style A: implement the same operations as middleware and
 * never call `next`.
 *
 * The driver installs at `min` so it is the innermost link. Observation and
 * policy middleware install at the default `max` and therefore surround it
 * regardless of installation order.
 */
export function* installMemoryDriverA(): Operation<void> {
  const records = new Map<string, { revision: number; record: ExecutionRecord }>();

  yield* StoreApiA.around(
    {
      *load([executionId]) {
        return records.get(executionId)?.record ?? null;
      },
      *commit([record, expectedRevision]) {
        const current = records.get(record.executionId) ?? null;
        const actualRevision = current?.revision ?? null;
        if (actualRevision !== expectedRevision) {
          return { status: "conflict" as const, actualRevision };
        }
        const revision = (actualRevision ?? -1) + 1;
        records.set(record.executionId, { revision, record });
        return { status: "accepted" as const, revision };
      },
    },
    { at: "min" },
  );
}
