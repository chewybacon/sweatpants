# Replay-first recovery

`createRecovery` builds a scoped API over a bound `GuestWork`. Its default recover
operation starts a fresh Guest, verifies each accepted request, and supplies its
recorded Outcome. Reconstruction never invokes a business handler. The result
contains the live Guest, its current Turn and the number of accepted outcomes
reflected in that Turn. The executing scope owns Guest disposal.

`createCheckpointMiddleware` is ordinary `OperationMiddleware` over that API.
For a compatible checkpoint it restores evaluator state and replays only the
accepted suffix. Missing/unsupported checkpoints delegate to the replay default.
Outer policy can remove the checkpoint from the plan to force full replay. Errors
from a supported restore propagate; corruption does not silently become replay.

Capture is optional. The default returns undefined; the middleware asks its
checkpoint adapter to capture a suspended Guest it owns. Completed Turns do not
need a checkpoint. Snapshots contain evaluator state, while the recovery envelope
binds it to a program identity, accepted position and receipt. Unknown Guest
implementations remain replay-capable without implementing capture or restore.

## Ownership and trust

Plans are supplied by a trusted host with immutable accepted history. Receipt
identities must uniquely identify immutable accepted entries; their authenticity
and contents are not established by this package. The program identity must pin
code, bound input and replay-relevant configuration. The request comparator is
owned by the host's domain protocol. Replay requires retained history and
reproducible computation between requests.

Validation checks contiguous sequences, distinct receipts, program identity and
checkpoint position/receipt. Each replayed request must match its accepted entry.
These are consistency checks, not authentication, journal admission or a substitute
for wire decoding. When using low-level recovery directly, a host persists Outcomes before resuming
the Guest and updates
the returned position/Turn after each newly accepted outcome. Capturing a stale
Recovered value is not a way to discover the Guest's actual journal position.

Scope finalizers dispose acquired/restored Guests after success or replay failure.
An evaluator owns cleanup during a failed/interrupted restore before it returns a
handle. Disposal must not run logical workflow cancellation.

## Journal-owned activation

`activateJournal(composition, recovery.operations, journal)` owns one bounded
activation in a child scope. It reads accepted history, recovers the Guest, and
atomically records either a pending request (with an optional checkpoint) or the
completed result. Its return value is `Activation<Result, Request>`. The scope
joins physical Guest disposal before returning. It only delivers logical cancellation
when that intent is already recorded. A persisted terminal result returns without
acquiring an evaluator.

The host delivers the pending request and calls `journal.accept(id, outcome)`.
Acceptance records the outcome without advancing computation. A fresh activation
then reconstructs from accepted history. Callers do not update recovery positions
or retain a live Guest across activations. Replay and checkpoint middleware share
this path; handler execution remains outside it.

`Journal` is the storage capability. `@sweatpan.ts/storage-memory` implements it
with revision checks, stable pending identities and duplicate acceptance checks.
The host must bind the journal to the correct execution and program, decode wire
values, and decide how to handle uncertain external effects. Revision checks
reject stale commits; they do not provide distributed leases or fencing.

## Evidence

Recovery acceptance journeys enter through journal activation with the real
pinned Lua/Wasm evaluator and a scripted protocol peer. Reservation and approval
replies are accepted into the journal before a fresh host reconstructs from replay
or checkpoint plus suffix replay. Both paths reach the same cleanup request and
result. Command counts prove restore skips the prefix, and peer counts prove
reconstruction does not repeat accepted effects. An iterator-only application
completes through the same journal path without checkpoint capabilities.

The application exercises Around on acquisition, OperationMiddleware on recovery,
and the Middleware value-signature shorthand on domain requests. Both native
runtimes run the same application. Unsupported/disabled checkpoints fall back;
storage faults involving corrupt snapshots, wrong anchors/programs, invalid
history and divergent requests fail activation without changing the journal.
Source/emitted type checks retain the decoded result type through activation.

Additional journal journeys cover unanswered recovery, duplicate and conflicting
replies, competing activation commits, mutation isolation, physical Guest disposal
and persisted completion without evaluator acquisition.

Only detached in-process journal state and snapshots survive between activations.
The memory journal does not establish disk persistence, OS-process crash recovery,
exactly-once external effects, or OS-persistent cancellation.

## Root cancellation control history

A `RootCancellation` records the unanswered request, its ID, the accepted-history
position and first reason. It is control data, not an accepted domain failure.
Replay reconstructs the original request, validates it, calls `guest.cancel` there,
then resumes the accepted cleanup suffix. An evaluator without cancellation support
rejects reconstruction explicitly. Assembly must select a capable evaluator.

Current checkpoint formats only anchor accepted outcomes. Cancellation recovery
therefore falls back to replay even with checkpoint middleware installed, and
activation does not capture checkpoints while unwinding. Supporting checkpointed
unwinding requires an explicit control-history anchor and evaluator support.

The optional journal cancellation capability atomically records intent and revokes
the current delivery. Activation drives cleanup through its existing park/complete
path, committing cancelled completion (including a diagnostic failure string when
unhandled cleanup fails). Successful completion cannot override cancellation.

## Execution middleware across recovery strategies

Recovery exposes its inferred execution API as `recovery.execution`. Install layers
in a surrounding scope; each activation binds its acquired or restored Guest in
its own scope before replay:

```ts
yield *
  recovery.execution.around({
    *cancel([reason], next) {
      trace("cancel", reason);
      return yield* next(reason);
    },
  });

yield *
  recovery.around(
    createCheckpointMiddleware({
      program,
      adapter: evaluator.checkpoints,
      execution: recovery.execution,
      matches,
    }),
  );
```

The checkpoint middleware now takes that execution API rather than a composition
argument. Both strategies use its start/resume/cancel methods; restore already
supplies a Turn and therefore does not call start again. The shared private replay
interpreter retains history matching and sequencing. Raw Guest identity is retained
in Recovered for checkpoint capture and exact-instance disposal.

This changes composition, not the history representation. Root cancellation remains
anchored in RecoveryPlan, and checkpointed unwinding remains unsupported. Acquisition
and restoration must execute in an owning scope; journal activation supplies it.

Hosted acceptance journeys verify inherited middleware during fresh and restored
replay, root-cancellation interception, sibling driver isolation, child overrides,
and disposal of the original incarnation even when advancement is redirected.
