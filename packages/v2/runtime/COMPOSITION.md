# Composing behavior

`Runtime` owns execution and resources. `runtime.composition` supplies portable
scope lookup, contexts, API dispatch and middleware. Choose which behavior an
assembly can select or surround, and when that selection happens. Whether an
implementation waits for IO is a separate question.

## Recognizing a useful boundary

Look for behavior applications may vary: selecting a model, routing a request,
authorizing an action, acquiring a connection, observing SQL, handling a subscription,
or settling an alarm. Consider composition when adding a policy option, callback
hook, driver switch or repeated wrapper. Middleware can rewrite arguments, transform
results, short-circuit, or surround failures. A driver supplies the terminal
implementation. A context carries a selected value or capability.

Keep core correctness in its owning implementation. Do not make it depend on an
optional middleware installer or expose every private helper as an API.

## Selection time determines the mechanism

**Construction: direct decoration.** `composeOperation(method, decorators)` wraps a
specific callable. It supports ordinary functions and operation methods, preserves
its complete signature and introduces no scope or cleanup. The first decorator is
outermost. Bind receiver-dependent methods before passing them to the helper.

```ts
const run = composeOperation(connection.run.bind(connection), [
  (next) =>
    (...args) => {
      trace(args[0]);
      return next(...args);
    },
]);
```

**Each operation call: scoped dispatch.** Declare operation methods in `operations`.
Call through `api.operations` to select the executing scope's middleware and nearest
installed driver. Preparing an operation does not capture a scope. Calling `next`
inside a child operation selects that child's terminal driver without restarting
the middleware chain. Calling the raw implementation bypasses interception.

**Synchronous access: acquire the scope first.** Declare ordinary methods and
read-only properties in `sync`. `const access = yield* api` captures the executing
scope; subsequent calls and reads resolve that scope's current policy without
yielding. This is useful inside SQLite transactions, which reject every runtime
yield, including scope lookup. Acquire access before entering the transaction.

**Acquisition: decorate a returned resource.** An operation can acquire a connection,
Guest or subscription. Its decorator can wrap that result's methods. Such wrappers
belong to that resource; they do not automatically resolve fresh policy. State who
owns cleanup and whether the result can escape. Decoration does not transfer ownership.

**Value selection: contexts.** `createContext` carries scoped configuration or a
capability. A child can shadow its inherited value. Lookup is an operation; accessing
a retrieved object's properties is ordinary JavaScript, without automatic interception.

**Streams: subscription and delivery are separate.** `createStreamApi` intercepts
subscription. Decorate the returned `next` to intercept items, or explicitly decorate
`send` to intercept publication. Preserve producer and reader ownership.

## One declaration, two execution kinds

```ts
const service = runtime.composition.createApi("service", {
  sync: {
    label: "primary",
    format(value: string) {
      return value.toUpperCase();
    },
  },
  operations: {
    *load(): Operation<string, Y> {
      return "loaded";
    },
  },
});

yield *
  service.around({
    sync: {
      format: (next) => (value) => `[${next(value)}]`,
      label: (next) => () => `${next()} service`,
    },
    operations: {
      load: (next) =>
        function* () {
          return yield* next();
        },
    },
  });

const access = yield * service;
access.format("hello"); // "[HELLO]", returned immediately.
access.label; // "primary service", read immediately.
yield * service.operations.load();
```

Either group can be omitted. `.operations` contains only operation members; yielding
an API exposes only synchronous members. There is no automatic lifting or factory
overload. `Api<O, Y, S>` preserves both groups' signatures; operation-only annotations
can use `Api<O, Y>`. `Operations<Shape, Y>` is an explicit type helper when needed.

`Decorator<F> = (next: F) => F` preserves generic and overloaded method relationships.
Properties use decorators of zero-argument readers. For example, transaction policy
must return a function that works for every callback result type:

```ts
yield *
  Sqlite.around({
    sync: {
      transaction: (next) =>
        function <T>(work: () => T): T {
          return next(work);
        },
    },
  });
const sql = yield * Sqlite;
const result = sql.transaction(() => ({ accepted: true }));
```

Use portable `Operation<Result, Y>` annotations for defaults when policy needs to
yield more than the concrete generator's inferred protocol. Decorators preserve the
full callable type, so an overly narrow implementation type also narrows its policy.
Decorators are applied during dispatch; keep per-scope state in an explicitly owned
closure or context, rather than relying on decorator-construction timing.

## Scope, driver and lifetime rules

`api.around({ sync, operations }, { at })` adds inherited policy. Earlier `max`
decorators surround later `max` decorators; later `min` decorators surround earlier
`min` decorators. Max decorators surround min decorators. There is no remove-layer
operation. A child can install more layers or select a different driver.

`api.install({ sync, operations })` replaces provided groups; omitted groups retain
the currently selected driver. There is one installation per API per scope. Driver
replacement keeps middleware. API names identify shared scoped dispatch; use distinct
names for independently configured capabilities.

Yielding an API captures a scope, not a snapshot of policy. Later installations in
that scope are visible. Access acquired in a parent continues to use the parent
when called from a child; yield the API in the child to acquire its selection.
Methods can be passed as callbacks while access is alive.

Access invalidation is a registered finalizer. Cleanup registered after acquisition
can still use it; cleanup registered before acquisition runs after invalidation.
After cleanup/cancellation completes, retained access throws. Acquisition does not
keep a scope alive or own the driver's physical resources. Callers still close their
databases and other resources.

Properties are read-only through the API. Declaration and acquisition do not evaluate
getters. Reads use the selected driver as `this`; internal `this` calls bypass API
interception. Members are own, enumerable string keys. Setters, symbol members and
function-valued getters are unsupported. Arrays, strings, Maps, Sets and typed-array
views are ordinary synchronous data; other iterable objects are reserved for operations.

Synchronous members and decorators must return immediately. Promise and operation
results throw, including async functions admitted by TypeScript's `void` rule. Use an
explicit operation adapter for asynchronous work. Guards cannot cancel work already
started, detect detached effects, or provide a security sandbox. The transaction
driver owns callback validation and commit semantics.

## Acceptance and review

The shared Effect/Effection journeys cover lazy properties, ordinary methods, generic
decorators, scope selection, reentrancy, cancellation, cleanup order and internal-name
isolation. The [SQLite consumer](../acceptance/examples/scoped-sqlite.md) exercises
scoped SQL policy inside real journal transactions.

When adding a composition boundary, identify its consumer, selection time, owner,
synchronous requirements and generic type relationships. Distinguish what assembly
may replace from invariants that stay in the implementation. Passing local acceptance
does not establish transport, deployment or process-crash guarantees.
