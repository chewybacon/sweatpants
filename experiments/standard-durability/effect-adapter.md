# Effect composition adapter

Implemented in `packages/standard-durability-effect/src/index.ts`, with Effect 4.0.6. The public vocabulary remains
createApi / install / around / contexts / scoped / ensure.

## Ownership

`effectProgram(work)` creates a fresh root binding frame and native resource scope
on each execution. `scoped` creates a child frame and a native resource owner.
Effect owns fibers, interruption and finalization. The adapter implements binding
lookup and middleware dispatch, not a scheduler or journal.

Frames point to parents. Context lookup and API dispatch walk that chain when the
operation runs, so later parent installations are visible to existing children.
Child writes and drivers remain local. An API call constructs a lazy computation;
it does not capture bindings at construction.

Middleware is assembled in Effection order: max from ancestor to descendant and
earlier to later; min from descendant to ancestor and later to earlier. The
terminal driver is a min middleware. One driver installation per frame is allowed.

`ensure` registers an Effect finalizer with the current resource scope and retains
that frame for cleanup. A final native finalizer marks the frame closed after user
cleanup. Calls through escaped closed frames fail visibly.

## Evidence

The shared acceptance file has six cases per runtime, 12 passing cases total:

- unchanged generic conversation, child override, parent middleware and cleanup;
- a child waiting while its parent updates context and middleware, plus sibling isolation;
- exact max/min ordering;
- missing context/driver and duplicate installation failures;
- cancellation waits for asynchronous child cleanup before parent cleanup;
- body failure releases resources, and finalizer failure remains observable.

No timer sleeps are used to establish ordering. Promise gates coordinate the
concurrent scenarios. Both runtimes perform native operations in the host adapters.

## Explicit boundaries

Native Effect fibers do not automatically create composition frames. In the
acceptance host, native `forkScoped` wraps work in `effect.scoped(work)`. Without
that explicit boundary, fibers inherit the same frame and therefore share local
bindings. We have not patched Effect's fiber creation or promised that every native
fork has Effection's spawn semantics. A future portable spawn capability should
own that boundary explicitly.

`EffectYield` carries the composition frame and native Scope requirements. Extra
application-specific Effect services and per-method error/environment inference
remain future work. The pure signature map intentionally handles ordinary methods,
not arbitrary overloads or polymorphic methods.

Use `ensure` for cancellation cleanup. Arbitrary JavaScript generator finally and
catch around native suspensions are not portable error/finalizer contracts. Native
error channels remain native; expected failures can use explicit Outcome values.
The case where both a body and its finalizer fail has no normalized cross-runtime
error representation in this experiment.

This establishes a bounded composition adapter, not durability or full runtime
substitutability. No persistence, acceptance, replay, transport or application-host
migration is introduced.
