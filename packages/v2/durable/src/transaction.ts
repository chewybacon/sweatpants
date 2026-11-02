import type { Operation } from "@standard-durability/core";
import type { JournalRecords, JournalTransaction, TransactionInstruction } from "./contracts.ts";

// Shared recognition prevents a foreign transaction's token reaching the scheduler.
const instructions = new WeakMap<object, { owner: object; publish: () => void }>();

/**
 * Adapter-side interpreter for one transaction. Run once with transaction-local
 * records, then publish synchronously immediately after confirmed commit. Always
 * close on exit. The adapter owns commit interruption, rollback and resource release;
 * closing this interpreter only discards local registrations.
 */
export function createJournalTransaction<Y>() {
  const owner = {};
  const publications: (() => void)[] = [];
  let open = true;
  let started = false;
  let completed = false;
  let closing = false;

  function close(): void {
    open = false;
    publications.length = 0;
  }
  function* onCommit(publish: () => void): Operation<void, TransactionInstruction> {
    if (!open || completed || closing) {
      throw new Error("Transaction registration is closed");
    }
    const token = {} as TransactionInstruction;
    instructions.set(token, { owner, publish });
    yield token;
  }

  return {
    /** Interpret registration instructions, forwarding native storage operations. */
    run<T>(
      records: JournalRecords<Y>,
      work: (transaction: JournalTransaction<Y>) => Operation<T, Y | TransactionInstruction>,
    ): Operation<T, Y> {
      return {
        [Symbol.iterator]() {
          if (started || !open) {
            throw new Error("Transaction interpreter can only run once");
          }
          started = true;
          const body = work({ records, onCommit })[Symbol.iterator]();
          function advance(
            step: IteratorResult<Y | TransactionInstruction, T>,
          ): IteratorResult<Y, T> {
            while (!step.done) {
              const value = step.value;
              const instruction =
                typeof value === "object" && value !== null ? instructions.get(value) : undefined;
              if (!instruction) {
                return { done: false, value: value as Y };
              }
              if (instruction.owner !== owner || !open || closing) {
                throw new Error("Transaction instruction used outside its owner");
              }
              publications.push(instruction.publish);
              step = body.next(undefined);
            }
            completed = !closing;
            return step;
          }
          const iterator: Iterator<Y, T, unknown> = {
            next(value) {
              return advance(body.next(value));
            },
            throw(error) {
              if (!body.throw) {
                throw error;
              }
              return advance(body.throw(error));
            },
          };
          if (body.return) {
            const finish = body.return.bind(body);
            iterator.return = (value) => {
              closing = true;
              close();
              return advance(finish(value));
            };
          }
          return iterator;
        },
      };
    },
    /**
     * Invoke trusted nonthrowing publications once, in registration order. A thrown
     * callback is a post-commit defect, never grounds for claiming database rollback.
     */
    publish(): void {
      if (!open || !completed) {
        throw new Error("Transaction body did not complete");
      }
      open = false;
      try {
        for (const publish of publications) {
          publish();
        }
      } finally {
        publications.length = 0;
      }
    },
    /** Idempotently discard registrations; does not advance the body or roll back storage. */
    close,
  };
}
