import type { Operation } from "@standard-durability/core";
import type {
  Accepted,
  AcceptedHistory,
  JournalRecords,
  JournalBackend,
  JournalBindingOptions,
  OwnedJournal,
  OwnedChildOptions,
} from "./contracts.ts";
import type { ChildBinding } from "./types.ts";
import { stageBindings } from "./bindings.ts";
import { createJournalCommands } from "./journal-commands.ts";
import { createJournalTree } from "./journal-tree.ts";

/** Bind typed journal capabilities to an adapter transaction port with fresh projection bindings. */
export function createJournalBinding<R, Q, V, E, S = unknown, Y = never>(
  options: JournalBindingOptions,
  backend: JournalBackend<Y>,
  identity: string,
): OwnedJournal<R, Q, V, E, S, Y> {
  const bindings = new Map<string, ChildBinding>();
  function bind<Result, Request, Value, Failure, State>(
    id: string,
    program: string,
  ): OwnedJournal<Result, Request, Value, Failure, State, Y> {
    function* invoke<T>(
      work: (
        tree: ReturnType<typeof createJournalTree<Y>>,
        records: JournalRecords<Y>,
      ) => Operation<T, Y>,
    ): Operation<T, Y> {
      return yield* backend.transact(function* (transaction) {
        const staged = yield* stageBindings(transaction, bindings);
        const records = transaction.records;
        if ((yield* records.get(id))?.snapshot.program !== program) {
          throw new Error("Journal program mismatch");
        }
        const tree = createJournalTree(options, records, staged);
        return yield* work(tree, records);
      });
    }
    function* command<T>(
      work: (
        journal: ReturnType<
          typeof createJournalCommands<Result, Request, Value, Failure, State, Y>
        >,
      ) => Operation<T, Y>,
    ): Operation<T, Y> {
      return yield* invoke((tree, records) =>
        work(
          createJournalCommands<Result, Request, Value, Failure, State, Y>(
            options,
            tree,
            records,
            id,
          ),
        ),
      );
    }
    return {
      id,
      *read() {
        const snapshot = yield* command((journal) => journal.read());
        const end = Object.freeze({ ...snapshot.frontier });
        const history: AcceptedHistory<Request, Value, Failure, Y> = {
          end,
          *at(sequence) {
            return (yield* history.read(sequence, 1))[0];
          },
          *read(from, limit) {
            if (
              !Number.isSafeInteger(from) ||
              from < 0 ||
              !Number.isSafeInteger(limit) ||
              limit < 1
            ) {
              throw new Error("Invalid history range");
            }
            if (from >= end.position) {
              return [];
            }
            return (yield* backend.history(id, from, end.position, limit)) as readonly Accepted<
              Request,
              Value,
              Failure
            >[];
          },
        };
        return { ...snapshot, history };
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
