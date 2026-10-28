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

## Reopening retained records

`createMemoryJournalStore<Result, Request, Value, Error, State>(options)` retains
one owned tree independently of its handles. `store.open()` returns a fresh typed
root journal with an empty projection registry. `createMemoryJournal(options)`
remains the convenience form for creating a store and opening it once.

```ts
const store = createMemoryJournalStore<string, string, string, string>({
  program: "booking:v1",
  equals,
});
const first = store.open();
// Dispose the host using first; retain only the store for the next assembly.
const recovered = store.open();
// Assemble recovery/hosting with recovered and the same pinned program.
// Rebind owned calls through recovered.ensureChild(id, { program, input, outcome }).
```

Each open has independent code bindings over shared authoritative records. Previously
opened handles remain valid and observe current records; reopening does not revoke
an attempt, cancel a workflow, or dispose a host. The caller owns host lifetimes.
Reacquiring an owned call validates its recorded program/input and binds the supplied
projection in the new assembly. Access starts at the root: there is no arbitrary
child-ID open that could bypass parent-call rebinding. Within an assembly, the first
projection for a child remains selected.

Hosted journeys reopen pending participant authority, accepted history, replaced and
revoked attempts, duplicate receipts, historical child links and queued pre-boundary
cancellation. Child success uses the newly assembled projection; cancelled results
skip it. This proves in-process handle/binding reconstruction, not serialization,
wire validation, disk durability or process-crash recovery. Lua hosting also reopens
after accepted delivery with a fresh journal handle, evaluator, recovery API and
host. Its journeys cover replay-only, checkpoint restore and fallback for an
unsupported checkpoint format, without repeating the accepted external effect.

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
contracts are erased only at the adapter's internal record/binding boundary. This does not validate
serialized data or infer a callable tool API from a program string.

Child acquisition commits a child record, historical parent/request link and reverse
parent link together. Reacquisition creates a fresh typed handle to that same record;
no child journal handle or stop/settlement closure is retained in storage.

Child terminal writes prepare and clone both journal transitions before either
state is published. A throwing or unencodable projection leaves both unchanged. Attempts,
participant registration and administrative acceptance cannot settle an owned
call. Completion of a cancelled child propagates cancellation to the parent;
child cleanup failure is retained while the parent drains its own cleanup.

With an active child, cancellation records `cancellationRequested` and retains the
parent request until child settlement. A child with no parked boundary yet queues
the stop until its next `park`. That park returns undefined after committing
cancellation; activation disposes its evaluator and reconstructs cancellation
before any request delivery. No extra eligibility read is added to effect commits.

Records contain snapshots, attempt/participant authority, queued stops and ownership
links. Projections live in a separate trusted binding registry keyed by child identity;
reacquisition retains the original projection within each open assembly. The tree
remains process-local; reopening retains its records and creates fresh code bindings.
There is no serialization API. Exporting snapshots alone does not preserve authority
or topology.
See hosting's evaluator and notification limits.

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

## Owned-tree transaction boundary

Acceptance, attempt claims/replacement/revocation, participant registration/replies,
root cancellation, parking and completion use the same synchronous internal
transaction executor. Snapshot, authority maps and queued stop intent are staged
and cloned with the acknowledgement before publication. A failed decision or clone
leaves those records unchanged. Eligibility and settlement have no intervening
inspect operation, scheduling boundary or storage round trip.

A queued stop and its first parked boundary publish together; the abandoned body
request never becomes available for delivery. Cancellation walks the eligible
descendant chain in one draft and publishes once; it stops at protected cleanup or
critical boundaries. There is no after-commit stop callback or notification window
in which a descendant can accept a late reply. Terminal writes locate the parent
through stored ownership and prepare its transition in that same transaction.
Projection is skipped when parent cancellation has already won.

Hosted journeys prove encoding-failure rollback, retained occupancy, resubmission
without provider redelivery, duplicate/conflicting replies after completion, failed
cleanup parking with retained cancellation authority, and completion retry without
repeating accepted cleanup. Existing replacement, interaction, cancellation,
critical-region and owned-child journeys exercise these same paths. A three-level
hosted tree proves immediate leaf reply fencing and leaf-to-root cleanup through
reacquired handles. Both throwing and unencodable projections leave parent and
child records unchanged and allow recovery.

This is one process-local transaction domain for an owned tree, not a public storage
port, disk-backed store or SQLite implementation. The memory executor clones the
whole tree to stage and publish writes; its cost grows with retained tree history.
A database adapter should select affected records and append accepted entries,
not copy the tree. Cross-domain ownership needs a separate protocol.
