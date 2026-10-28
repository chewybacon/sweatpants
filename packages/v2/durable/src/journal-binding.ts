import type { Operation } from "@standard-durability/core";
import type {
  JournalBackend,
  JournalBindingOptions,
  OwnedJournal,
  OwnedChildOptions,
} from "./contracts.ts";
import type { ChildBinding } from "./types.ts";
import { createJournalCommands } from "./journal-commands.ts";
import { createJournalTree } from "./journal-tree.ts";

function finish<T>(operation: Operation<T, never>): T {
  const step = operation[Symbol.iterator]().next();
  if (!step.done) {
    throw new Error("Journal decision must not suspend");
  }
  return step.value;
}

/** Bind typed journal capabilities to an adapter transaction port with fresh projection bindings. */
export function createJournalBinding<R, Q, V, E, S = unknown, Y = never>(
  options: JournalBindingOptions,
  backend: JournalBackend<Y>,
  identity: string,
): OwnedJournal<R, Q, V, E, S, Y> {
  let bindings = new Map<string, ChildBinding>();
  function bind<Result, Request, Value, Failure, State>(
    id: string,
    program: string,
  ): OwnedJournal<Result, Request, Value, Failure, State, Y> {
    function* invoke<T>(work: (tree: ReturnType<typeof createJournalTree>) => T): Operation<T, Y> {
      let staged = bindings;
      const result = yield* backend.transact((records) => {
        staged = new Map(bindings);
        if (records.get(id)?.snapshot.program !== program) {
          throw new Error("Journal program mismatch");
        }
        return work(createJournalTree(options, records, staged));
      });
      bindings = staged;
      return result;
    }
    function* command<T>(
      work: (
        journal: ReturnType<typeof createJournalCommands<Result, Request, Value, Failure, State>>,
      ) => Operation<T, never>,
    ): Operation<T, Y> {
      return yield* invoke((tree) =>
        finish(
          work(createJournalCommands<Result, Request, Value, Failure, State>(options, tree, id)),
        ),
      );
    }
    return {
      id,
      *read() {
        return yield* command((journal) => journal.read());
      },
      *park(...args) {
        return yield* command((journal) => journal.park(...args));
      },
      *accept(...args) {
        return yield* command((journal) => journal.accept(...args));
      },
      *complete(...args) {
        return yield* command((journal) => journal.complete(...args));
      },
      attempts: {
        *begin(...args) {
          return yield* command((journal) => journal.attempts.begin(...args));
        },
        *settle(...args) {
          return yield* command((journal) => journal.attempts.settle(...args));
        },
      },
      attemptControl: {
        *inspect(...args) {
          return yield* command((journal) => journal.attemptControl.inspect(...args));
        },
        *invalidate(...args) {
          return yield* command((journal) => journal.attemptControl.invalidate(...args));
        },
      },
      interactions: {
        *register(...args) {
          return yield* command((journal) => journal.interactions.register(...args));
        },
        *answer(...args) {
          return yield* command((journal) => journal.interactions.answer(...args));
        },
        *invalidate(...args) {
          return yield* command((journal) => journal.interactions.invalidate(...args));
        },
      },
      cancellation: {
        *request(...args) {
          return yield* command((journal) => journal.cancellation.request(...args));
        },
        *finish(...args) {
          return yield* command((journal) => journal.cancellation.finish(...args));
        },
      },
      *ensureChild<C, CQ, CV, CE, CS = unknown>(
        requestId: string,
        definition: OwnedChildOptions<C, Value, Failure>,
      ) {
        const link = yield* invoke((tree) => tree.acquire(id, requestId, definition));
        return { link, journal: bind<C, CQ, CV, CE, CS>(link.childId, link.program) };
      },
    };
  }
  return bind<R, Q, V, E, S>(identity, options.program);
}
