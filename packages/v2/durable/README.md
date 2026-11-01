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

`activateJournal` is the one-shot API that owns a disposable scope. Its shared
`advanceJournal` primitive attempts one boundary publication in the caller's scope;
undefined means queued cancellation requires another advancement. It has no cache or
lifetime policy. Hosting middleware can own a longer scope around this same primitive.

`recover(plan)` retains its single-argument contract. `advance(current, plan)` reconciles
a live continuation with an anchored accepted prefix and cancellation control through
the same execution API. Fresh recovery uses that operation too. Its scope and execution
driver must still be live. Cancellation bookkeeping is local to the incarnation; no
journal fields or serialized continuations are added. Checkpoint middleware continues
to select initial recovery and has no retention-specific branch.

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

## Journal binding and backend transactions

`createJournalBinding` owns acceptance, cancellation and owned-child decisions
internally. Storage adapters implement `JournalBackend`; they do not call individual
transition helpers or publish transition results themselves.

The port supplies asynchronous-capable transaction-local `JournalRecords` operations.
Resolve external dependencies before entering the transaction. Only storage operations
may suspend inside it; eligibility reads and updates share one serializable ownership
domain. The backend commits atomically or rolls back, then publishes local bindings
synchronously after confirmed commit and before another transaction can intervene.
A separate inspect call is not authority for a later commit.

Transaction bodies receive `JournalTransaction<Y>`, exposing record access and
an operation for registering local commit obligations:

```ts
const result =
  yield *
  backend.transact(function* (transaction) {
    yield* transaction.onCommit(() => publishBindings(staged));
    return yield* work(transaction.records);
  });
```

Registration happens when the operation advances. The interpreter consumes its
opaque `TransactionInstruction`; only native storage yields reach the scheduler,
and the body's result remains inferred. Registration operations can be composed
with existing callable middleware. Constructing an unused operation has no effect;
foreign or closed transaction registrations reject. Publications run in registration
order, while rollback discards them.

Adapters use `createJournalTransaction<Y>()` once per transaction. Its `run(records,
work)` interprets the body; after confirmed database commit, `publish()` runs
synchronously before any suspension or release. `close()` runs on every exit and
discards retained registrations. It does not commit, roll back, or release database
resources. Those physical responsibilities remain with the adapter, including joining
an asynchronous commit during disposal. Unknown commit outcomes still require
reconciliation.

Publications are trusted synchronous, nonthrowing local bookkeeping, not remote
notifications or asynchronous effects. If one throws, later publications do not run;
the database is already committed and must not be reported as rolled back. The
interpreter forwards native iterator behavior without adding guarantees for arbitrary
yielding JavaScript finally blocks or nested database transactions.

This is the single journal implementation for memory and SQLite. `OwnedJournal`
contains the existing combined capability shape formerly defined by MemoryJournal;
it is not another authored tool or execution species. `JournalRecord` is an adapter
record, not a replacement for the smaller recovery-facing JournalSnapshot. Records
include authority, historical ownership, reverse links and queued cancellation.

Each open has fresh trusted projection bindings. The binding registry is staged
inside the transaction decision and published to the assembly only on success.
Stored data contains no evaluator handles, projections or stop callbacks. Reacquire
children from the owning root with the pinned program/input before running them.
Neither a decoded record nor an arbitrary program string validates authored types.

## Root invocation admission

Owned journals expose `admit(program, input)` for trusted normalized root input.
The existing transaction boundary checks program identity and pins input exactly once,
incrementing revision without adding an accepted effect row. Equal submissions use
configured domain equality and return the stored value; conflicting input rejects.
Admission remains visible in snapshots after completion or cancellation. It rejects
first admission after execution has advanced and rejects owned children, whose input
is already pinned by `ensureChild`. Journals used directly without input admission
continue to work; a tool host requires admission before acquiring its body.

Schema validation belongs outside this transaction. `@sweatpan.ts/tools` provides
`admitTool` for that boundary; recovery consumes stored normalized input directly.

## Ordered owned groups

`ensureChildren` atomically binds a nonempty, ordered sibling group to one pending
parent request. `ensureChild` uses the same path with one child. Reacquisition checks
count, order, program identities and pinned inputs. The original pure projection is
retained within an open assembly; reopening requires rebuilding trusted bindings.

Children advance independently through ordinary hosting. Completed siblings stay
completed across recovery. The final child completion and one projected parent
acceptance commit together, with results in declaration order. A projection exception
rolls back that transaction. All ownership records must share one transaction domain.

Parent cancellation fences eligible siblings and descendants atomically, then waits
for every child's logical cleanup before advancing parent cleanup. Critical and cleanup
scopes retain their existing protection. Independent child cancellation also requests
parent cancellation and fences siblings; protected calls require explicit reconciliation.
Delivery exceptions leave attempts unsettled. An authored failure Outcome is ordinary
result data unless the author or hosting policy interprets it otherwise.

This first slice exposes homogeneous child journals, not a public heterogeneous
`ctx.all` authoring API. The acceptance tracer handles an empty authored group locally.
It uses native `runtime.all` only to schedule child hosts; durable ownership and joining
belong to the journal. Settlement reads sibling headers, O(group size) per completion;
it does not hydrate their accepted histories. Large-group optimization is deferred.

`ensureChildren({ join: "race", ... })` pins the first terminal completed child's
identity in the request record and fences eligible losers in that same transaction.
The join policy is immutable on reacquisition. Projection receives a singleton winner
array only after all siblings become terminal. Parent cancellation takes precedence;
loser cleanup failures follow cancellation/reconciliation rules. The default `"all"`
continues to project all values in declaration order. Neither policy turns delivery
exceptions into accepted results.

## Pre-delivery conflicts

`JournalConflict` distinguishes obsolete revision writes, participant registration,
attempt acquisition and initial owned-group acquisition from other failures. Direct
journal calls still throw. A host may reread current authority and reactivate after
this error; it must not infer permission to redeliver an effect. Invalid grants,
settlement rejection, replay divergence and storage failures are not this signal.

## Attempt command interception

`createAttempts(composition, name, journal.attempts)` exposes whole begin/settle
commands as an optional ordinary Api. This is an assembly/transport boundary, not
middleware inside a journal transaction. An observer can throw after `next` has
committed; failed acknowledgement never authorizes redispatch of external work.
Atomic transitions, projections, commit publication and record access remain private.

## Read-only owned-tree navigation

`OwnedJournal` also implements `JournalReader`: `id`, `read()` and
`openChild(childId)`. Opening a child checks the persisted direct parent link and
retained parent request, then returns only those three observation members. It does
not create children, acquire Guests, install result projections or mutate journal
state. Active links come from a running snapshot's `children`; a saved historical
direct-child identity remains readable after settlement. Navigate each level rather
than opening a grandchild directly from the root.

Child payloads are `unknown`; the application decodes the program's contracts.
The handle is bound to the current storage connection and must be obtained afresh
after reopening. This is trusted storage navigation, not authorization or redaction.
A caller that needs to answer an interaction uses a separately authorized writable
parent. `parent.openChildInteractions<Q, V, E>(childId, expectedProgram)` verifies the
same persisted direct ownership link and the expected program, then returns a child
link and a narrow journal with only `id` and `interactions.request/answer`. It does not
create children, install result projections, acquire Guests or advance execution.
Read-only child handles do not expose this operation.

The type arguments describe the pinned child's protocol supplied by trusted assembly;
they do not decode or validate stored bytes. Request lookup resolves the exact grant,
including accepted terminal retries. Answer acceptance still atomically checks that
grant after validation. Opening ingress is not a lease or participant authentication.
The handle remains tied to its storage connection and must be reopened with a fresh
parent after closing it.

Answer acceptance updates child history and activation intent while leaving the child
nonterminal. A later execution pass reattaches the original result projection through
`ensureChild` or `ensureChildren` before terminal child settlement. This keeps external
answer ingress independent of application-specific batch history and completion policy.

`createJournalPresentation` in hosting accepts these readers. Recursive traversal
remains application assembly: each node is a separate snapshot with its own revision,
not a globally atomic frontier. A reader sees registered interactions, including
cleanup interactions; it cannot advance a yielded branch to register a new one.
A root scheduling result is not an inventory of its descendants' interactions, and
persisted `running` is not evidence that a physical owner is currently executing.

The `tree-frontier.acceptance.test.ts` application exercises nested Lua body waits
alongside cleanup repair on memory and SQLite under both native runtimes. It covers
reader-free advancement, observation during an in-flight cleanup effect, fresh-reader
reopen, either answer order, occupied/yielded siblings, cancellation, invalid ownership
navigation, and historical child reads. SQLite evidence is in-process connection
reopen; no process-crash, cross-journal snapshot or external-service guarantee is added.

## Descendant answer ingress

`owner.openDescendantInteractions(executionId)` opens only request/answer methods for
an existing descendant at any depth. It walks persisted reverse parent links back to
the supplied owner, verifying every edge against the retained parent's child entry and
the child's pinned program in one transaction. It rejects missing, unrelated, cyclic
or inconsistent ancestry, and rejects the owner itself. Use `owner.interactions` for
that execution's own questions.

The return shape is `OwnedChildInteractions<unknown, unknown, unknown, Y>`. Its link
provides the stored program; the application must check that program against its
interaction catalog, decode the request, authorize the participant and validate input.
No caller-supplied path or program selects the stored authority. Possession of an
execution ID alone does not authorize access: the caller must first be authorized to
use the owner capability. A child owner can reach its descendants, not siblings or
ancestors.

Unlike `openChildInteractions<Q, V, E>(id, expectedProgram)`, this operation supports
arbitrary depth and does not assert a typed child protocol. Both return only narrow
request/answer authority, never an executable child journal or recursive mutation API.
`JournalReader` exposes neither opener. All handles remain connection-bound.

The ancestry walk costs O(depth) record/link lookups, not a scan of accepted parent
history. It creates no child, installs no result projection and performs no Guest work.
Historical answers remain reachable while retained ownership evidence exists. Missing
or pruned evidence fails; there is no fallback to a frontend frontier or cached path.
Ancestry validation and later answer acceptance are separate transactions; the exact
resolution grant is still rechecked when the answer is submitted.

The nested Lua consumer uses this operation after reopen and after completed/cancelled
settlement. Its prior history scan and projection reconstruction were removed from
answer ingress. Program contracts, role checks and schema parsing remain application
policy. Memory/SQLite journeys exercise subtree boundaries and projection-free answers;
a scripted storage peer supplies inconsistent/cyclic evidence to verify rejection.
