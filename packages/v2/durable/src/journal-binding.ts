import type { Operation } from "@standard-durability/core";
import type {
  Accepted,
  ChildLink,
  AcceptedHistory,
  JournalRecords,
  JournalBackend,
  JournalBindingOptions,
  OwnedJournal,
  JournalReader,
  OwnedChildInteractions,
  OwnedChildOptions,
  OwnedChildrenOptions,
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
    function ownedLink(childId: string) {
      return invoke((_tree, records) => readOwnedLink(records, id, childId));
    }
    function interactionBinding<CQ, CV, CE>(
      link: ChildLink,
    ): OwnedChildInteractions<CQ, CV, CE, Y> {
      const child = bind<unknown, CQ, CV, CE, unknown>(link.childId, link.program);
      return {
        link,
        journal: {
          id: child.id,
          interactions: { request: child.interactions.request, answer: child.interactions.answer },
        },
      };
    }
    return {
      id,
      *openChild(
        childId,
      ): Operation<JournalReader<unknown, unknown, unknown, unknown, unknown, Y>, Y> {
        const link = yield* ownedLink(childId);
        const child = bind<unknown, unknown, unknown, unknown, unknown>(childId, link.program);
        return { id: child.id, read: child.read, openChild: child.openChild };
      },
      *openChildInteractions<CQ, CV, CE>(
        childId: string,
        expectedProgram: string,
      ): Operation<OwnedChildInteractions<CQ, CV, CE, Y>, Y> {
        const link = yield* ownedLink(childId);
        if (link.program !== expectedProgram) {
          throw new Error("Journal program mismatch");
        }
        return interactionBinding<CQ, CV, CE>(link);
      },
      *openDescendantInteractions(execution) {
        const link = yield* invoke(function* (_tree, records) {
          let current = execution;
          let leaf: ChildLink | undefined;
          const visited = new Set<string>();
          while (current !== id) {
            if (visited.has(current)) {
              throw new Error("Cyclic owned ancestry");
            }
            visited.add(current);
            const record = yield* records.get(current);
            if (!record?.parent) {
              throw new Error("Execution outside this owned subtree");
            }
            const edge = yield* readOwnedLink(records, record.parent.parentId, current);
            leaf ??= edge;
            current = edge.parentId;
          }
          if (!leaf) {
            throw new Error("Owner is not its own descendant");
          }
          return leaf;
        });
        return interactionBinding<unknown, unknown, unknown>(link);
      },
      *admit(program, input) {
        return yield* command((journal) => journal.admit(program, input));
      },
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
        *request(...args) {
          return yield* command((journal) => journal.interactions.request(...args));
        },
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
        const outcome = definition.outcome;
        const links = yield* invoke((tree) =>
          tree.acquire(id, requestId, {
            children: [definition],
            outcome: (values: readonly C[]) => outcome(values[0]!),
          }),
        );
        const link = links[0]!;
        return { link, journal: bind<C, CQ, CV, CE, CS>(link.childId, link.program) };
      },
      *ensureChildren<C, CQ, CV, CE, CS = unknown>(
        requestId: string,
        definition: OwnedChildrenOptions<C, Value, Failure>,
      ) {
        const links = yield* invoke((tree) => tree.acquire(id, requestId, definition));
        return links.map((link) => ({
          link,
          journal: bind<C, CQ, CV, CE, CS>(link.childId, link.program),
        }));
      },
    };
  }
  return bind<R, Q, V, E, S>(identity, options.program);
}

/** Verify both directions of one persisted edge in the caller's transaction. */
function* readOwnedLink<Y>(
  records: JournalRecords<Y>,
  parentId: string,
  childId: string,
): Operation<ChildLink, Y> {
  const child = yield* records.get(childId);
  const link = child?.parent;
  if (!link || link.parentId !== parentId || link.childId !== childId) {
    throw new Error("Not a direct owned child");
  }
  const request = yield* records.request(parentId, link.requestId);
  const stored = request?.children?.find((entry) => entry.childId === childId);
  if (
    !stored ||
    stored.parentId !== parentId ||
    stored.requestId !== link.requestId ||
    stored.program !== link.program ||
    child.snapshot.program !== link.program
  ) {
    throw new Error("Inconsistent owned child link");
  }
  return link;
}
