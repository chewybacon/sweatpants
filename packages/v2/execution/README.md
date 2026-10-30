# Live guest ownership

An authored computation yields domain requests. A Guest advances that computation
through native operations and returns Turn data. The native runner must execute
the advancement operation, not delegate directly into the authored iterator.

`createScopedGuest(work)` is lazy: neither construction nor acquisition invokes
work. `start()` creates and first advances its iterator; `resume(outcome)` advances
only a suspended iterator. Completion and advancement failure are terminal.
Commands are checked when their operations execute. Synchronous reentrant
advancement/disposal is rejected; this driver has no asynchronous command queue.

`close()` is idempotent and invalidates the live handle. It drops the iterator
reference without calling return or throw, including before first advancement.
It never runs authored finally blocks. Those blocks can still run during normal
explicit advancement and can yield domain requests like the rest of the body.
Discarding an iterator is not a serialization or snapshot mechanism.

Native resources belong to acquisition and its surrounding lifetime. Use
`runtime.using(acquire, activate, release)` (or native scope ownership) so release
closes the Guest and releases its worker, transport or evaluator resources.
The iterator body must not acquire physical resources whose only release path is
its authored finally: disposal deliberately does not execute that code.

The live Guest/GuestWork contracts are generic in result, request and native yield.
The TypeScript evaluator needs no native yield protocol. Its reply values start unknown;
typed author declarations and domain validation must establish reply correlation.
This layer does not validate arbitrary wire bytes, accept outcomes durably, or
implement durable acceptance, replay or checkpoint capture.

Acceptance journeys in `acceptance/__tests__/execution/disposal.acceptance.test.ts`
run the same body under Effect and Effection. Scripted peers acknowledge physical
open/close and reservation requests. They verify lazy acquisition, parked disposal,
native cancellation after suspension, invalidated handles, pre-start disposal and
normal yielding finally completion with an inferred result. These are in-process
ownership checks, not crash-recovery or durable cancellation evidence.

## Logical root cancellation

`Guest.cancel` is optional evaluator support; it returns the same `Turn` union as
start/resume. The TypeScript evaluator abandons unprotected body iterators and
runs registered `scope.ensure` cleanup in reverse order. Cleanup requests become
suspended turns; resume supplies their outcomes. Repeated cancellation preserves
cleanup already in progress, and completion remains cancelled after it drains.
Cleanup failures are retained as diagnostic data while remaining cleanup is attempted.

Ordinary catch does not receive a synthetic domain error on cancellation. Arbitrary
JavaScript finally blocks in abandoned body iterators do not run. Register logical
obligations with ensure; normal JavaScript finally behavior during ordinary return
or exception propagation remains supported. Physical close discards without unwinding.

## Scoped execution drivers

`createExecution(composition, name)` exposes the existing Guest methods through
`operations`, `around` and `install`. There is no second driver contract: install a
Guest directly. The facade derives its method signatures from Guest and resolves
the driver in the executing scope. Calling it with no driver fails explicitly.
The cancellation method is available to middleware even when an installed evaluator
cannot cancel; the unsupported driver rejects only when cancellation is invoked.

`install(guest)` registers physical disposal of that exact Guest in the current
scope, then binds its methods. Child scopes inherit middleware and can install a
different Guest. Middleware may call `next` inside a child override, deliberately
replace results or short-circuit advancement. Sibling bindings remain isolated.
One driver may be installed per scope; failed installation still disposes the
supplied incarnation when that scope exits.

A captured operations facade is not a captured continuation. Checkpoint adapters
must receive the raw Guest identity. Scope cleanup calls that raw Guest's `close`
directly rather than redispatching through an overridable facade; explicit calls
to `operations.close()` remain interceptable. Guest close must remain idempotent.

## Registered logical scopes

`createScopedGuest(scope => operation)` is an evaluator driver implementing the
shared Guest protocol used by other evaluators, including Lua. The returned Result and domain
Request types are inferred; its private scope instructions are consumed internally.
Native Effect/Effection types do not enter author signatures.

```ts
const guest = createScopedGuest(function* (scope) {
  const hold = yield* reserve();
  yield* scope.ensure(function* () {
    yield* release(hold);
  });
  return yield* scope.scoped(function* (child) {
    yield* child.ensure(function* () {
      yield* audit();
    });
    return { hold, approval: yield* elicit() };
  });
});
```

Scopes are a stack of live frames, with a LIFO cleanup stack on each frame. Body
results remain provisional while cleanup drains. Nested scopes join before their
caller resumes. Cleanup can itself run a nested scope. Each suspension reports a
replay-stable scope/frame identity and whether it is within cleanup. The durable
layer records and validates that evidence with accepted outcomes and cancellation.

Root cancellation discards suspended body frames and runs registered cleanup. It
preserves a cleanup iterator already running, including nested work owned by that
cleanup. Repeated cancellation cannot reset that cursor. Cleanup errors drain the
remaining frames; cancellation retains diagnostic failures. Without cancellation,
uncaught failure is thrown after drainage;
a persisted failed terminal journal result is not added here.

Physical `close` drops live frames without invoking logical cleanup. This is not
native `Composition.ensure`, which must run on host shutdown. Replay reconstructs
registrations and captured values from the pinned program and accepted outcomes.
Native resources must be reacquired; callbacks/iterators are never serialized.
The internal control handles are valid only within their owning evaluator/scope.

Use registered cleanup for this guarantee. Cancellation does not run arbitrary
JavaScript finally in discarded body iterators. No compiler translation, lexical
context API, independently cancellable lexical scope, fork group or checkpoint
format is introduced. Host-level scoped middleware still wraps ordinary execution.

## Critical body regions

`scope.critical(work)` defers logical cancellation until the region exits. It retains
the inferred result and creates no new cleanup lifetime: `scope.ensure` inside the
region registers on the existing logical scope.

```ts
const hold =
  yield *
  scope.critical(function* () {
    const acquired = yield* reserve();
    yield* scope.ensure(function* () {
      yield* release(acquired.id);
    });
    return acquired;
  });
yield * useReservation(hold);
```

If cancellation arrives while reserve is pending, intent is recorded immediately,
but the reply remains eligible. Recovery reconstructs the same mask, accepts the
reservation, registers release, then unwinds before useReservation begins. Nested
critical regions restore the outer mask; nested lexical scopes retain its protection.
A child invocation owned by a critical region is joined rather than cancelled by
its parent's cancellation request. Registered cleanup already has this protection.

The boundary records the outermost critical region identity independently of the
body/cleanup phase. Replay validates it alongside the scope/frame identity. Protected
attempts are omitted from logical-cancellation abort notifications. Explicit grant
invalidation/reconciliation remains a separate administrative capability.

This does not mask native host shutdown: local IO and physical resources can still
be stopped. An unsafe attempt remains occupied after interruption. A critical region
waiting for a reply or reconciliation can delay logical cancellation indefinitely;
no timeout silently grants permission to redeliver it. Critical is not a database
transaction, a guarantee against process loss, or exactly-once external execution.

## Evaluator checkpoint capability

CheckpointAdapter is optional capability composition around the shared Guest.
It captures owned suspended Guests and restores a snapshot to a Guest plus its
current Turn. Ordinary acquisition remains GuestWork and does not advance code.

The evaluator owns snapshot decoding, source/runtime compatibility and partial
restore cleanup. The durable host owns accepted history, checkpoint anchoring,
replay policy and the returned Guest's lifetime. There is no second execution
interface or mandatory capture method on Guest.

## Internal continuation mechanics

The scoped evaluator composes three internal mechanisms; none adds a public API:

- `continuation.ts` steps an iterator with a reply or failure and returns a yield or
  an exit Outcome. It knows nothing about logical scopes or durable authority.
- `scope-frame.ts` constructs lazy frames and owns per-frame exit operations:
  provisional body results, LIFO cleanup selection and ordered failure aggregation.
  A frame settles only after its registered cleanup has drained.
- `scope-stack.ts` owns the live frame array, evaluator-local instruction tokens,
  replay-stable child numbering and boundary identities, and the cleanup/critical
  protection counts. Continuing exit either selects cleanup or settles into the
  parent. Discarding the stack never runs logical cleanup.

`scoped-guest.ts` owns the incarnation lifecycle, root cancellation reason and last
returned boundary. Its advancement loop composes stepping and scope exit until a
request or terminal result is available. An instruction-handling failure exits the
current frame just like an iterator failure, so remaining cleanup is still attempted.

These live ownership frames are not a capability graph or durable history. Scoped
APIs and middleware compose access to capabilities; sharing a capability does not
make it an owned child. The journal independently decides whether a reply may be
accepted. A live continuation, frame identity or reconstructed stack grants no
permission to commit an external result. Replay reconstructs these frames rather
than serializing their JavaScript iterators or cleanup closures.

Existing hosted logical-scope, critical-region and owned-child journeys exercise
these mechanisms through both native runtimes, including replay, cleanup failure,
logical cancellation and physical disposal. The extraction introduces no new
checkpoint format, continuation-capture API, scheduler or dispatch framework.

## Migrating raw iterator programs

TypeScript programs use createScopedGuest, including programs that ignore its scope
argument. The former createIteratorGuest evaluator is retired. Move cancellation-sensitive
finally obligations into scope.ensure; there is no compatibility mode for cancellation
through iterator.return(). Scoped suspensions also carry frame identity evidence, so
old raw-iterator histories are not replay-compatible with the new evaluator. Pin a
new program version when migrating persisted executions; this reconstruction does
not provide a stored-history migration.

## Serialized command boundary

The execution-worker adapter implements Guest across a byte channel. Hosting/recovery
consume the same Guest interface for local and remote execution; wire commands and
responses are private to the adapter. Uncertain advancement discards an incarnation;
the journal's accepted history reconstructs a fresh one. Program selection and input
admission happen before acquisition; execution-worker also transports optional checkpoints.

## Pinned program acquisition

`ProgramInvocation<Input>` is the data boundary for acquiring a program:

```ts
interface ProgramInvocation<Input = unknown> {
  readonly program: string;
  readonly input: Input;
}
```

`program` is the immutable reference stored by the journal. It identifies the replay
contract: executable code and dependencies, evaluator semantics, request/result
encoding, effect alias mappings and replay-visible schema/transform contracts. A name
such as `research` is a lookup alias, not sufficient identity for durable recovery.
Assembly/tooling chooses how references are generated and verified; this package does
not hash JavaScript functions or interpret a manifest format. Declared revision tokens
are compatibility assertions by trusted assembly, not verified artifact hashes.

`input` is the normalized value already pinned by admission. It is per invocation,
not part of the reusable program identity. Acquisition may decode the transport shape
but must not repeat the author's admission transformations. Execution IDs, grants,
receipts, journal positions and worker incarnations remain separate identities.

An ordinary scoped API can accept this value and return a Guest. Placement middleware
may change local/worker routing, transport, endpoint, credentials or native runtime
adapter without changing the reference, provided the evaluator and exchange semantics
remain compatible. Handler instances and external observations are supplied by hosting;
accepted outcomes replay from history. Changing the declared effect contract requires
a new program reference even if effect keys remain the same.

Fresh acquisition and supported checkpoint restoration must both resolve and verify the
same pinned program before creating a Guest or restoring evaluator state. Checkpoint
format is a separate optional capability: recovery may replay when a saved format is
unsupported; a supported restore failure remains an error. A terminal journal needs
no executable artifact to return its accepted result.

`createProgramExecution` binds an invocation to one resolver for both paths:

```ts
const execution = createProgramExecution({
  invocation, // { program, input } from journal admission
  resolve: programs.operations.resolve,
  checkpointFormat, // omit for replay-only execution
});
// Supply execution.acquire to recovery; install checkpoint middleware only when
// execution.checkpoints is present. Placement can wrap these same capabilities.
```

The resolver returns `ResolvedProgram`: the selected artifact's actual `program`
reference, an input-bound `acquire`, and optional `checkpoints`. It may perform lookup
and verification but must not acquire a live Guest. The helper compares that reference
with the pinned invocation before entering either evaluator path. It does not derive
artifact hashes or verify that trusted resolver implementations honor their metadata.

Each acquisition or restoration resolves afresh. Capture does not resolve again: it
uses the adapter that created that exact Guest, including restored Guests. Foreign
Guests and fresh Guests without the selected capture format return no snapshot.
Restoration requires the advertised format to exist on the selected artifact. Missing
formats and supported restore failures propagate; fallback to replay belongs to recovery
middleware's saved-format selection, never to an uncertain restore operation.

The caller's scope owns Guest disposal and evaluator resources. The invocation wrapper
is frozen when bound; its already-normalized input remains caller-owned and must stay
immutable. Registry/placement customization uses ordinary scoped APIs. The Lua journeys
exercise replay and checkpoint restoration across local/MessageChannel placement; they
do not implement deployed bootstrap or a public artifact registry. Artifact identity
still requires complete dependency accounting before a hash can be described as covering
the full implementation.
