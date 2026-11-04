# Scoped behavior composition

Contexts, scopes and middleware are the primary composition mechanisms for
framework behavior. A stack chooses the behavior it installs. The primitives make
that composition predictable; they do not prescribe one mandatory policy stack.

## Signatures and handle decoration

`createApi(name, { operations, sync })` has one grouped declaration and returns
`Api<O, Y, S>`. Either group can be omitted. `api.operations` preserves operation
methods; `const access = yield* api` acquires ordinary methods and read-only
properties in the executing scope. No members are implicitly lifted.

`Decorator<F> = (next: F) => F` wraps the complete signature, including generics and
overloads. `OperationMiddleware<O>` and `SyncMiddleware<S>` derive decorators for
members; properties use zero-argument readers. Install them with
`api.around({ operations, sync })`. `Around<Args, Returned>` is an explicit callable
helper; `Operations<Shape, Y>` and `Middleware<Shape, Y>` remain explicit type helpers,
not alternative factory overloads.

`composeOperation(method, decorators)` uses the same signature-preserving shape.
The first decorator is outermost. Direct composition captures no scope and creates
no cleanup owner. Bind receiver-dependent methods first. Annotate defaults with
portable `Operation<Result, Y>` when middleware needs a broader yielded protocol
than a concrete generator implementation infers.

See [Runtime composition](../runtime/COMPOSITION.md) for examples, selection-time
choices, grouped installation, and the full synchronous contract.

## Calls and ownership

An API facade resolves middleware when its operation executes. Capturing the
facade or preparing an operation does not bind it to an earlier scope. The call
passes through the selected layers, then the nearest installed driver (or the
API's default implementation). A driver replacement preserves facade interception.

Default/max middleware runs outside min middleware. Earlier max layers are
outermost; later min layers are outermost within min. Child scopes inherit parent
layers and may add their own. A layer can transform arguments and results,
suspend, call next, or return without calling next. Calling next under a child
scope resolves that child's driver without starting the middleware chain again.

Contexts can carry API facades, plain configuration, or deliberately chosen raw
implementations. Child bindings shadow parent bindings; leaving the child restores
parent lookup. A nested dependency call through a facade gets that API's own
middleware. Registered cleanup can resolve contexts and call facades in its owning
scope while shutdown waits for it to complete.

## Intentional variation

Changing assembly changes behavior. For example:

- Authorization outside a cache can deny a cache hit.
- A cache outside authorization can serve a hit without consulting authorization.
- Replacing a driver changes transport while retaining the API's middleware.
- Replacing a context capability with a wrapped raw implementation bypasses that
  API's middleware for callers using the replacement. An existing facade still
  takes its own intercepted path.

These are useful choices, not defects. The public API currently adds inherited
middleware; it has no remove-layer operation. Select another assembly, shadow a
context capability, or make a layer's policy depend on scoped configuration when
those mechanisms express the intended variation. Do not assume a child driver
replacement removes inherited layers.

A host can require particular configuration or installation before admitting work.
That is a host assembly contract, not a universal middleware requirement. These
primitives do not statically certify middleware presence or enforce a security
sandbox against code that holds raw implementations. Fresh executions must
establish their own bindings. Persistent recovery and durable acceptance remain
separate protocols; interception alone does not implement them.

## Synchronous consumers

`const access = yield* api` captures the executing scope. Each synchronous call
resolves that scope's current middleware and nearest installed driver. A parent
handle used in a child keeps parent selection. Acquisition registers an invalidating
finalizer: newer cleanup may use access; older cleanup sees it invalidated. Access
does not own driver resources or keep the scope alive.

The [SQLite consumer](../acceptance/examples/scoped-sqlite.md) uses this boundary
inside journal transactions on both runtimes. Generic transaction signatures remain
intact through acquisition and decorators. Promise/operation returns from synchronous
members throw, including async functions in TypeScript void slots. Guards cannot
cancel already-started work or detect fire-and-forget effects.

## Acceptance evidence

The same portable applications run under Effect and Effection:

- `mixed-api.acceptance.test.ts`: regular functions, lazy property reads, generic
  decorators, live acquired policy, driver selection, reentrancy, cleanup and cancellation.
- `composition.acceptance.test.ts`: exact ordering, installation order, deferred
  lookup, child driver routing, argument/result transformation and short circuit.
- `assembly-policy.acceptance.test.ts`: deliberately different cache/authorization
  order, wrapped raw capability replacement, captured facade behavior, parent
  restoration, fresh-root isolation, nested interception and finalizer lookup.
- `lifecycle.acceptance.test.ts`: cancellation and failing asynchronous cleanup.

`../acceptance/__tests__/execution/composition.acceptance.test.ts` covers lazy
acquisition, two independently decorated Guests, scoped resume policy, completion
and parked disposal, plus inferred API results. Its type fixtures reject incorrect
resume outcomes, incorrect middleware results and incompatible runtime protocols.

These journeys live in `../acceptance/__tests__/runtime/` and use scripted
in-process protocol peers. Nullable context semantics, acquisition/use context
visibility, and live mutation of ancestors with already-running children are not
established as portable guarantees by this evidence.

## Retained internal prototype

Schema descriptors and the `defineOperation`/`defineApi` helpers are retained
internally for future authoring work. They are not public exports or a validation
boundary. The public scoped composition API remains `Composition.createApi`.

## Native error recovery

`Composition.catchError(work, recover)` catches thrown errors across native API and
scope boundaries without creating a scope. Plain generator try/catch is insufficient
for failures of yielded Effect operations. Native interruption bypasses recovery;
combined native failures may also propagate unchanged. Scope ownership and cleanup
remain the responsibility of `scoped` and `ensure`. The error-boundary acceptance
journeys exercise scoped API failures, cleanup-before-recovery and interruption on
both runtimes.
