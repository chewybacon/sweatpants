# Composing behavior

`Runtime` owns execution and resources. `runtime.composition` supplies portable
contexts, scopes, operation APIs and middleware. Choose the behavior an assembly
can select or surround, and when that selection happens. Whether an implementation
waits for IO is a separate question.

## Choose the selection boundary

**Construction: direct decoration.** Use `composeOperation(method, layers)` for
existing `(args, next) => result` layers. For generic or overloaded functions, use
`decorateFunction(method, decorators)` with `Decorator<F> = (next: F) => F` to preserve
the complete signature. Both work with ordinary functions and operation methods.
Neither creates a scope or cleanup owner. Bind receiver-dependent methods first.

```ts
const transaction = decorateFunction(connection.transaction.bind(connection), [
  (next) =>
    function <T>(work: () => T): T {
      trace("transaction");
      return next(work);
    },
]);
```

`decorateFunction` builds its wrappers once at construction, innermost first. The
first listed decorator surrounds later decorators when the result is called.
Factory exceptions occur during construction; callable exceptions occur during use.
State in a decorator factory persists for that constructed wrapper. By comparison,
`composeOperation` invokes its `(args, next)` layers on each call and short-circuiting
skips inner layers. These are separate authoring forms, not overloaded meanings of
one middleware contract.

**Each operation: scoped dispatch.** `composition.createApi(name, operations)`
selects middleware and the nearest driver when an operation executes. Use
`api.around(layers)` for policy, `api.install(driver)` for replacement, and
`api.operations.method()` for invocation. Calling the original driver bypasses
interception. API facades are not themselves operations.

```ts
yield *
  api.around({
    *read([id], next) {
      return yield* next(normalize(id));
    },
  });
```

The operation middleware form derives argument and return types separately. It does
not preserve per-call generic or overload relationships; use explicitly typed hooks
or direct signature-preserving decoration for those methods. Do not assume a generic
method's preserved facade signature makes automatically derived interception sound.

**Acquisition: decorate a returned handle.** An operation may return a connection,
Guest or subscription. Acquisition middleware can wrap its ordinary methods before
returning it. Policy is selected at acquisition; existing handles keep their wrappers.
Reacquire when another scope or later installation should select different policy.
No live per-call scope lookup is implied for the returned object.

```ts
const Sqlite = composition.createApi("sqlite", {
  *acquire(): Operation<SqliteConnection, Y> {
    return connection;
  },
});
yield *
  Sqlite.around({
    *acquire(args, next) {
      const db = yield* next(...args);
      return decorateSqlite(db, {
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
sql.transaction(() => sql.run(statement));
```

`decorateSqlite` is an application-local helper in the
[SQLite experiment](../acceptance/examples/scoped-sqlite.md), not a framework API.
Acquisition middleware unwinds around the returned result: an outer acquisition
layer receives and may wrap the inner layer's result. That is distinct from the
execution order of the resulting SQL method wrappers.

**Value selection: contexts.** Use `createContext` for configuration or a selected
capability. Lookup is an operation; accessing the retrieved object is ordinary
JavaScript. A child may shadow its inherited value.

**Streams: subscription and delivery differ.** `createStreamApi` intercepts
subscription. To intercept items, decorate the returned `next`; to intercept
publication, decorate `send`. Preserve producer and reader ownership.

## Synchronous boundaries and ownership

A SQLite transaction cannot yield even a scope-lookup instruction. Acquire its
connection before entering the transaction, then use ordinary synchronous calls.
This needs assembly, not another synchronous dispatcher in each runtime adapter.
The SQL driver owns transaction commit and rollback. Statement policy throwing
inside a transaction can roll back; policy throwing after commit cannot undo it.

Decoration neither transfers ownership nor revokes retained handles. The caller
must keep the database alive for its consumers and close it afterward. If a consumer
requires revocation, live policy changes on already acquired handles, or independent
property interception, specify that guarantee and demonstrate it before promoting
another runtime capability. An acquisition wrapper does not silently supply it.

Keep synchronous policy synchronous. TypeScript permits async functions in void
slots, and generic callbacks may return Promises. Direct decoration does not detect,
cancel or await that work; transaction callback validation remains with the driver.

## When to introduce a boundary

Consider composition when adding configurable policy, a replacement driver,
interception hooks or repeated wrappers. Identify the concrete consumer, selection
time, owner and type relationships. Core correctness belongs in its implementation,
not an optional policy installer. Do not make every helper a scoped API.

The same SQLite acceptance journey runs under Effect and Effection with real
in-memory SQLite. It covers policy snapshots, stateful wrappers, generic transactions,
child driver selection, parent retention, fresh-root isolation and rollback of
statement-policy failure. This is local composition evidence, not process-crash or
deployment proof.
