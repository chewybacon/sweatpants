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
