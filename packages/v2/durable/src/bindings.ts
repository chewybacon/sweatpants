import type { Operation } from "@standard-durability/core";
import type { JournalTransaction, TransactionInstruction } from "./contracts.ts";
import type { ChildBinding, ChildBindings } from "./types.ts";

/** Stage only changed bindings and publish them with their owning transaction. */
export function* stageBindings<Y>(
  transaction: JournalTransaction<Y>,
  bindings: Map<string, ChildBinding>,
): Operation<ChildBindings, TransactionInstruction> {
  const staged = new Map<string, ChildBinding>();
  yield* transaction.onCommit(() => {
    for (const [key, binding] of staged) {
      bindings.set(key, binding);
    }
  });
  return {
    get: (key) => staged.get(key) ?? bindings.get(key),
    has: (key) => staged.has(key) || bindings.has(key),
    set: (key, binding) => {
      staged.set(key, binding);
    },
  };
}
