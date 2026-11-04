import { decorateFunction, type Decorator } from "@standard-durability/core";
import type { SqliteConnection } from "@sweatpan.ts/storage-sqlite";
import type { SqliteDecorators } from "../../examples/scoped-sqlite.ts";

export const invalidAsyncLayer: SqliteDecorators = {
  // @ts-expect-error SQL run returns its changes synchronously.
  run:
    (next) =>
    async (...args) =>
      next(...args),
};
export const invalidTransaction: SqliteDecorators = {
  // @ts-expect-error A transaction must preserve each callback's result type.
  transaction: () => () => "wrong",
};
export function preservesTransactionResult(connection: SqliteConnection) {
  const transaction = decorateFunction(connection.transaction.bind(connection), [
    (next) =>
      function <T>(work: () => T): T {
        return next(work);
      },
  ]);
  const result: { readonly accepted: true } = transaction(() => ({ accepted: true }) as const);
  return result;
}
interface Overloaded {
  (value: string): string;
  (value: number): number;
}
export function preservesOverloads(method: Overloaded, decorator: Decorator<Overloaded>) {
  const wrapped = decorateFunction(method, [decorator]);
  const text: string = wrapped("text");
  const number: number = wrapped(42);
  return { text, number };
}
