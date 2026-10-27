# Scoped behavior composition

Contexts, scopes and middleware are the primary composition mechanisms for
framework behavior. A stack chooses the behavior it installs. The primitives make
that composition predictable; they do not prescribe one mandatory policy stack.

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

These journeys live in `../acceptance/__tests__/runtime/` and use scripted
in-process protocol peers. Nullable context semantics, acquisition/use context
visibility, and live mutation of ancestors with already-running children are not
established as portable guarantees by this evidence.
