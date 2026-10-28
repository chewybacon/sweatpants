# Live guest ownership

An authored computation yields domain requests. A Guest advances that computation
through native operations and returns Turn data. The native runner must execute
the advancement operation, not delegate directly into the authored iterator.

`createIteratorGuest(work)` is lazy: neither construction nor acquisition invokes
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
The iterator driver needs no native yield protocol. Its reply values start unknown;
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
start/resume. The iterator implementation requires a suspended return-capable
iterator and advances `return()` once. Yielded finally requests become normal
suspended turns. Repeated cancellation preserves the current cleanup boundary;
resume supplies cleanup outcomes. Completion remains `cancelled` even when an
authored finally overrides the return value. Unhandled cleanup exceptions produce
a cancelled turn with a diagnostic failure string, not successful cleanup.

Ordinary `catch` does not receive a synthetic domain error on cancellation. Native
JavaScript nested-finally semantics apply, including continuation into outer
finally blocks after an inner failure. This does not yet implement registered
cleanup stacks, independently scheduled child tasks, or externally targeted nested
scopes. Physical close continues to discard without logical unwinding.

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
same Guest protocol as the raw iterator driver. The returned Result and domain
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
uncaught failure is thrown after drainage, as with the existing iterator driver;
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
