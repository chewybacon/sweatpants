/**
 * Style B — plain driver interface plus a derived facade.
 *
 * Adapters stay ordinary objects, and the delegating API is generated from a
 * method list instead of being hand written method for method.
 */
import { createContext, type Context, type Operation } from "effection";
import { createApi } from "effection/experimental";
import type { Api } from "effection";

export interface ExecutionRecord {
  readonly executionId: string;
  readonly payload: string;
}

export type CommitResult =
  | { readonly status: "accepted"; readonly revision: number }
  | { readonly status: "conflict"; readonly actualRevision: number | null };

/** The port adapters implement. One declaration of the contract. */
export interface ExecutionStoreB {
  load(executionId: string): Operation<ExecutionRecord | null>;
  commit(record: ExecutionRecord, expectedRevision: number | null): Operation<CommitResult>;
}

export class StoreUnavailable extends Error {
  readonly code = "store_unavailable";
  constructor() {
    super("No execution store driver is installed");
    this.name = "StoreUnavailable";
  }
}

type DriverShape = { readonly [method: string]: (...args: never[]) => Operation<unknown> };

type DriverLike<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => Operation<unknown> ? T[K] : never;
};

/**
 * Derives a delegating dynamic API for any scope-installed driver interface.
 * The method list is the only repetition, and it is checked against the type.
 */
export function createDriverApi<T extends DriverLike<T>>(
  name: string,
  context: Context<T | undefined>,
  methods: readonly (keyof T & string)[],
): Api<T> {
  const core = Object.fromEntries(
    methods.map((method) => [
      method,
      function* (...args: never[]): Operation<unknown> {
        const driver = yield* context.get();
        if (!driver) {
          throw new StoreUnavailable();
        }
        const implementation = (driver as unknown as DriverShape)[method]!;
        return yield* implementation(...args);
      },
    ]),
  );
  // SAFETY: core is built from T's own method names and forwards arguments and
  // results unchanged, so it satisfies T structurally.
  return createApi(name, core as unknown as T);
}

export const StoreContextB = createContext<ExecutionStoreB | undefined>(
  "style-b-execution-store",
  undefined,
);

export const StoreApiB = createDriverApi<ExecutionStoreB>(
  "style-b-execution-store",
  StoreContextB,
  ["load", "commit"],
);

/** Writing a driver in Style B: an ordinary object implementing the interface. */
export function createMemoryDriverB(): ExecutionStoreB {
  const records = new Map<string, { revision: number; record: ExecutionRecord }>();
  return {
    *load(executionId) {
      return records.get(executionId)?.record ?? null;
    },
    *commit(record, expectedRevision) {
      const current = records.get(record.executionId) ?? null;
      const actualRevision = current?.revision ?? null;
      if (actualRevision !== expectedRevision) {
        return { status: "conflict", actualRevision };
      }
      const revision = (actualRevision ?? -1) + 1;
      records.set(record.executionId, { revision, record });
      return { status: "accepted", revision };
    },
  };
}

export function* installMemoryDriverB(): Operation<void> {
  yield* StoreContextB.set(createMemoryDriverB());
}
