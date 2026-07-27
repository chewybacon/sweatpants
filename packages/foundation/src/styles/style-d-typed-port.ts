/**
 * Style D — typed port, plain adapters, non-bypassable seam.
 *
 * Synthesis of the three:
 *   - A: no Context is exported, so there is no way to reach a driver directly.
 *   - B: the port is declared once and everything else is derived and typed.
 *   - C: adapters stay ordinary objects and call sites read like plain methods.
 *
 * The port declaration doubles as the contract, the runtime key list, and the
 * fail-closed behavior when nothing is installed.
 */
import type { Operation } from "effection";
import { definePort } from "../port.ts";

export interface ExecutionRecord {
  readonly executionId: string;
  readonly payload: string;
}

export type CommitResult =
  | { readonly status: "accepted"; readonly revision: number }
  | { readonly status: "conflict"; readonly actualRevision: number | null };

export class StoreUnavailable extends Error {
  readonly code = "store_unavailable";
  constructor(port: string) {
    super(`No driver is installed for ${port}`);
    this.name = "StoreUnavailable";
  }
}

function unavailable(): never {
  throw new StoreUnavailable("style-d-execution-store");
}

/**
 * The port can be declared interface-first when the contract is a published
 * artifact. The stub object is then checked *against* the interface, and the
 * exported value is `Api<ExecutionStoreDeclared>` exactly like Style B.
 */
export interface ExecutionStoreDeclared {
  load(executionId: string): Operation<ExecutionRecord | null>;
  commit(record: ExecutionRecord, expectedRevision: number | null): Operation<CommitResult>;
}

/** One declaration: contract, keys, and fail-closed default. */
export const ExecutionStorePortD = definePort<ExecutionStoreDeclared>("style-d-execution-store", {
  *load(_executionId: string): Operation<ExecutionRecord | null> {
    return unavailable();
  },
  *commit(_record: ExecutionRecord, _expectedRevision: number | null): Operation<CommitResult> {
    return unavailable();
  },
});

/** Adapters implement the declared interface; no facade, no Context. */
export type ExecutionStoreD = ExecutionStoreDeclared;

export const StoreApiD = ExecutionStorePortD.api;

/** Writing a driver in Style D: an ordinary object, exactly like B and C. */
export function createMemoryDriverD(): ExecutionStoreD {
  const records = new Map<string, { revision: number; record: ExecutionRecord }>();
  return {
    *load(executionId: string) {
      return records.get(executionId)?.record ?? null;
    },
    *commit(record: ExecutionRecord, expectedRevision: number | null) {
      const current = records.get(record.executionId) ?? null;
      const actualRevision = current?.revision ?? null;
      if (actualRevision !== expectedRevision) {
        return { status: "conflict" as const, actualRevision };
      }
      const revision = (actualRevision ?? -1) + 1;
      records.set(record.executionId, { revision, record });
      return { status: "accepted" as const, revision };
    },
  };
}

export function* installMemoryDriverD(): Operation<void> {
  yield* ExecutionStorePortD.installDriver(createMemoryDriverD());
}

/**
 * Compile-time evidence that the declaration is checked against the interface:
 * uncomment either line and `tsc` fails.
 */
// definePort<ExecutionStoreDeclared>("bad-arity", { *load(): Operation<null> { return null; } });
// definePort<ExecutionStoreDeclared>("bad-shape", { *load(id: string): Operation<string> { return id; }, *commit(): Operation<CommitResult> { return unavailable(); } });
