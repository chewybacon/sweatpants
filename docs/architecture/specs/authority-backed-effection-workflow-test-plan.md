# Test Plan: Authority-Backed Effection Workflow: Record Vertical Path

## Status

Draft

## 1. Overview

This plan verifies the test-only record vertical path defined by the approved
normative specification. The main risk is not record value computation. The
main risk is the interaction between Effection scope ownership, a constrained
Workflow effect, host coordination, and Journal Authority commit rules.

The primary test layer is a deterministic outside-in protocol rig. It runs a
real proof Workflow, attachment resource, host coordinator, scoped authority
ports, and current authority shell. The same causal scenarios run against
in-memory and stored shell modes where the requirement applies.

Targeted unit tests cover the pure semantic fold, comparator, validation, and
compile-time authoring boundary. A small E2E layer verifies package exports,
build wiring, and one complete stored live-then-replay path.

**Specification**:
[`.pi/specs/authority-backed-effection-workflow-spec.md`](./authority-backed-effection-workflow-spec.md)

## 2. Test Objectives

- Prove that TypeScript accepts proof effects and rejects unwrapped ordinary
  Operations in `Workflow<T>`.
- Prove that Effection creates and tears down the resource, Workflow,
  effect-evaluation, supervisor, and attempt Task scopes in the specified tree.
- Prove that buffered proposals cannot be lost before the host waits.
- Prove intent commit before closure execution and settlement commit before
  Workflow resume.
- Prove live and reconstructed success, error, and cancellation behavior.
- Prove that settled replay does not invoke the closure or its middleware.
- Prove the unsafe produced-but-unaccepted outcome window and retained
  `effect_outcome_indeterminate` result.
- Prove complete decision reevaluation after a real stored CAS conflict.
- Prove that a pure fold of accepted records agrees with current public
  authority observations after each transition.
- Prove that capabilities and live Effection values do not cross into Workflow
  messages or semantic projection.
- Prove deterministic cleanup on all success and failure paths.
- Verify the pass or reject evidence gate without authorizing production use.

## 3. Risk-Focused Diamond Strategy

### 3.1 System boundary

The primary system under test begins at the root Activation Operation and ends
at these observable boundaries:

- `ProofProgramAttachmentHandle` commands and events;
- `JournalAuthorityPort` command and query results;
- `AuthorityJournalPort.readTree()` records;
- the deterministic `ExecutionStorePort` server-compatible binding in stored
  mode;
- root Workflow terminal behavior; and
- Effection lifecycle finalizers owned by the test rig.

The system under test includes:

- the proof Workflow and `record()`/`ephemeral()` effects;
- the attachment resource, Queues, resolvers, command supervisor, and attempt
  Task;
- the proof host coordinator;
- real Journal Authority port facades and middleware;
- current in-memory and stored shell decision paths;
- current descriptor, capability, schema, digest, receipt, and canonical JSON
  code; and
- the pure record execution fold and comparator.

The rig does not call authority decision functions directly. It does not replace
port methods with fabricated results.

### 3.2 Layer shape

#### Widest layer: outside-in protocol scenarios

Most behavior is tested through causal generator-style scenarios over the full
system boundary. One scenario may cover many requirements. The shared rig is
parameterized by `memory` and `stored` modes. It drives only semantic operations
such as reserve, authorize, settle, detach, reconstruct, and leave scope.

These scenarios assert public outcomes and accepted records. They inspect
captured store requests only when commit ordering, CAS input, or retry behavior
is part of the contract.

#### Narrow lower layer: focused unit and compile-time tests

Unit tests cover logic with high edge-case density:

- valid and invalid record descriptor inputs;
- pure fold transitions and malformed history;
- fold-to-public-view normalization and mismatch detection;
- closed protocol discriminants and exhaustive switches; and
- static package/export and secret-field checks.

TypeScript fixtures cover the authoring boundary. Positive fixtures contain no
suppression. Negative fixtures use `@ts-expect-error` so a missing compiler
error fails the package check.

#### Narrow upper layer: real package E2E smoke paths

The E2E layer is small:

- import the proof only through `@sweatpants/journal-authority/testing`, run the
  package build and type check, and verify that the root package does not expose
  proof symbols; and
- run one complete stored live success followed by fresh reconstruction through
  package exports.

The E2E layer does not repeat the full protocol matrix.

### 3.3 Dependency simulation and real-client rule

There is no external HTTP service or third-party SDK in this proof. The test
plan therefore does not introduce an HTTP simulator.

Stored scenarios use a deterministic server-compatible implementation of the
real `ExecutionStore` contract installed behind `ExecutionStorePort`. The real
stored shell, port facade, request objects, serialization, object storage,
journal segments, retry loop, and response parsing remain in the request path.
The binding captures actual `loadControl`, `commitExecution`, `putObject`,
`getObject`, journal segment, replay segment, and read requests as needed. It
can hold a request pending and return a protocol-valid success, conflict, or
failure response. It does not replace stored-shell or authority methods.

If implementation introduces an external network client, tests must redirect
that real client to a deterministic local server. They must not replace client,
SDK, adapter, or provider methods with return-value stubs. The simulator must
capture real requests and verify that no request remains unanswered at
teardown.

The record closure is application code supplied to the proof. Scenarios may use
a causal test closure that reports `attempt-entered` and
`attempt-outcome-produced` through Effection Queues and resolvers. This is an
observable application operation, not a replacement for an authority or store
client.

### 3.4 Protocol rig

The rig exposes semantic generator Operations. Illustrative names are:

```ts
interface ProofScenario {
  openRoot(options: RootOptions): Operation<RootHandle>;
  expectAttachmentProvided(): Operation<void>;
  startAndExpectRecord(): Operation<RecordProposalHandle>;
  reserveLive(proposal: RecordProposalHandle): Operation<AuthorizedAttempt>;
  expectReservationCommitted(attempt: AuthorizedAttempt): Operation<void>;
  authorize(attempt: AuthorizedAttempt): Operation<AttemptOutcomeHandle>;
  expectAttemptEntered(): Operation<RecordAttemptContext>;
  produceAttemptOutcome(outcome: OperationOutcome): Operation<void>;
  expectAttemptCompleted(): Operation<OperationOutcome>;
  acceptResolution(): Operation<ResolutionReceipt>;
  expectResolutionCommitted(): Operation<void>;
  confirmAndResume(): Operation<ProofProgramEvent>;
  loseSettlementPath(): Operation<void>;
  detachAttempt(): Operation<void>;
  leaveActivation(reason?: ProgramShutdownReason): Operation<void>;
  reconstruct(): Operation<RootHandle>;
  foldAndCompare(): Operation<RecordExecutionIndex>;
  expectNoClosureEntry(): Operation<void>;
}
```

Stored mode adds semantic store controls:

```ts
interface StoredScenarioControls {
  expectCommit(kind: "reservation" | "resolution"): Operation<PendingCommit>;
  commit(request: PendingCommit): Operation<void>;
  conflictWithCompetingCommit(request: PendingCommit): Operation<void>;
  failCommit(request: PendingCommit, error: StoreError): Operation<void>;
  exhaustConflicts(kind: "reservation" | "resolution"): Operation<void>;
}
```

Each control acts on a real pending store request. A test never advances an
internal authority reducer by hand.

### 3.5 Semantic barriers

Scenarios synchronize only at named semantic barriers:

1. `attachment-provided`
2. `proposal-buffered`
3. `start-exchanged`
4. `reservation-commit-pending`
5. `reservation-committed`
6. `attempt-entered`
7. `attempt-outcome-produced`
8. `attempt-completed`
9. `resolution-commit-pending`
10. `resolution-committed`
11. `reservation-confirmed`
12. `workflow-resumed`
13. `terminal-event`
14. `cas-conflict-observed`
15. `attempt-detached`
16. `resource-finalized`

A barrier is backed by an observed Queue item, port result, accepted journal
record, captured store request, or finalizer resolver. No barrier uses elapsed
time, polling, or a call count.

### 3.6 Observables

Tests assert:

- attachment command results and terminal events;
- closure entry, context, produced outcome, and cleanup;
- Workflow code reached before and after the record boundary;
- public authority command and query results;
- accepted journal payloads, offsets, digests, and receipts;
- folded semantic index values;
- captured store request shape and CAS result when relevant;
- package export resolution and type declarations; and
- lifecycle finalizer completion.

Tests do not inspect mutable private `AuthorityState` as the expected result.
Private authority values may be used only as unique leak sentinels in a
recursive absence check, after the real authority minted them.

### 3.7 Teardown contract

`withProofScenario()` owns all resources. Its finalizer runs after successful or
failed scenario bodies and verifies:

- command and event Queues are closed;
- every command and boundary resolver has settled;
- the attachment resource, Workflow Task, effect-evaluation Task, command
  supervisor, and attempt Task have finalized;
- closure and middleware cleanup has run once where entered;
- no store request is pending, unanswered, or unconsumed;
- no authority command or attachment event occurs after disposal; and
- all installed port drivers and Context values leave scope.

The rig includes self-tests that deliberately leak each tracked class and prove
that teardown fails. Self-tests release the leak through a causal handle after
they observe the expected harness failure; they do not use a timeout.

### 3.8 Execution matrix

| Scenario class | Memory shell | Stored shell | Compile/static |
| --- | ---: | ---: | ---: |
| Live success and reconstruction | Yes | Yes | No |
| Accepted error and cancellation | Yes | Yes | No |
| Unsafe indeterminate loss | Yes | Yes | No |
| Reservation/resolution rejection | Yes | Yes | No |
| Real CAS conflict/exhaustion | No | Yes | No |
| Transition fold comparison | Yes | Yes | No |
| Resource and Context topology | One shared mode | One E2E confirmation | No |
| Workflow type boundary | No | No | Yes |
| Fold malformed-history corpus | No | No | Yes |
| Export, dependency, and change audit | No | No | Yes |

### 3.9 Tools and commands

- Effection `4.1.0-alpha.9` for scenario and lifecycle Operations.
- TypeScript `5.9.3` through the package `check` script.
- Vitest `3.0.5` for unit, protocol-rig, and E2E tests.
- Existing `JournalAuthorityPort`, `AuthorityJournalPort`, and
  `ExecutionStorePort` installation seams.
- Existing memory/stored authority shell constructors.
- Node file and module APIs for package/export and evidence checks.
- Git read-only status and diff commands for the change-scope audit.

Expected verification commands are:

```text
pnpm --filter @sweatpants/journal-authority check
pnpm --filter @sweatpants/journal-authority test
pnpm --filter @sweatpants/journal-authority build
```

A repository-wide check may follow if the proof changes shared test
configuration. The evidence report records the exact commands used.

### 3.10 Coverage goal

Every MUST and MUST NOT statement in REQ-001 through REQ-044 and REQ-046
through REQ-049 has positive or negative coverage. REQ-045 is covered because a
pass verdict should include the migration map. The many-to-many matrix in
Section 7 is the source of coverage truth.

## 4. Test Cases

### TC-001: Quarantine, production isolation, and forbidden primitive audit

- **Requirements**: REQ-001, REQ-002, REQ-018, REQ-044
- **Type**: Unit / static conformance
- **Priority**: High
- **Preconditions**: Proof source and testing export exist; package source is
  available.
- **Steps**:
  1. Resolve the package root, `./testing`, and every production subpath.
  2. Assert that proof symbols resolve from `./testing` only.
  3. Walk production imports and exports with TypeScript module resolution.
  4. Assert that no production file imports, registers, or selects proof code.
  5. Inspect proof messaging imports and construction sites for Queue, Signal,
     and Channel use.
  6. Inspect production descriptor, command, record, snapshot, and error unions
     for proof-only variants or selectors.
- **Expected Result**: Only the testing subpath exposes the proof. Production
  composition and durable unions have no proof selector. Internal proof traffic
  uses Queue, not Signal or Channel.
- **Notes**: A Signal is allowed only if the audit identifies a synchronous
  callback source and its focused adapter test.

### TC-002: Compile-time Workflow and Effect boundary

- **Requirements**: REQ-005, REQ-006, REQ-037, REQ-046
- **Type**: Compile-time
- **Priority**: High
- **Preconditions**: Package type fixtures are included by the repository
  TypeScript configuration.
- **Steps**:
  1. Compile a Workflow with synchronous code, one `record()`, and one
     `ephemeral()`.
  2. Compile an assignment from `DurableProgramEffect<T>` to pinned
     `Effect<T>`.
  3. Compile a fixture with direct `yield*` of an ordinary Operation under a
     checked `@ts-expect-error`.
  4. Compile a fixture that passes a plain Operation as a Workflow child under a
     checked `@ts-expect-error`.
  5. Run the package `check` command with the locked toolchain.
- **Expected Result**: Positive fixtures compile. Both forbidden uses produce
  required TypeScript errors. The Effect assignment succeeds without an
  Effection patch.
- **Notes**: Remove each `@ts-expect-error` in a fixture self-check to confirm
  that the compiler reports the underlying mismatch.

### TC-003: Record descriptor validation and proposal separation

- **Requirements**: REQ-007, REQ-008, REQ-022, REQ-024, REQ-049
- **Type**: Unit
- **Priority**: High
- **Preconditions**: `record()` and canonical JSON helpers are available through
  the testing boundary.
- **Steps**:
  1. Build record effects for default, repeatable, unsafe, and both idempotent
     retry modes.
  2. Inspect and canonicalize each serializable proposal.
  3. Try empty, 128-byte, 129-byte, malformed retry, extra-key, and non-function
     inputs.
  4. Use a closure that captures unique Scope, Context, Queue, resolver, Task,
     handle, transport, and secret sentinels.
  5. Recursively inspect the host-visible proposal and event.
  6. Run the one-record root and assert action indices `0` then `1` and
     synchronous pre/post calculations.
- **Expected Result**: Valid descriptors retain exact current shape and default.
  The 128-byte key passes; invalid cases retain descriptor errors. Captured
  runtime and secret values never enter a serializable message. The root emits
  one proposal and one terminal event.

### TC-004: Pure fold of complete record histories

- **Requirements**: REQ-032, REQ-033, REQ-034, REQ-047
- **Type**: Unit
- **Priority**: High
- **Preconditions**: Deep-frozen accepted-history fixtures exist for live
  success, error, cancellation, and active frontiers.
- **Steps**:
  1. Fold each deep-frozen fixture twice.
  2. Compare both outputs for deep equality and input records for no mutation.
  3. Assert task identity, origin, pinned artifact, input, lifecycle, action and
     pull positions, descriptor, attempts, settlement, digest, offset, and
     terminal outcome.
  4. Convert maps to sorted entries and serialize the index.
  5. Verify prior fixture entries remain byte-identical when a later accepted
     record is appended.
- **Expected Result**: The fold is deterministic, complete, serializable after
  deterministic map conversion, and append-only with respect to accepted input.

### TC-005: Fold rejects malformed history corpus

- **Requirements**: REQ-033
- **Type**: Unit
- **Priority**: High
- **Preconditions**: A valid minimal root-record history is available as the
  mutation base.
- **Steps**:
  1. Create one fixture for each: offset gap, non-monotonic offset, conflicting
     event ID, duplicate task, unknown task, unknown pull, conflicting action,
     conflicting pull identity, invalid attempt transition, duplicate
     settlement, unknown settlement attempt, premature task close, and
     dependent-record reorder.
  2. Fold each fixture.
- **Expected Result**: Every malformed fixture fails with a deterministic fold
  validation error and returns no partial index.

### TC-006: Fold unsafe and outcome-unknown histories

- **Requirements**: REQ-031, REQ-032, REQ-034
- **Type**: Unit
- **Priority**: High
- **Preconditions**: Fixtures model current unsafe detach records and an
  `AttemptOutcomeUnknown` variant.
- **Steps**:
  1. Fold `AttemptStarted`, `AttemptDetached`, `PullIndeterminate`,
     `AttemptAbandoned`, and authority-created `PullResolved` in order.
  2. Inspect the attempt frontier after each prefix.
  3. Fold a history that contains `AttemptOutcomeUnknown` without a settlement.
  4. Search both results for the unaccepted closure-value sentinel.
- **Expected Result**: Frontier status follows started, detached, indeterminate,
  and abandoned. The pull settlement contains only the authority-created error.
  `AttemptOutcomeUnknown` marks indeterminate without inventing settlement. The
  local value is absent.

### TC-007: Fold comparator normalization and mismatch detection

- **Requirements**: REQ-035
- **Type**: Unit
- **Priority**: High
- **Preconditions**: Equivalent memory/stored public views and folded indices
  exist, plus one mutant per semantic field.
- **Steps**:
  1. Compare equivalent views with deployment storage metadata differences.
  2. Change task identity, action index, pull ID, attempt ID, descriptor,
     outcome, digest, resolution offset, and terminal lifecycle one at a time.
  3. Add private authority fields to the public-view input.
- **Expected Result**: Allowed storage metadata normalizes. Every semantic mutant
  fails. Private fields are ignored as non-semantic input and never enter the
  folded result.

### TC-008: Closed protocol algebra and exhaustive handling

- **Requirements**: REQ-022, REQ-023
- **Type**: Unit / compile-time
- **Priority**: High
- **Preconditions**: Protocol type fixtures and dispatcher are available.
- **Steps**:
  1. Compile exhaustive switches over all command and event discriminants.
  2. Canonicalize every host-visible variant.
  3. Assert proposal has no outcome and attempt-completed has a required
     outcome.
  4. Assert the proof types contain no optional `authorizedOutcome`.
  5. Add a checked compile fixture showing an unknown variant is rejected.
- **Expected Result**: The algebra is closed, serializable, and phase-specific.
  Missing or unknown discriminants fail compile or validation.

### TC-009: Live record success through both authority shells

- **Requirements**: REQ-003, REQ-007, REQ-013, REQ-016, REQ-019, REQ-022,
  REQ-024, REQ-025, REQ-026, REQ-029, REQ-030, REQ-035, REQ-040, REQ-047,
  REQ-049
- **Type**: Integration / outside-in protocol rig
- **Priority**: High
- **Preconditions**: Shared scenario rig; real memory and stored shells; one root
  Workflow with one repeatable record.
- **Steps**:
  1. For each shell mode, open the root and wait for `attachment-provided`.
  2. Exchange start and inspect the full record proposal at action `0`.
  3. Reserve through `JournalAuthorityPort` and wait for
     `reservation-committed`.
  4. Read the journal and assert `PullRequested` and `AttemptStarted` before
     releasing authorization.
  5. Authorize and observe attempt entry in the resource-owned Task.
  6. Produce an `ok` value and receive `record-attempt-completed`.
  7. Resolve through the real authority, wait for commit, confirm by exact
     reservation, and resume with the confirmed receipt.
  8. Observe synchronous post-record code and terminal action `1`.
  9. Fold and compare after open, reserve, resolve, and complete.
  10. Leave the Activation scope and run teardown checks.
- **Expected Result**: Both modes produce equivalent accepted semantics.
  Intent exists before closure entry. Settlement exists before Workflow resume.
  One resource-owned attempt returns one outcome. The fold matches public
  observations and no secret crosses the attachment boundary.

### TC-010: Accepted error live and replay

- **Requirements**: REQ-026, REQ-028, REQ-039, REQ-040
- **Type**: Integration / outside-in protocol rig
- **Priority**: High
- **Preconditions**: The closure throws a durable error with a unique code.
- **Steps**:
  1. Run the live path in memory and stored modes through accepted resolution.
  2. Assert the Workflow terminal failure matches the accepted serialized
     error.
  3. Dispose the first attachment and reconstruct.
  4. Confirm exact reservation and resume without authorization.
  5. Assert closure and middleware entry probes remain unused during replay.
- **Expected Result**: Live and replay terminal errors match. Replay adds no
  attempt or settlement records and does not invoke closure code.

### TC-011: Accepted cancellation live and replay

- **Requirements**: REQ-009, REQ-026, REQ-028, REQ-039, REQ-040
- **Type**: Integration / outside-in protocol rig
- **Priority**: High
- **Preconditions**: The attempt's cancellation signal can be triggered through
  a causal rig operation.
- **Steps**:
  1. Run and authorize the record in both shell modes.
  2. Trigger the attempt-owned cancellation signal after `attempt-entered`.
  3. Accept the canonical cancelled outcome and confirm it.
  4. Observe `DurableProgramCancellation` behavior at the Workflow boundary.
  5. Reconstruct and resume the same accepted cancelled outcome without
     authorization.
- **Expected Result**: Live and replay cancellation semantics match. Replay does
  not start closure or middleware. The accepted journal contains the canonical
  cancelled settlement.

### TC-012: Ephemeral reconstruction and settled closure suppression

- **Requirements**: REQ-009, REQ-028, REQ-039
- **Type**: Integration / outside-in protocol rig
- **Priority**: High
- **Preconditions**: The root has one ephemeral Operation before record and
  closure middleware with independent lifecycle probes.
- **Steps**:
  1. Run live success and record the ephemeral result and run marker.
  2. Snapshot accepted journal records.
  3. Reconstruct with a new ephemeral result source.
  4. Assert the ephemeral Operation runs again and affects synchronous input.
  5. Confirm the same record proposal resolves from accepted history.
  6. Assert no authorization, attempt, closure, or middleware occurs.
  7. Compare journal records before and after reconstruction.
- **Expected Result**: Ephemeral work reruns and creates no record. Durable
  closure work does not rerun. No new semantic record is appended.

### TC-013: Loss after settlement commit before resume

- **Requirements**: REQ-026, REQ-028, REQ-040
- **Type**: Integration / outside-in protocol rig
- **Priority**: High
- **Preconditions**: Rig can stop the first Activation at
  `resolution-committed` before `resume-record`.
- **Steps**:
  1. Run a live attempt and accept its resolution in each shell mode.
  2. Verify `PullResolved` and receipt through the public journal.
  3. End the Activation before confirmation or resume reaches the Workflow.
  4. Reconstruct a fresh attachment.
  5. Reserve exactly and resume from the committed outcome.
- **Expected Result**: Reconstruction reaches the correct terminal value without
  closure re-execution. The local pre-crash resolver is rejected and cleaned.

### TC-014: Reservation commit failure prevents execution

- **Requirements**: REQ-025, REQ-027, REQ-030, REQ-040, REQ-047
- **Type**: Integration / outside-in protocol rig
- **Priority**: High
- **Preconditions**: Stored binding can fail a real reservation commit; memory
  mode uses the current shell failure seam where supported.
- **Steps**:
  1. Start a record proposal.
  2. Hold the reservation commit request.
  3. Return a protocol-valid terminal store failure or invoke the current
     memory-shell commit failure seam.
  4. Observe host activation behavior.
  5. Read accepted records and inspect closure, middleware, and attempt probes.
- **Expected Result**: No authorization or attempt occurs. No failed-evaluation
  record receives an offset. The Workflow does not resume successfully.

### TC-015: Authority identity, capability, and validation mutation matrix

- **Requirements**: REQ-027, REQ-029, REQ-049
- **Type**: Integration / outside-in protocol rig
- **Priority**: High
- **Preconditions**: Real authority has minted valid program and resolution
  capabilities; valid request is available as a mutation base.
- **Steps**:
  1. Mutate program capability, resolution capability, audience, descriptor,
     descriptor digest, pull ID, attempt ID, result value, outcome digest, and
     receipt identity one at a time at the public command boundary.
  2. Submit each mutated command through `JournalAuthorityPort`.
  3. Read accepted history after each rejection.
  4. Inspect Workflow, closure, and resume probes.
  5. Recursively inspect attachment commands/events for capability sentinels.
- **Expected Result**: Current authority rejects each mutation with current
  error identity. No rejected mutation changes accepted history or resumes the
  Workflow. Capabilities remain in the host coordinator only.

### TC-016: Resolution failure and CAS exhaustion do not resume

- **Requirements**: REQ-027, REQ-040
- **Type**: Integration / outside-in protocol rig
- **Priority**: High
- **Preconditions**: A live attempt has produced an outcome; stored binding can
  fail resolution commit and force retry exhaustion.
- **Steps**:
  1. Hold the real resolution commit after attempt completion.
  2. In one scenario, return a terminal store failure.
  3. In another, cause the current configured number of real CAS conflicts.
  4. Observe the authority result and Workflow probes.
  5. Read accepted records and run teardown.
- **Expected Result**: Neither failure path sends successful resume or runs
  post-record code. Failed evaluations do not enter the fold. Current stored
  error behavior is preserved.

### TC-017: Complete stored CAS reevaluation

- **Requirements**: REQ-036, REQ-040, REQ-047
- **Type**: Integration / outside-in protocol rig
- **Priority**: High
- **Preconditions**: Deterministic ExecutionStore binding supports pending
  commit handles and a protocol-valid competing commit.
- **Steps**:
  1. Run a stored reservation until its actual `commitExecution` request is
     pending.
  2. Commit a competing valid head update and then release the held request as a
     conflict.
  3. Capture the stored shell's next real load and commit requests.
  4. Accept the reevaluated reservation and inspect records and returned
     capability.
  5. Repeat the conflict sequence for resolution.
  6. Confirm and resume only the successful result.
- **Expected Result**: The shell reloads and reruns the complete decision path.
  Speculative entries, capabilities, outcomes, and receipts are not observable.
  One committed reservation and resolution frontier enters history.
- **Notes**: Request counts may be asserted because exact retry behavior is the
  specified subject, not a synchronization mechanism.

### TC-018: Unsafe produced-but-unaccepted outcome

- **Requirements**: REQ-030, REQ-031, REQ-032, REQ-034, REQ-035, REQ-040,
  REQ-047
- **Type**: Integration / outside-in protocol rig
- **Priority**: High
- **Preconditions**: Root record has `{ mode: "unsafe" }`; closure returns a
  unique secret-like local value after an observable side-effect marker.
- **Steps**:
  1. In each shell mode, reserve and commit the unsafe attempt.
  2. Authorize, observe the side-effect marker, and capture the produced local
     outcome.
  3. Prevent the host from submitting or accepting that outcome.
  4. Lose the settlement path and issue current attempt detachment.
  5. Read and assert `AttemptDetached`, `PullIndeterminate`,
     `AttemptAbandoned`, and authority-created `PullResolved` order.
  6. Fold and compare after detachment.
  7. Reconstruct and exact-reserve the pull.
- **Expected Result**: Replay returns only `effect_outcome_indeterminate`.
  Neither accepted records nor fold contain the local value. Both shells expose
  equivalent semantics.

### TC-019: Attachment resource ownership and Context topology

- **Requirements**: REQ-010, REQ-011, REQ-013, REQ-014, REQ-015, REQ-016,
  REQ-019, REQ-020, REQ-038
- **Type**: Integration / Effection resource rig
- **Priority**: High
- **Preconditions**: Lifecycle Context and finalizer probes can identify logical
  owner nodes without reading Effection private fields.
- **Steps**:
  1. Set a parent marker and open two sibling attachments with distinct runtime
     markers.
  2. Observe `provide()` return while both resource tasks remain active.
  3. Inspect each handle's own enumerable and symbol keys.
  4. Enter durable and ephemeral effects and record their scope/lifecycle
     markers.
  5. Authorize one attempt and record its owner marker.
  6. Cancel an individual host exchange after its command is enqueued.
  7. Verify the resource-owned Workflow and attempt remain under the attachment
     until resource teardown.
  8. Leave the caller scope and observe all finalizers.
- **Expected Result**: Context flows only down each resource tree. Each effect
  has a new child Task scope. The handle exposes only bounded methods. Host
  exchange scope does not own attempt work. All children finalize on caller
  scope exit.

### TC-020: Ephemeral success, error, cancellation, and cleanup

- **Requirements**: REQ-009, REQ-010
- **Type**: Integration / Effection effect rig
- **Priority**: High
- **Preconditions**: Parent Context marker and child finalizer probe exist.
- **Steps**:
  1. Run ephemeral Operations that return, throw, and suspend until cancelled.
  2. Assert each sees inherited Context from a distinct child scope.
  3. Cancel the Workflow while the suspended ephemeral child is active.
  4. Observe child cleanup and effect teardown settlement.
  5. Compare authority history before and after all variants.
- **Expected Result**: Values, errors, and cancellation propagate normally.
  Child cleanup runs once. No variant publishes a proposal or changes authority
  history.

### TC-021: Immediate buffering, FIFO, and one-shot settlement

- **Requirements**: REQ-017
- **Type**: Integration / attachment protocol rig
- **Priority**: High
- **Preconditions**: Workflow can publish immediately; resolver settlement is
  observable through semantic continuation probes.
- **Steps**:
  1. Open an attachment and wait until `proposal-buffered` before calling
     `exchange(start)`.
  2. Assert start receives the proposal.
  3. Enqueue valid protocol operations and verify FIFO event order.
  4. Trigger duplicate resolve and duplicate reject attempts on instrumented
     one-shot wrappers through the test-only lifecycle seam.
  5. Observe Workflow continuation and exchange completion.
- **Expected Result**: No message is lost. FIFO order holds. Each rendezvous
  advances or completes once only.

### TC-022: Invalid attachment command matrix

- **Requirements**: REQ-023, REQ-039
- **Type**: Integration / attachment protocol rig
- **Priority**: High
- **Preconditions**: Fresh attachment factory available for each matrix row.
- **Steps**:
  1. Send command-before-start, repeated start, concurrent exchange,
     authorization-before-proposal, mismatched action, pull, attempt,
     descriptor, outcome, receipt, replay flag, duplicate authorization,
     duplicate resume, resume-before-attempt, and command-after-terminal cases.
  2. Observe protocol result, attachment state, closure probe, and Workflow
     continuation probe for each fresh attachment.
  3. Run teardown after each case.
- **Expected Result**: Every invalid sequence returns
  `program_protocol_error` or retained stale behavior as specified, disposes the
  attachment, rejects pending rendezvous, and neither executes nor resumes the
  boundary.

### TC-023: Disposal, disposition, and local cancel remain distinct

- **Requirements**: REQ-015, REQ-020, REQ-021
- **Type**: Integration / attachment protocol rig
- **Priority**: High
- **Preconditions**: Attachments can be stopped at pending proposal and pending
  attempt states.
- **Steps**:
  1. Exit scope with default disposition while a boundary is pending.
  2. Repeat after setting `transport_lost`.
  3. Repeat after setting each valid `ProgramShutdownReason`.
  4. In a fresh attachment, send a valid local `cancel` command.
  5. Read accepted journal records after every variant.
  6. Inspect pending resolver and child finalization.
- **Expected Result**: Disposition affects teardown reporting only and adds no
  `CancellationRequested`. Scope disposal rejects pending work and cleans all
  children. Local cancel follows `DurableProgramCancellation` behavior but does
  not issue an authority cancellation command.

### TC-024: Missing runtime Context and nested durable operation

- **Requirements**: REQ-011, REQ-012, REQ-039
- **Type**: Integration / negative effect rig
- **Priority**: High
- **Preconditions**: A record effect can run outside attachment Context; another
  closure attempts nested `record()`.
- **Steps**:
  1. Enter the record effect without installing `ProgramEffectRuntimeContext`.
  2. Observe effect failure, proposal queue, authority ports, and closure probe.
  3. Run a valid attachment, authorize its closure, and have the closure enter a
     nested durable effect after an ordinary Operation.
  4. Accept and replay the resulting outer error outcome.
- **Expected Result**: Missing Context fails before publication or authority use.
  Nested scheduling produces `nested_durable_operation`; no nested proposal
  appears. The accepted outer error replays without closure execution.

### TC-025: Descriptor divergence and record value bounds

- **Requirements**: REQ-008, REQ-024, REQ-029
- **Type**: Integration / authority protocol rig
- **Priority**: High
- **Preconditions**: One accepted record exists; reconstruction factory can
  change one descriptor field. Invalid and oversize result sources exist.
- **Steps**:
  1. Reconstruct at the same action with a changed key.
  2. Reconstruct again with changed retry safety.
  3. Run closures that return non-canonical and over-inline-limit values.
  4. Submit wrong descriptor digests and result identities through current
     authority commands.
- **Expected Result**: Changed descriptors retain current divergence behavior.
  Invalid and oversize values retain current record errors. No weaker local
  identity accepts any mutant.

### TC-026: Fold comparison at every accepted transition

- **Requirements**: REQ-003, REQ-032, REQ-034, REQ-035, REQ-040
- **Type**: Integration / outside-in protocol rig
- **Priority**: High
- **Preconditions**: Shared fold comparator and both shell modes are installed.
- **Steps**:
  1. Run live success and call `foldAndCompare()` after task open, reserve,
     resolve, and task complete.
  2. Run unsafe detachment and compare after its accepted command.
  3. Run accepted error and cancellation and compare terminal state.
  4. Apply the same semantic normalizer in both modes.
- **Expected Result**: Folded task, pull, attempt, settlement, receipt, and
  lifecycle data matches public queries and execution projection at every
  frontier.

### TC-027: Append-only history and secret exclusion

- **Requirements**: REQ-034, REQ-047, REQ-049
- **Type**: Integration / security conformance
- **Priority**: High
- **Preconditions**: Real authority uses unique sentinel strings for keyring,
  capability, lease, nonce, restore, and attachment-private values.
- **Steps**:
  1. Read and canonicalize history after each accepted live transition.
  2. Assert every previous prefix remains byte-identical after the next commit.
  3. Verify offsets are contiguous and increasing.
  4. Recursively inspect records, attachment messages, closure inputs, and
     folded index for each secret sentinel and prohibited live value class.
  5. Trigger a failed evaluation and repeat the history comparison.
- **Expected Result**: Accepted history is append-only. Failed evaluation makes
  no change. No private or live value enters messages, closure inputs beyond the
  allowed attempt context, journal, or fold.

### TC-028: Causal synchronization and teardown harness self-tests

- **Requirements**: REQ-020, REQ-041, REQ-042
- **Type**: Integration / harness conformance
- **Priority**: High
- **Preconditions**: Scenario rig has lifecycle registries and each named
  semantic barrier.
- **Steps**:
  1. Run representative success, protocol failure, authority failure, CAS
     conflict, and disposal scenarios using only semantic barriers.
  2. Audit scenario source for sleep, timer waiting, polling loops, and manual
     reducer entry.
  3. Deliberately leave one Queue open and assert teardown reports it.
  4. Repeat for a pending resolver, Task, resource, and store request.
  5. Release each deliberate leak through its causal handle and finish the
     self-test.
- **Expected Result**: Scenario ordering is causal. Each leak class fails
  teardown with its semantic name. Normal success and failure paths leave no
  tracked work.

### TC-029: Evidence verdict, rejection gate, and migration map

- **Requirements**: REQ-004, REQ-043, REQ-044, REQ-045
- **Type**: E2E / artifact conformance
- **Priority**: High for REQ-004, REQ-043, REQ-044; Medium for REQ-045
- **Preconditions**: Verification results and proof implementation diff are
  available.
- **Steps**:
  1. Parse `.pi/evidence/authority-backed-effection-workflow.md` with an evidence
     linter.
  2. Verify verdict, command/result, failed-requirement, production-cutover
     warning, semantic gate, and source-path sections.
  3. Verify the report evaluates every positive and rejection gate.
  4. For a pass verdict, verify each named production file has retain, move,
     replace, or delete responsibility entries and remote-driver follow-up.
  5. Feed the linter pass and reject fixture reports with missing fields.
- **Expected Result**: The real evidence report is complete and consistent with
  verification results. Incomplete fixtures fail. A pass still says that
  production use is not authorized.

### TC-030: Package build, type, and export E2E smoke

- **Requirements**: REQ-001, REQ-002, REQ-006, REQ-037, REQ-046
- **Type**: E2E
- **Priority**: High
- **Preconditions**: Workspace lockfile is installed without proof-only package
  additions.
- **Steps**:
  1. Run the journal-authority package type check.
  2. Run its production build.
  3. Import proof symbols through the development and built `./testing`
     conditions.
  4. Import the root and production subpaths and inspect exported keys.
  5. Verify resolved Effection and TypeScript versions and workspace dependency
     graph.
- **Expected Result**: Build and type checks pass with pinned versions. Testing
  imports work. Production imports expose no proof symbol. No new package or
  cycle exists.

### TC-031: Complete stored live-then-replay E2E smoke

- **Requirements**: REQ-003, REQ-028, REQ-040, REQ-043
- **Type**: E2E
- **Priority**: High
- **Preconditions**: Built package testing export, real stored shell, and
  deterministic ExecutionStore binding are available.
- **Steps**:
  1. Import the proof through the built testing subpath.
  2. Install the real stored shell through normal scoped port composition.
  3. Run one root Workflow through live success and terminal completion.
  4. End the Activation and reconstruct from accepted records.
  5. Verify the closure does not run again and terminal value matches.
  6. Run final teardown and evidence-gate checks.
- **Expected Result**: The built testing export completes the full stored path
  with real port and shell wiring. Replay suppresses closure execution. No
  resource or store work leaks.

### TC-032: Change-scope, dependency, and trust-boundary audit

- **Requirements**: REQ-002, REQ-044, REQ-046, REQ-048, REQ-049
- **Type**: E2E / repository conformance
- **Priority**: High
- **Preconditions**: A pre-proof worktree status/diff inventory and the final
  proof diff are available.
- **Steps**:
  1. Compare final changes with the pre-proof inventory.
  2. Verify new changes are limited to proof testing source, tests, testing
     export, evidence, and explained narrow build configuration.
  3. Verify no unrelated file was reset, broadly formatted, or overwritten.
  4. Build a module graph from proof imports and assert no cycle or raw shell
     driver enters Workflow code.
  5. Inspect host capability lifetime and attachment schemas.
  6. Evaluate all REQ-044 rejection conditions.
- **Expected Result**: The change set is contained and preserves existing work.
  The package graph is acyclic. Authority and capability access remains in the
  host coordinator. No rejection condition is present.

## 5. Negative Coverage Summary

Negative behavior is part of the main cases rather than a separate mock-based
suite:

| Risk | Negative cases |
| --- | --- |
| Unwrapped ordinary Operation compiles | TC-002 |
| Invalid record descriptor or value | TC-003, TC-025 |
| Closure/runtime objects cross message boundary | TC-003, TC-027 |
| Malformed semantic history folds | TC-005 |
| Semantic comparator hides mismatch | TC-007 |
| Protocol phase or command is invalid | TC-008, TC-022 |
| Reservation or settlement is uncommitted | TC-014, TC-016 |
| Identity or capability is wrong | TC-015, TC-025 |
| CAS evaluation data leaks | TC-017 |
| Unsafe local outcome replays | TC-018 |
| Missing Context or nested scheduling | TC-024 |
| Disposal becomes cancellation | TC-023 |
| Queue, resolver, Task, resource, or store request leaks | TC-028 |
| Evidence omits a gate or authorizes production | TC-029 |
| Proof leaks into production exports or dependencies | TC-001, TC-030, TC-032 |

## 6. Test Data and Fixtures

### 6.1 Stable root identity

All cross-shell scenarios use deterministic IDs and timestamps:

```text
sessionId: session-proof-001
taskId: task-root-001
turnId: turn-proof-001
attachmentId: attachment-proof-001
executionEpoch: 1
program: proof-record@1.0.0#<fixed 64-hex digest>
input: {"seed":"authority-backed-effection-workflow"}
record key: record-proof-001
```

A second deterministic ID set is used for sibling-resource and CAS competing
commit cases. Tests do not generate random IDs unless a fixed seed is recorded.

### 6.2 Descriptor corpus

- Default retry safety.
- `{ mode: "repeatable" }`.
- `{ mode: "unsafe" }`.
- `{ mode: "idempotent", mechanism: "pull_id_key" }`.
- `{ mode: "idempotent", mechanism: "inherent" }`.
- Empty key.
- Exactly 128 UTF-8 bytes.
- 129 UTF-8 bytes, including one multibyte boundary case.
- Unknown retry mode and mechanism.
- Extra options key.
- Missing and non-function closure.
- Same action with changed key.
- Same action with changed retry safety.

### 6.3 Outcome corpus

```ts
{ status: "ok", value: { recorded: "accepted" } }
{ status: "error", error: { code: "proof_error", message: "accepted error" } }
{ status: "cancelled" }
{ status: "cancelled", partial: { stage: "partial" } }
```

Additional values include invalid canonical input, an inline-limit boundary,
one byte over the limit, and unique unaccepted unsafe value
`UNACCEPTED-UNSAFE-OUTCOME-SENTINEL`.

### 6.4 Authority mutation corpus

Mutants change one field at a time:

- program capability;
- resolution capability;
- audience;
- action index;
- pull ID;
- attempt ID;
- descriptor key;
- retry safety;
- descriptor digest;
- outcome digest;
- receipt session, task, pull, offset, digest, or status; and
- result size or canonical form.

Valid capabilities and receipts always come from the real authority. Invalid
values derive from a valid value by one deterministic mutation.

### 6.5 Fold fixture corpus

Fixtures contain deep-frozen `DurableSemanticRecord` arrays for:

- active root after `TaskOpened`;
- reserved record;
- settled success, error, and cancellation;
- closed task;
- detached repeatable attempt;
- unsafe detach/indeterminate/abandon/settle;
- `AttemptOutcomeUnknown`; and
- every malformed-history class in TC-005.

Fixtures use real current payload shapes and canonical offsets. They do not add
a proof-only record variant.

### 6.6 Secret sentinels

The security rig assigns distinct recognizable values to program capability,
resolution capability, key ID, lease owner, nonce, restore ticket, attachment
ID, closure capture, Queue, resolver, Task, Scope, and Context. Absence checks
compare both property names and recursively reachable primitive values. Tests
do not print real signing material in failure output.

## 7. Coverage Matrix

| Requirement | Test cases | Strength | Status |
| --- | --- | --- | --- |
| REQ-001 | TC-001, TC-030 | MUST / MUST NOT | Planned |
| REQ-002 | TC-001, TC-030, TC-032 | MUST NOT | Planned |
| REQ-003 | TC-009, TC-026, TC-031 | MUST / MUST NOT | Planned |
| REQ-004 | TC-029 | MUST / MUST NOT | Planned |
| REQ-005 | TC-002 | MUST | Planned |
| REQ-006 | TC-002, TC-030 | MUST / MUST NOT | Planned |
| REQ-007 | TC-003, TC-009 | MUST | Planned |
| REQ-008 | TC-003, TC-025 | MUST | Planned |
| REQ-009 | TC-011, TC-012, TC-020 | MUST / MUST NOT | Planned |
| REQ-010 | TC-019, TC-020 | MUST | Planned |
| REQ-011 | TC-019, TC-024 | MUST / MUST NOT | Planned |
| REQ-012 | TC-024 | MUST | Planned |
| REQ-013 | TC-009, TC-019 | MUST | Planned |
| REQ-014 | TC-019 | MUST / MUST NOT | Planned |
| REQ-015 | TC-019, TC-023 | MUST / MUST NOT | Planned |
| REQ-016 | TC-009, TC-019 | MUST / MUST NOT | Planned |
| REQ-017 | TC-021 | MUST / MUST NOT | Planned |
| REQ-018 | TC-001 | MUST NOT / MAY | Planned |
| REQ-019 | TC-009, TC-019 | MUST / MUST NOT | Planned |
| REQ-020 | TC-019, TC-023, TC-028 | MUST / MUST NOT | Planned |
| REQ-021 | TC-023 | MUST / MUST NOT | Planned |
| REQ-022 | TC-003, TC-008, TC-009 | MUST / MUST NOT | Planned |
| REQ-023 | TC-008, TC-022 | MUST / MUST NOT | Planned |
| REQ-024 | TC-003, TC-009, TC-025 | MUST / MUST NOT | Planned |
| REQ-025 | TC-009, TC-014 | MUST / MUST NOT | Planned |
| REQ-026 | TC-009, TC-010, TC-011, TC-013 | MUST | Planned |
| REQ-027 | TC-014, TC-015, TC-016 | MUST / MUST NOT | Planned |
| REQ-028 | TC-010, TC-011, TC-012, TC-013, TC-031 | MUST / MUST NOT | Planned |
| REQ-029 | TC-009, TC-015, TC-025 | MUST / MUST NOT | Planned |
| REQ-030 | TC-009, TC-014, TC-018 | MUST | Planned |
| REQ-031 | TC-006, TC-018 | MUST / MUST NOT | Planned |
| REQ-032 | TC-004, TC-006, TC-018, TC-026 | MUST | Planned |
| REQ-033 | TC-004, TC-005 | MUST / MUST NOT | Planned |
| REQ-034 | TC-004, TC-006, TC-018, TC-026, TC-027 | MUST / MUST NOT | Planned |
| REQ-035 | TC-007, TC-009, TC-018, TC-026 | MUST / MAY / MUST NOT | Planned |
| REQ-036 | TC-017 | MUST | Planned |
| REQ-037 | TC-002, TC-030 | MUST | Planned |
| REQ-038 | TC-019 | MUST | Planned |
| REQ-039 | TC-010, TC-011, TC-012, TC-022, TC-024 | MUST | Planned |
| REQ-040 | TC-009, TC-010, TC-011, TC-013, TC-014, TC-016, TC-017, TC-018, TC-026, TC-031 | MUST | Planned |
| REQ-041 | TC-028 | MUST / MUST NOT / MAY | Planned |
| REQ-042 | TC-028 | MUST | Planned |
| REQ-043 | TC-029, TC-031 | MUST / MUST NOT | Planned |
| REQ-044 | TC-001, TC-029, TC-032 | MUST / MUST NOT | Planned |
| REQ-045 | TC-029 | SHOULD | Planned |
| REQ-046 | TC-002, TC-030, TC-032 | MUST / MUST NOT | Planned |
| REQ-047 | TC-004, TC-014, TC-017, TC-018, TC-027 | MUST / MUST NOT | Planned |
| REQ-048 | TC-032 | MUST / MUST NOT | Planned |
| REQ-049 | TC-003, TC-009, TC-015, TC-027, TC-032 | MAY / MUST / MUST NOT | Planned |

## 8. Environment Requirements

- Run from the `sweatpants` workspace with the existing lockfile.
- Use Node and pnpm versions already selected by repository tooling.
- Resolve Effection `4.1.0-alpha.9`, TypeScript `5.9.3`, and Vitest `3.0.5`.
- Do not add a workspace package for the proof.
- Use current package development conditions for source tests and built import
  conditions for E2E export tests.
- Run with no network requirement. A future external client must use a local
  protocol server and its real client path.
- Keep deterministic timezone and clock values through existing authority
  options. Do not advance tests by sleeping.
- Install real memory/stored authority drivers in an Effection scope for each
  scenario.
- Install the deterministic ExecutionStore binding only in stored mode.
- Capture pre-proof `git status --short` and relevant diffs before implementation
  for TC-032. The audit is read-only and must not clean the worktree.

## 9. Entry and Exit Criteria

### 9.1 Entry criteria

- The normative specification is approved.
- Current journal-authority package tests and type checks have a recorded
  baseline or known unrelated failures.
- The pre-proof dirty-worktree inventory is captured without modification.
- The deterministic store binding passes its own protocol conformance tests.
- The proof remains reachable only through the testing subpath.

### 9.2 Exit criteria

- Every High-priority test in this plan passes, or the evidence verdict is
  `reject` with each failed requirement named.
- REQ-001 through REQ-044 and REQ-046 through REQ-049 have recorded coverage.
- REQ-045 has a migration map for a pass verdict or an omission rationale for a
  reject verdict.
- Memory/stored semantic comparisons have no unexplained difference.
- No teardown leak remains.
- Package check, test, and build results are recorded in the evidence artifact.
- The evidence artifact does not authorize production use.

A rejected architecture proof may still have passing harness and negative
evidence tests. The repository's normal test suite must not be left failing to
represent a rejection.

## 10. Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Effection alpha behavior differs from assumptions | Scope or Context claims pass only in a hand-built model | Use the pinned real package and observe public lifecycle/finalizer behavior; do not replace Scope or Task methods. |
| Scope ownership is hard to observe without private fields | Tests become coupled to Effection internals | Use Context markers, child Operations, finalizers, and causal resolver probes rather than Coroutine inspection. |
| Store binding behaves like a method stub | CAS test bypasses real stored-shell protocol | Implement the full needed `ExecutionStore` server-compatible contract, capture real requests, and keep the stored shell and port facade in path. |
| Forced conflict races are flaky | Retry proof is nondeterministic | Hold a real commit request, make a competing valid commit, then release the first request as a conflict through named barriers. |
| Failed evaluation data is hard to distinguish | Speculative capability or record reuse goes unnoticed | Put unique sentinels in each evaluation and inspect returned results, accepted records, and fold after commit. |
| Unsafe closure outcome accidentally settles | Test misses the ambiguity guarantee | Stop at `attempt-outcome-produced`, block resolution, then detach through the public authority command. |
| Call counts become synchronization | Tests are brittle and violate the spec | Wait on semantic handles; use exact counts only after the scenario when count is specified behavior. |
| Static source checks are brittle | Refactoring causes false failures | Prefer TypeScript module resolution, package exports, type fixtures, and closed allowlists; use text checks only for narrow forbidden imports. |
| Large cross-shell matrix duplicates orchestration | Slow or repetitive tests obscure causality | Reuse one generator-style scenario body and parameterize only shell/store setup. |
| Evidence report says pass before all tests run | Invalid migration recommendation | Evidence linter requires command results and every positive/rejection gate before accepting `pass`. |
| Existing dirty work is mistaken for proof changes | Unrelated work is overwritten or blamed | Record a read-only pre-proof inventory and compare only newly introduced changes; never reset or clean. |
| Teardown failure is hidden by the main assertion | Leaked Task or pending store request remains | Run finalizer checks for success and failure and maintain deliberate harness leak self-tests. |

## 11. Test Deliverables

- Compile-time Workflow fixtures included in the package check.
- Pure fold and comparator unit tests.
- Attachment resource and protocol-rig tests.
- Shared memory/stored authority scenario suite.
- Deterministic ExecutionStore server-compatible test binding and its
  conformance tests.
- Minimal built-package E2E smoke tests.
- Evidence linter and report at
  `.pi/evidence/authority-backed-effection-workflow.md`.
- Read-only pre/post change-scope audit recorded in the evidence report.
