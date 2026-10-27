import type { Computation, Operation, Outcome, Runtime, RuntimeType } from "@sweatpan.ts/runtime";

export type ReadOutcome = Outcome<{ body: string }, { status: number }>;

/** The same native-computation signature is implemented by both stack adapters. */
export interface Repository<F extends RuntimeType, R = never> {
  read(id: string, token: string): Computation<F, ReadOutcome, never, R>;
}

/** The portable workflow only requires an iterable computation. */
export interface RepositoryOperations<Y> {
  read(id: string, token: string): Operation<ReadOutcome, Y>;
}

export function createApplication<Y>(runtime: Runtime<Y>) {
  const { composition } = runtime;
  const token = composition.createContext<string>("acceptance/token");
  const repository = composition.createApi<{ read(id: string): ReadOutcome }>(
    "acceptance/repository",
    {
      *read() {
        throw new Error("Repository driver missing");
      },
    },
  );
  return {
    token,
    repository,
    *install(client: RepositoryOperations<Y>) {
      yield* token.set("root");
      yield* repository.install({
        *read(id) {
          const credential = yield* token.expect();
          return yield* client.read(id, credential);
        },
      });
    },
    *readPair() {
      return yield* runtime.all([
        () => repository.operations.read("first"),
        () => repository.operations.read("second"),
      ]);
    },
  };
}
