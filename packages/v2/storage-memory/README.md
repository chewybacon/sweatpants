# In-memory journal

`createMemoryJournal<Result, Request, Value, Error, State>({ program, equals })`
creates one execution's `Journal`. It uses no native scheduler protocol and can
be supplied to `activateJournal` under either runtime adapter.

- `read` returns a detached snapshot.
- `park` checks the expected revision and records a pending request plus an
  optional checkpoint. Recovering an unanswered request preserves its identity.
- `accept` appends the pending outcome and clears the pending request atomically.
  An identical duplicate returns the original accepted entry; a conflicting
  duplicate or unknown request identity fails without changing state.
- `complete` checks the expected revision and records the result. It rejects
  completion while a request remains unanswered.

Each mutation commits synchronously within one generator step. Checkpoint anchors
must match the program, accepted history length and latest receipt. Request IDs
also serve as accepted receipts. They identify deliveries, not authorization.

All stored data must support `structuredClone`. Inputs are cloned before commit,
and reads and returned entries are detached from stored state. Supply a pure
`equals` function that compares domain requests and outcomes by value; duplicate
acceptance uses that same equality policy.

This is process-local storage for assembly and acceptance journeys. State is lost
when its process ends. Revision checks reject stale activation commits but do not
constitute distributed locking. Callers are trusted: this API does not validate
wire schemas, authenticate replies, or prove checkpoint contents are correct.

## Attempt capability

The returned journal also exposes `attempts`. `begin` commits a current grant for
an existing pending request; an occupied request does not grant another delivery.
Explicit replacement compares the complete observed grant and requires recorded
and current retry safety to be repeatable. Grant identity comparisons do not use
the application's domain equality callback.

`settle` checks that the grant remains current before accepting its outcome.
Replaced grants cannot settle, including after completion. The winning grant is
retained so identical redelivery can recover the original receipt. Attempt changes
increment the journal revision. Grant state and accepted history share this
process-local store's synchronous mutation boundary.

## Interaction capability

`interactions.register` gives an unanswered request stable participant resolution
authority without an execution attempt. Registration and invalidation increment
revision; replaying registration returns the existing state. `answer` and
`invalidate` share the journal's synchronous mutation boundary, so an answer cannot
be accepted after invalidation. Invalidation after acceptance observes the original
receipt instead. Repeated invalidation preserves its first reason.

An executing attempt cannot become a participant registration, or vice versa.
Invalidation is a reply fence, not a completed workflow cancellation. The pending
request remains in the running journal and hosting reports its invalidated state.
All interaction state is process-local, just like attempt state and accepted history.

## Attempt invalidation

`attemptControl.inspect` reads an exact grant's eligibility. `invalidate` atomically
records the first reason, or observes prior acceptance. `attempts.settle` checks
that same state inside its mutation; no separate eligibility read is required.
Invalidated attempts cannot be replaced or settled, and `begin` reports their
invalidation. This retains the pending request without adding an authored failure.
`journal.accept` remains a trusted administrative bypass, not a cancellation-safe
reply endpoint. All of this control state is process-local.

## Root cancellation

`cancellation.request(id, reason)` atomically records the pending request as a
control-history boundary and revokes its delivery. It removes that pending request;
cleanup gets a distinct identity even at the same accepted-history position.
Duplicate cancellation uses the original request ID and cannot revoke cleanup.
`cancellation.finish` uses revision CAS and requires no unanswered cleanup request.
The terminal record preserves the first reason and any diagnostic cleanup failure.
All control state shares the same process-local lifetime as the journal.

## Owned children

`ensureChild(requestId, { program, input, outcome })` returns a stable `ChildLink`
and typed child journal. `outcome` is a pure projection from child Result to the
parent's reply Outcome. Reacquisition checks program/input; assembly must retain
the same type contract and projection for that program. Heterogeneous child
contracts are erased only in the adapter's private registry. This does not validate
serialized data or infer a callable tool API from a program string.

Child terminal writes prepare and clone both journal transitions before either
state is published. A throwing projection leaves both unchanged. Attempts,
participant registration and administrative acceptance cannot settle an owned
call. Completion of a cancelled child propagates cancellation to the parent;
child cleanup failure is retained while the parent drains its own cleanup.

With an active child, cancellation records `cancellationRequested` and retains the
parent request until child settlement. A child with no parked boundary yet queues
the stop until its next `park`. That park returns undefined after committing
cancellation; activation disposes its evaluator and reconstructs cancellation
before any request delivery. No extra eligibility read is added to effect commits.

The registry, queued stops and projections share the in-memory store's lifetime.
Reassembly retains these journals; exporting snapshots alone does not preserve or
restore the tree. A future durable adapter must persist topology/control and
implement cross-invocation transactions, rather than sequentially writing two
independent journals. See hosting's evaluator and notification limits.

Cancellation and parent settlement policy are prepared by the pure durable
`requestJournalCancellation` and `settleOwnedChild` transitions. The memory adapter
owns detached publication and authority maps; it does not advance an evaluator.
Pending/accepted records retain the evaluator's scope/frame boundary evidence.
Cancellation preserves a request whose phase is cleanup and omits it from revoked
attempt notifications. An active cleanup-owned child is joined without cancellation.
Replay validates frame identity as well as the domain request, so equal request
payloads cannot silently substitute a different reconstructed scope.

Critical-region identity is also retained in boundary evidence. The same pure
cancellation transition preserves critical body requests and their owned children;
no additional storage read or separate mask registry is needed. Replay reconstructs
the live mask from the pinned program and validates its recorded identity. It does
not infer acquisition completion from an interrupted host or an elapsed deadline.
