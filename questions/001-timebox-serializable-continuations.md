Context:

a durable tool to purchase a movie ticket and pick your seat

you need to reserve the seat for 3m and elicit the user
to pick their seat

that needs to be timeboxed and something needs to wake up
and check if the operation has gotten a response

and it hasn't then it needs to send an aborts signal so
the effection context unwinds

```ts

function* (props) {
    yield* timebox(minutes(5), function* (){
        const hold = yield* reserve()

        const seat = yield* elicit("pickSeat")

        yield* ensure(function*() {
            yield* release(hold)
        })
    })
}
```

## Decision — 2026-10-15

Deferred, not discarded. First prove build → load without recompiling the authored
module → park → restart → resume. Durable deadlines remain a required future
capability and must not be ruled out by the core design.

The example above needs cleanup registered immediately after `reserve()`, before
eliciting. Its prose says three minutes while its snippet says five; a real hold
should supply its authoritative expiry.

## What we learned

The native Effection living reference is
`packages/foundation/src/styles/__tests__/effection-scopes.test.ts`.
It initially passed 37 cases against installed Effection 4.2.0.

- Suspension does not exit a scope or run `ensure`.
- Plain delegation and loop blocks share their owning Effection scope. `scoped`
  creates a new owner and normally completes cleanup before returning.
- Cleanup is LIFO. A failed cleanup does not prevent the others from running.
  The last failing cleanup executed determines the reported error. The compiler
  spike must follow this error precedence.
- Middleware is inherited. An identity guard can intercept one exact scope.
  `max` (the default) places earlier/ancestor middleware outside later/descendant
  middleware. `min` reverses that order; `max` wraps `min`.
- Suppressing destruction during normal `scoped()` return can defer registered
  cleanup, but the body has already returned. This is not a saved continuation.
- Suppressing `Scope.destroy` during task halt does not prevent body unwinding
  or task-group cleanup. Tests reproduced this at both `min` and `max`, including
  a nested explicit scope. Middleware alone is not proven durable parking.
- `useAbortSignal()` is itself a resource; whether another cleanup sees it
  aborted depends on registration order. An arbitrary external AbortController
  does not automatically halt a task.
- Native yielding `finally` cancellation limitations are pinned separately as
  observations, not behavior the compiled runtime should copy.

## Constraints to preserve in the core

1. Park preserves logical frames, scopes, captured environments and cleanup
   registrations. Host activation resources may still be torn down.
2. Cancellation is distinct from parking. Future deadline cancellation must
   target a logical scope and its descendants, without automatically cancelling
   the entire workflow. The parent chooses how to handle the timeout outcome.
3. Cleanup may suspend and must survive host replacement. The body deadline must
   not automatically prevent release from finishing.
4. Persist an absolute deadline once; recovery must not restart a duration.
5. Wake-ups need journaled identity and ordering with replies. Duplicate wake-ups,
   stale replies, completed scopes and reply/deadline races need explicit tests.
6. Native AbortSignal handles are activation-local, not checkpoint values.
7. Signed stopped-event metadata could reference invocation, scope, suspension,
   deadline, issue time and expiry. Signing neither schedules a wake-up nor
   replaces journal authority. Expired reply authorization must not prevent late
   timeout delivery.

## API candidates — not yet committed

```ts
yield *
    ctx.deadline(expiresAt, function* ({ ensure, signal }) {
        // Own the hold and register cleanup here.
    });

yield *
    ctx.timebox(durationMs, function* ({ ensure, signal }) {
        // Convenience over a recorded absolute deadline.
    });
```

Open: callback capabilities versus a child context; body-signal versus cleanup
lifetime; timeout outcome and error precedence; precise race ordering; scheduler
adapter; signed metadata format. The existing in-process EffectionX `timebox`
provides a useful behavior reference, not a durable wake-up mechanism.

## Return to this after the core proof

Use the movie-seat example: acquire, register release, park at selection, discard
the host, deliver expiry, restore and cancel only that scope, recover through a
suspended release, then let the parent offer another showing. Exercise races,
duplicates, late replies, cleanup failures and host loss at every boundary.

### Core proof follow-up

The sibling spike now has `scheme-checkpoint-spike/artifact-build/`: a build-time
bundle containing compiled instructions, source metadata and a bounded portable
validator recipe. Recovery loads that bundle without importing the TypeScript
frontend or evaluating the developer module. Its artifact identity pins the
runtime and validator recipes as well as the program.

The new executable proof passed 112 checks using 27 fresh runtime processes:
source-file deletion, compiler import tripwires, per-iteration cleanup capture,
checkpoint/journal replay equivalence, cancellation during cleanup, cleanup
failure, completed recovery, integrity rejection and validator parity.
Two additional scenarios match native Effection's multiple-cleanup failure
precedence, including a failing body.

This remains an experimental JS evaluator and workspace-local artifact package.
It does not prove durable deadlines, targeted scope cancellation, automatic code
migration or arbitrary validator serialization. Those remain the next layer once
the core is ready for integration.

### Pull-boundary integration proof

The spike now adapts compiled programs to the existing
`DurableProgramContext.pull` factory signature and uses the existing generated
pinned-program identity constructor. The native SDK generator and compiled
adapter emit identical elicitation descriptors and outcomes for success,
decline and release failure.

The integration proof passed 24 checks, including 13 compiler-free processes
restoring at acquire/release boundaries. Discarding and restoring the machine
preserves the frontier and cleanup registrations.

This is not yet a production driver. Its capture must be fenced to the journal's
accepted cursor. The host still needs an explicit distinction between activation
shutdown (park/host loss) and logical cancellation. Do not infer logical
cancellation from halting the generator wrapper. Wire and prove that lifecycle
before registering this adapter in the application; deadline scheduling remains
a later layer.

### Journal and lifecycle integration follow-up

The next spike uses the actual ProgramDriver protocol and in-memory journal
workflow harness. It proves completion with and without a disposable continuation
cache, cancellation before acquisition, and cancellation while release is parked.

Activation shutdown discards the evaluator handle; explicit cancellation or an
accepted cancelled outcome unwinds the logical VM. A pending cleanup can park
again and finish on the next activation. The test replaces the authority shell
and driver between activations.

Cache entries are keyed to the accepted receipt prefix, task, program and input.
Live cancellation disables further cache writes for that activation because its
state change is not yet represented in that prefix. The cache is an optimization;
the journal's replay validation is still required, and losing the cache is safe.

This is not yet a journal-native checkpoint format, a production deployment,
or targeted deadline cancellation. The next integration concerns are persistent
cache ownership/fencing and the remaining driver contracts. Keep the movie-seat
deadline scenario deferred until those core lifecycle guarantees are integrated.
