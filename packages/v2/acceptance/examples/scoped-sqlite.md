# SQLite acquisition decoration

The [assembly](./scoped-sqlite.ts) uses the existing operation-only API to acquire a
plain `SqliteConnection`. Acquisition middleware decorates the returned connection
with the additive `decorateFunction` helper. Its `Decorator<F>` contract preserves
generic signatures such as `transaction<T>` without changing scoped middleware.

```ts
yield *
  Sqlite.around({
    *acquire(args, next) {
      return decorateSqlite(yield* next(...args), {
        run:
          (next) =>
          (...args) => {
            trace(args[0]);
            return next(...args);
          },
      });
    },
  });
const sql = yield * Sqlite.operations.acquire();
```

Acquire before constructing the journal. Statements run synchronously inside its
transactions. Wrapper factories run once per decorated connection; their state
persists across SQL calls. An existing handle retains its policy and driver after
later installations or when used in a child. Reacquisition selects new policy.

[Acceptance](../__tests__/applications/scoped-sqlite.acceptance.test.ts) runs under
Effect and Effection. It covers scoped acquisition, parent/child database isolation,
stateful wrappers, generic transaction results and rollback when statement policy
throws after a write but before transaction completion. Fresh acquisition can then
successfully admit the same execution. Type fixtures reject invalid generic and
asynchronous statement decorators and preserve overloads.

The caller owns both databases. Handles are ordinary objects: there is no automatic
revocation at scope exit, per-call runtime lookup, Promise/iterable return guard, or
new dispatcher. The SQL driver owns callback validation and commit semantics.
Middleware throwing after a transaction commits cannot roll it back. This is local
in-process evidence, not a process-crash or deployed-platform guarantee.
