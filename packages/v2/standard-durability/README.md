# Scoped behavior composition

Contexts, scopes and middleware are the primary composition mechanisms for
framework behavior. A stack chooses the behavior it installs. The primitives make
that composition predictable; they do not prescribe one mandatory policy stack.

## Signatures and handle decoration

`Api<Methods, Y>` describes actual operation-bearing methods. `createApi(name,
implementation)` can infer them directly; existing explicit value-signature calls
remain shorthand for `Operations<Signature, Y>`. Lifting is explicit in that
shorthand, so a Guest method returning `Operation<Turn<...>, Y>` is never lifted
again. Plain synchronous driver implementations are not supported.

`Around<Args, Returned>` is the shared `(args, next) => Returned` function shape.
`OperationMiddleware<Methods>` derives it from actual methods; the existing
`Middleware<Signature, Y>` shorthand derives it from `Operations<Signature, Y>`.
Both scoped `api.around(layers)` and direct `composeOperation(method, layers)` use
this shape. The first direct layer is outermost. Composition invokes no method,
captures no scope and creates no cleanup owner. Bind methods that rely on `this`
before passing them to direct composition.

Direct wrappers belong to the specific callable they wrap. An acquisition layer
can decorate its returned Guest without advancing the authored body. Its wrappers
can read contexts when their operations execute. Resource ownership stays with
the acquiring scope; changing the exposed close method does not transfer the
scope's responsibility to release physical resources.

Use portable `Operation<Result, Y>` contracts when middleware must yield host
operations beyond those inferred from a concrete generator implementation. Direct
inference preserves that implementation's return type, including narrower native
or generator types. Automatic argument/result extraction does not preserve
per-call generic relationships or overloads inside middleware; concrete Guest
capabilities do not have that limitation. Public method types remain intact.

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

## Acceptance evidence

The same portable applications run under Effect and Effection:

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
