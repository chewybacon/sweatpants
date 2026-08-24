# Normative Specification: Authority-Backed Effection Workflow: Record Vertical Path

## Status

Draft

## Abstract

This specification defines a quarantined, test-only vertical proof for one
Effection Workflow with one durable `record` boundary. It specifies constrained
Workflow typing, explicit ephemeral Operations, an Effection resource-owned
attachment, typed buffered coordination, Journal Authority
reserve-attempt-resolve ordering, unsafe ambiguity handling, a pure semantic
journal fold, cross-shell verification, and the gate for any later production
migration.

## 1. Introduction

### 1.1 Purpose

Sweatpants currently authors durable programs as unrestricted Effection
`Operation<T>` values. The approved design asks whether a stricter
`Workflow<T>` boundary gives useful compile-time guidance without weakening the
Journal Authority protocol.

This specification defines the proof needed to answer that question. It does
not define a production runtime migration. The proof uses current authority
ports and shells, but it keeps all new Workflow and attachment code behind the
existing test-only export.

### 1.2 Scope

The proof covers one root program with one durable `record` boundary. It covers:

- a generator that may yield only `DurableProgramEffect` values;
- explicit adaptation of ordinary Operations with `ephemeral()`;
- one Effection resource that owns the program attachment;
- a typed host-to-attachment protocol;
- current Journal Authority reservation, attempt, settlement, replay, and
  unsafe-detachment behavior;
- a pure index folded from accepted semantic records; and
- deterministic verification in memory and stored shell modes.

The proof does not migrate other durable operations, recovery, remote drivers,
or production authoring APIs. It does not change authority commands, semantic
record payloads, snapshots, capabilities, error codes, or storage protocol.

### 1.3 Normative language

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** in
this document are to be interpreted as described in RFC 2119 and RFC 8174 when,
and only when, they appear in all capitals.

### 1.4 Terms

- **Accepted transition:** An authority command evaluation whose entries and
  private-state changes were committed by its shell.
- **Attachment:** The live, scope-owned execution of one proof Workflow.
- **Attachment resource:** The Effection `resource()` task that provides the
  attachment handle and owns all live attachment work.
- **Boundary:** One yielded record effect that suspends the Workflow until the
  host resumes it with an authority-accepted outcome.
- **Durable effect:** An Effection `Effect<T>` that enters the attachment runtime
  and proposes authority-backed work.
- **Ephemeral effect:** An Effection `Effect<T>` that runs an ordinary Operation
  without an authority command or semantic record.
- **Host coordinator:** The Operation that exchanges messages with the
  attachment and calls `JournalAuthorityPort` and `AuthorityJournalPort`.
- **Private authority state:** Capabilities, nonces, leases, restore state,
  attachment fences, signing material, and other control data that is not
  semantic history.
- **Reconstruction:** A fresh Workflow execution that reaches the same record
  boundary and receives an already accepted outcome.
- **Semantic fold:** A pure reduction of accepted `DurableSemanticRecord`
  values into `RecordExecutionIndex`.
- **Workflow:** The constrained generator defined in Section 4.1.

## 2. Conformance Requirements

### 2.1 Containment and evidence

#### REQ-001: Test-only quarantine

The proof implementation MUST be exported only through
`@sweatpants/journal-authority/testing`. The package root and every production
composition MUST NOT export, import, register, or select the proof. The proof
MUST remain quarantined or be removed until a separate approved design and
specification authorize a production cutover.

**Source**: DR-001, DR-006

**Rationale**: The proof reverses a deliberate production authoring decision.
It cannot coexist as an undocumented runtime choice.

**Acceptance Criteria**:

- [ ] Proof source is under `packages/journal-authority/src/testing/` and is
      re-exported only by `packages/journal-authority/src/testing.ts`.
- [ ] `packages/journal-authority/src/index.ts` and all other default or
      production entry points do not export or import proof symbols.
- [ ] Production runtime composition contains no proof registration.
- [ ] The evidence report states that production use requires a later approved
      design and specification.

#### REQ-002: Production contract isolation

The proof MUST NOT change the active `DurableProgramFactory`, `ProgramDriver`,
`ProgramPeer`, `ProgramRuntime`, `JournalAuthorityPort`, authority command
algebra, `DurableSemanticRecord` union, authority snapshot format, or public
error-code union. It MUST NOT add a runtime flag, compatibility adapter,
descriptor kind, or route that selects between proof and production behavior.

**Source**: DR-002, DR-003

**Rationale**: A record-only proof must not create two production execution
models or durable formats.

**Acceptance Criteria**:

- [ ] Public API and declaration snapshots for the named production contracts
      are unchanged except for the existing `./testing` subpath's added proof
      exports.
- [ ] No production branch selects a Workflow implementation.
- [ ] No semantic record, snapshot, descriptor, or public error variant is
      added for the proof.

#### REQ-003: Real authority boundary

The host coordinator MUST call the scoped `JournalAuthorityPort` for commands
and queries and the scoped `AuthorityJournalPort` for semantic records. Test
scenarios MUST install current in-memory or stored shell drivers. They MUST NOT
mock either port method, call decision functions as the system under test, or
fabricate command or query results.

**Source**: DR-004

**Rationale**: Fabricated authority results would bypass capability checks,
commit ordering, CAS behavior, and record production.

**Acceptance Criteria**:

- [ ] Memory scenarios install the current in-memory shell drivers.
- [ ] Stored scenarios install the current stored shell drivers over a
      deterministic store binding.
- [ ] Workflow and coordinator scenarios use port facades, not shell internals
      or decision functions.
- [ ] Captured results and records originate from committed shell operations.

#### REQ-004: Proof verdict artifact

The proof MUST produce
`.pi/evidence/authority-backed-effection-workflow.md`. The artifact MUST record a
`pass` or `reject` verdict, the verification commands, the unmet requirement if
rejected, and the production types and source paths that an atomic cutover
could remove or replace. The artifact MUST treat failure to identify a simpler
replacement as negative evidence. It MUST NOT recommend production use merely
because proof tests compile or reduce source-line count.

**Source**: DR-005

**Rationale**: The proof exists to support a later architecture decision, not
to incubate a second runtime by default.

**Acceptance Criteria**:

- [ ] The evidence file exists and names its verdict.
- [ ] The file records the exact commands and results used for the verdict.
- [ ] The file names removable, replaceable, and retained production paths.
- [ ] A rejection names each failed conformance condition.
- [ ] The verdict considers semantic safety and ownership, not only code size.

### 2.2 Workflow and effect model

#### REQ-005: Constrained Workflow type

The proof MUST define a `Workflow<T>` type equivalent to
`Generator<DurableProgramEffect<unknown>, T, unknown>`. TypeScript MUST reject a
plain `Operation<T>` yielded or delegated directly from a function declared to
return `Workflow<T>`.

**Source**: DR-007

**Rationale**: The proof must test a real compiler boundary rather than rename
the current unrestricted Operation model.

**Acceptance Criteria**:

- [ ] A generator that yields only proof durable or ephemeral effects compiles.
- [ ] Direct `yield*` of an ordinary Effection Operation in a Workflow produces
      a TypeScript error.
- [ ] Changing only a nominal name without constraining the yield type does not
      satisfy this requirement.

#### REQ-006: Effection Effect compatibility

`DurableProgramEffect<T>` MUST be assignable to the `Effect<T>` contract exported
by `effection@4.1.0-alpha.9`. The proof MUST NOT patch or replace Effection's
reducer, Coroutine implementation, Scope implementation, Task implementation,
or effect dispatch.

**Source**: DR-008

**Rationale**: The proof must compose through Effection's normal effect
reduction.

**Acceptance Criteria**:

- [ ] A compile-time assertion assigns a proof effect to `Effect<T>`.
- [ ] The Workflow runs with the pinned Effection package.
- [ ] The repository contains no proof patch, fork, monkey patch, or reducer
      hook for Effection.

#### REQ-007: Root Workflow factory

The proof factory MUST return `Workflow<Json>`. The vertical conformance
scenario MUST run one root task that reaches exactly one record boundary and
then terminates. Synchronous JavaScript before and after the boundary MUST run
without an adapter.

**Source**: DR-009 and the approved design scope

**Rationale**: One record boundary is the smallest path that tests all selected
ownership and authority guarantees.

**Acceptance Criteria**:

- [ ] The factory's declared return type is `Workflow<Json>`.
- [ ] A synchronous calculation before the record call affects its input or
      closure.
- [ ] A synchronous calculation after resume affects the terminal result.
- [ ] The vertical scenario emits one `record-proposed` event and one terminal
      event.

#### REQ-008: Record authoring API and descriptor

The proof MUST provide
`record<T extends Json>(options, execute): Workflow<T>`. `record()` MUST yield
one durable effect. The effect MUST retain a runtime-only closure and MUST expose
only a serializable proposal with a `RecordedOperationDescriptor`. The descriptor
MUST have `kind: "record"`, the validated key, and the validated retry safety.
The options object MUST be closed. The key MUST be non-empty and at most 128
UTF-8 bytes. Omitted retry safety MUST mean `{ mode: "repeatable" }`.

**Source**: DR-010, DR-011, DR-030, DR-035

**Rationale**: The proof must preserve current record identity, defaults, and
input validation while keeping executable values local.

**Acceptance Criteria**:

- [ ] Valid repeatable, unsafe, and idempotent retry-safety values produce the
      current descriptor shape.
- [ ] Omitted retry safety produces repeatable mode.
- [ ] Empty, overlength, malformed, or extra-key options fail with the retained
      descriptor-validation behavior.
- [ ] A non-function closure is rejected.
- [ ] The host-visible proposal can be canonicalized as JSON.
- [ ] The host-visible proposal has no closure, Scope, Context, resolver, Task,
      Signal, Queue, attachment handle, or transport.

#### REQ-009: Ephemeral adaptation

The proof MUST provide
`ephemeral<T>(operation: Operation<T>): Workflow<T>`. It MUST run the wrapped
Operation and return or throw its result through normal Effection semantics. It
MUST NOT call an authority port, publish an attachment proposal, allocate an
action index, or append a semantic record. It MUST run again during
reconstruction.

**Source**: DR-012

**Rationale**: Ordinary work remains possible, but its rerun behavior must be
visible at the authoring boundary.

**Acceptance Criteria**:

- [ ] A Workflow can use the return value of `yield* ephemeral(operation)`.
- [ ] Success, failure, and cancellation propagate from the wrapped Operation.
- [ ] Authority records before and after an ephemeral effect are identical.
- [ ] A fresh reconstruction executes the wrapped Operation again.

#### REQ-010: Ephemeral child scope

Each `ephemeral()` effect evaluation MUST call `Scope.run()` on the scope that
Effection supplies to effect entry. The wrapped Operation MUST run in the new
child Task scope created by Effection. That child MUST inherit the Workflow's
Context values and MUST stop when the owning Workflow scope stops. The effect
teardown callback MUST wait for or complete child cleanup before it settles.

**Source**: DR-013

**Rationale**: The wrapper must preserve structured concurrency and normal
Context inheritance.

**Acceptance Criteria**:

- [ ] The wrapped Operation observes a Context value set above the Workflow.
- [ ] Its current scope differs from the parent Workflow scope.
- [ ] Cancelling the Workflow stops the child and runs its cleanup once.
- [ ] Effect teardown leaves no live child Task.

#### REQ-011: Durable effect child scope and runtime lookup

Each durable effect evaluation MUST call `Scope.run()` on the scope that
Effection supplies to effect entry. Its runtime Operation MUST resolve
`ProgramEffectRuntimeContext` through `Context.expect()` in the resulting child
Task scope. Missing Context MUST fail the effect and MUST NOT publish, execute,
or resume record work. The implementation MUST NOT define a proof-owned
`CoroutineView`, execute runtime logic directly in a captured coroutine scope,
or use a global or default authority.

**Source**: DR-014

**Rationale**: Effection already supplies Task scopes and Context inheritance.
The proof must not invent a second scope model.

**Acceptance Criteria**:

- [ ] A durable effect beneath the attachment resource resolves its inherited
      proof runtime.
- [ ] The effect-evaluation Task has a child scope distinct from the Workflow
      scope.
- [ ] The same effect outside the attachment Context fails before proposal
      publication.
- [ ] No global mutable runtime or fabricated coroutine view exists.

#### REQ-012: Record closure isolation and nested scheduling

An authorized record closure MUST receive the accepted `pullId`, accepted
`attemptId`, and an attempt-owned `AbortSignal`. It MAY yield ordinary Effection
Operations. If it enters `record()` or any other durable program effect, the
attempt MUST produce the retained `nested_durable_operation` error outcome.

**Source**: DR-015

**Rationale**: A record closure is the unsafe execution body, not another
journal scheduler.

**Acceptance Criteria**:

- [ ] The closure observes the exact authority-issued pull and attempt IDs.
- [ ] The closure can run an ordinary Operation.
- [ ] Nested durable scheduling produces error code
      `nested_durable_operation`.
- [ ] The nested proposal does not reach the host or journal.

### 2.3 Attachment resource and ownership

#### REQ-013: Resource-shaped attachment acquisition

`openProofProgramAttachment()` MUST be implemented with Effection `resource()`.
Its resource task MUST call `provide(handle)` after it creates its internal
state and starts its owned tasks. After `provide()`, the resource task MUST
remain alive until the caller's owning scope ends.

**Source**: DR-016

**Rationale**: The attachment has a lifetime and an early usable handle; a
resource models that shape directly.

**Acceptance Criteria**:

- [ ] Yielding the open Operation returns a usable handle before Workflow
      completion.
- [ ] The resource task remains active while the caller scope remains active.
- [ ] Ending the caller scope interrupts the resource task and starts cleanup.

#### REQ-014: Resource Context boundary

The attachment resource MUST set `ProgramEffectRuntimeContext` in its own scope
before it spawns the Workflow. The Workflow and its effect-evaluation children
MUST inherit the value. The Activation caller MUST NOT observe the value unless
it had set an independent parent value before opening the resource.

**Source**: DR-017

**Rationale**: Effection Context inheritance flows from parent scopes to child
scopes, not from a resource to its caller.

**Acceptance Criteria**:

- [ ] The Workflow resolves the resource-installed runtime.
- [ ] Effect-evaluation children resolve the same runtime.
- [ ] The host caller's `Context.get()` result is unchanged by opening the
      resource.
- [ ] Two attachment resources in sibling scopes do not observe each other's
      runtime.

#### REQ-015: Bounded attachment handle

The provided handle MUST expose only `exchange(command)` and
`setDisposition(reason)`, or a type-equivalent bounded protocol. It MUST NOT
expose any Scope, Queue, resolver, Task, closure, Context, authority driver,
capability, or raw transport. The initial disposition MUST be `scope_exit`.
`setDisposition()` MUST accept only the existing `ProgramShutdownReason` values
and MUST NOT by itself cancel the Workflow or append a record.

**Source**: DR-018, DR-027

**Rationale**: The host needs protocol control, not resource internals or a
foreign execution scope.

**Acceptance Criteria**:

- [ ] The public proof handle has no additional fields.
- [ ] Runtime inspection of a handle cannot obtain resource internals.
- [ ] Setting a disposition changes teardown reporting only.
- [ ] Scope exit without a disposition retains `scope_exit` and appends no
      cancellation record.

#### REQ-016: Resource-owned command execution

`exchange()` MUST enqueue one command envelope and await its one-shot reply. It
MUST NOT execute a closure or authority command directly in the handle caller's
scope. The resource-owned command supervisor MUST consume the command and MUST
spawn any authorized record attempt beneath the attachment resource.

**Source**: DR-019, DR-020

**Rationale**: Methods on a provided object run in the caller's scope unless
work is handed back to the owner.

**Acceptance Criteria**:

- [ ] The host method's scope differs from the command supervisor and attempt
      scopes.
- [ ] Cancelling one host exchange does not transfer ownership of the Workflow
      or attempt to that exchange.
- [ ] Resource teardown, not host method return, owns final child cleanup.

#### REQ-017: Buffered queue and one-shot rendezvous

The attachment MUST use one buffered Effection `Queue` for host commands and
one buffered Effection `Queue` for attachment events, or one type-equivalent
buffered queue with closed directional envelopes. Each direction MUST have one
consumer. Each command reply and each Workflow resume boundary MUST use a new
`withResolvers()` instance. A proposal published before a host wait MUST remain
available. A second resolve or reject MUST NOT advance the Workflow or complete
a second exchange.

**Source**: DR-021, DR-022

**Rationale**: The protocol is buffered, sequential, and one-consumer.

**Acceptance Criteria**:

- [ ] An immediate proposal is returned by the later `start` exchange.
- [ ] Command order is FIFO.
- [ ] Every exchange and boundary has a distinct resolver identity.
- [ ] Duplicate settlement of a resolver has no second observable effect.

#### REQ-018: Signal and Channel exclusion

Internal Operation-to-Operation attachment messages MUST NOT use an Effection
`Signal`. A Signal MAY be used only inside an adapter whose source is a
synchronous callback outside Effection. The host command and attachment event
paths MUST NOT use an Effection `Channel`.

**Source**: DR-023, DR-024

**Rationale**: Signal is a callback adapter. Channel is an unbuffered broadcast
that can drop a message before subscription. Neither matches this protocol.

**Acceptance Criteria**:

- [ ] Source inspection finds Queue-based internal messaging and no internal
      Signal.
- [ ] No Channel carries proof commands or events.
- [ ] Any Signal use names and tests its external synchronous callback source.

#### REQ-019: Attempt Task ownership

One `authorize-record` command MUST start at most one record-attempt Task. The
Task MUST be a child owned by the attachment resource and MUST return exactly
one `OperationOutcome`. It MUST NOT call `provide()` or be modeled as an
Effection resource.

**Source**: DR-025

**Rationale**: An attempt has one terminal result and no early-lived value.

**Acceptance Criteria**:

- [ ] One valid authorization produces one attempt Task and one completion
      event.
- [ ] The attempt Task is visible beneath the attachment owner in the test
      lifecycle harness.
- [ ] Attempt code contains no `resource()` or `provide()` path.

#### REQ-020: Complete attachment teardown

When the caller scope ends, the attachment resource MUST reject every pending
command reply and Workflow resume resolver, close all proof queues, stop the
Workflow, command supervisor, effect-evaluation, and attempt Tasks, and run all
ordinary cleanup. Teardown MUST NOT use sleep, polling, a manual reducer crank,
or a durable proposal against the disposed attachment.

**Source**: DR-026

**Rationale**: A scope-owned attachment must not leak live work or deadlock its
callers.

**Acceptance Criteria**:

- [ ] Each pending exchange and effect receives a terminal rejection.
- [ ] Queue subscriptions report closed after teardown.
- [ ] All owned Task and resource lifecycle probes report finalization.
- [ ] Cleanup completes without clock-based synchronization.
- [ ] No authority or proposal event occurs after teardown begins.

#### REQ-021: Disposal is not logical cancellation

Ordinary scope exit, transport loss, or `setDisposition()` MUST NOT be converted
into a logical Workflow cancellation or `CancellationRequested` record. A
`cancel` protocol command, when used, MUST reject the pending Workflow boundary
with the existing `DurableProgramCancellation` behavior. The cancel command
MUST NOT itself issue an authority cancellation command or append semantic
history.

**Source**: DR-027

**Rationale**: Resource disposal and durable cancellation have different
semantic meanings.

**Acceptance Criteria**:

- [ ] Scope exit stops work without a cancellation semantic record.
- [ ] `transport_lost` disposition stops work without a cancellation semantic
      record.
- [ ] A valid cancel command terminates the Workflow boundary through the
      existing cancellation exception path.
- [ ] The proof does not claim that its cancel command is durable cancellation.

### 2.4 Typed attachment protocol

#### REQ-022: Closed message algebra

The proof MUST use distinct discriminated variants for start, authorization,
attempt completion, resume, cancel, proposal, completion, and failure. It MUST
NOT put an optional attempt outcome on a proposal or use one variant for both
pre-execution and post-execution phases. Every host-visible message MUST contain
only serializable data.

**Source**: DR-028

**Rationale**: Distinct phases make illegal transitions and accidental closure
transport visible.

**Acceptance Criteria**:

- [ ] Exhaustive TypeScript switches cover all command and event variants.
- [ ] `record-proposed` contains no outcome.
- [ ] `record-attempt-completed` always contains one outcome.
- [ ] No optional `authorizedOutcome` field exists in the proof protocol.
- [ ] Every event passes canonical JSON validation.

#### REQ-023: Sequential state machine

One attachment MUST allow at most one active `exchange()` and one pending
Workflow boundary. `start` MUST be the first command and MUST occur once.
`authorize-record` MUST match the pending proposal. `resume-record` MUST match
either the pending settled-replay proposal or the completed live attempt. A
wrong, duplicate, concurrent, stale, or out-of-order command MUST fail with
`program_protocol_error`, terminate the proof attachment, and reject all
pending rendezvous. It MUST NOT execute, resolve, or resume the boundary.

**Source**: DR-029

**Rationale**: Failing the attachment prevents recovery from an ambiguous local
protocol state.

**Acceptance Criteria**:

- [ ] The valid live and replay sequences reach one terminal event.
- [ ] Repeated start fails closed.
- [ ] Concurrent exchanges fail closed.
- [ ] Mismatched action, pull, attempt, descriptor, outcome, or receipt fails
      closed.
- [ ] A command after a terminal event or teardown fails with stale attachment
      behavior.
- [ ] No invalid sequence runs the closure or resumes the Workflow.

#### REQ-024: Exact proposal identity

The `record-proposed` event MUST carry the pending action index and the complete
`RecordedOperationDescriptor`. The host coordinator MUST pass that descriptor,
a full canonical descriptor digest, action position, pull identity, and retry
safety through the current `ReserveOperationRequest`. It MUST NOT compare or
reserve by `{ type, name }`, key alone, or action position alone.

**Source**: DR-030, DR-035

**Rationale**: Replay correctness depends on the complete descriptor and
position, not a weak local identity.

**Acceptance Criteria**:

- [ ] Changing the record key or retry safety at the same action position causes
      current replay-divergence behavior.
- [ ] The authority request uses the current descriptor and digest functions.
- [ ] The proof introduces no alternate pull-ID or descriptor-digest equation.

#### REQ-025: Intent before authorization

For a live record proposal, the host coordinator MUST complete
`execution.reserve-pull` and receive its committed authorized result before it
sends `authorize-record`. A failed reservation or reservation commit MUST NOT
start the attempt, invoke closure middleware, or expose the closure to the
host.

**Source**: DR-031, DR-036

**Rationale**: External execution is permitted only after durable intent and an
attempt fence exist.

**Acceptance Criteria**:

- [ ] `PullRequested` and `AttemptStarted` are readable from the committed
      journal before the first closure instruction runs.
- [ ] A forced reservation commit failure produces no attempt Task.
- [ ] A rejected reservation produces no authorization command.

#### REQ-026: Settlement confirmation before resume

After a live attempt returns, the host coordinator MUST submit
`execution.resolve-pull` with the exact accepted resolution capability and
outcome. It MUST wait for shell commit. It MUST then repeat the exact
`execution.reserve-pull` request and receive the committed outcome and receipt
before it sends `resume-record`. The resume command MUST use the confirmed
outcome and receipt, not the attempt's unaccepted local values.

**Source**: DR-032, DR-036

**Rationale**: The Workflow may observe only authority-accepted semantic facts.

**Acceptance Criteria**:

- [ ] `PullResolved` is committed before the Workflow executes its first
      post-record instruction.
- [ ] The confirm reservation returns the same outcome digest and resolution
      offset as the accepted settlement.
- [ ] A crash after settlement but before resume reconstructs from the accepted
      outcome without rerunning the closure.
- [ ] The local attempt outcome is discarded after confirmation.

#### REQ-027: Authority failure propagation

A rejected resolution, stale or wrong capability, failed reservation commit,
failed resolution commit, or exhausted stored CAS retry MUST fail or park the
host activation through current authority behavior. It MUST NOT produce a
successful `resume-record`, successful Workflow value, or accepted fold input.

**Source**: DR-033

**Rationale**: Local completion is not durable acceptance.

**Acceptance Criteria**:

- [ ] Each listed failure prevents successful resume.
- [ ] Failed evaluations add no record to `AuthorityJournalPort` output.
- [ ] The Workflow does not execute post-record success code.
- [ ] Current authority error identity is preserved.

#### REQ-028: Settled replay suppression

When exact reservation returns a settled result, the host coordinator MUST NOT
send `authorize-record`. It MUST NOT start an attempt Task, run the closure, or
run closure middleware. It MUST send `resume-record` with the authority-returned
outcome and receipt and `replayed: true`.

**Source**: DR-034

**Rationale**: Accepted durable outcomes replay without duplicate external
execution.

**Acceptance Criteria**:

- [ ] Reconstruction reaches the same proposal and receives the accepted
      outcome.
- [ ] Closure and middleware lifecycle probes remain untouched.
- [ ] No new `AttemptStarted` or `PullResolved` record is appended.
- [ ] The terminal Workflow result matches the live result for success, error,
      and cancellation outcomes.

### 2.5 Authority guarantees

#### REQ-029: Retained authority validation

The proof MUST use current program capabilities, resolution capabilities,
audience checks, full descriptor digest checks, pull and attempt identity,
result validation, canonical JSON rules, maximum outcome size, receipt rules,
and public result semantics. It MUST NOT define a weaker proof capability,
digest, schema, receipt, or identity path.

**Source**: DR-035

**Rationale**: The proof evaluates Workflow and ownership composition, not a
weaker trust model.

**Acceptance Criteria**:

- [ ] Wrong program or resolution capability is rejected by current authority
      code.
- [ ] Wrong audience, descriptor, pull, attempt, schema, or outcome digest is
      rejected by current authority code.
- [ ] Over-size and non-canonical record values retain current errors.
- [ ] Accepted and duplicate receipts retain current fields and status.

#### REQ-030: Committed record order

The live record journal order MUST be `PullRequested`, `AttemptStarted`, then
`PullResolved`, with any applicable unsafe-transition records between attempt
start and resolution. `PullRequested` and `AttemptStarted` MUST share the
committed reservation transition. `PullResolved` MUST belong only to an
accepted settlement or authority-created indeterminate settlement.

**Source**: DR-036

**Rationale**: This order proves intent before execution and acceptance before
resume.

**Acceptance Criteria**:

- [ ] Record offsets establish the required strict order.
- [ ] No closure probe fires before `AttemptStarted` is readable.
- [ ] No post-boundary Workflow probe fires before `PullResolved` is readable.
- [ ] Failed shell evaluations contribute no offset.

#### REQ-031: Unsafe indeterminate path

The unsafe conformance scenario MUST reserve an unsafe record, run its closure
far enough to produce or perform its external outcome, and then lose the
settlement path before authority accepts that outcome. It MUST issue current
attempt detachment. The accepted journal MUST contain `AttemptDetached`,
`PullIndeterminate`, `AttemptAbandoned`, and the authority-created
`PullResolved` error with code `effect_outcome_indeterminate`. The produced but
unaccepted closure outcome MUST NOT appear in replay or the semantic fold.

**Source**: DR-037

**Rationale**: Unsafe ambiguity is the key guarantee that outcome-only
journaling does not provide.

**Acceptance Criteria**:

- [ ] The closure outcome probe completes before detachment.
- [ ] No `execution.resolve-pull` accepts that local outcome.
- [ ] The four authority records appear in their current order.
- [ ] Exact replay returns only `effect_outcome_indeterminate`.
- [ ] The local produced value is absent from accepted records and folded
      settlement.

### 2.6 Semantic journal fold

#### REQ-032: Accepted record vocabulary

`foldRecordExecutionIndex(records)` MUST accept the record-only root vocabulary:
`TaskOpened`, `PullRequested`, `AttemptStarted`, `AttemptDetached`,
`PullIndeterminate`, `AttemptAbandoned`, `PullResolved`, and `TaskClosed` as
applicable. It MUST also accept `AttemptOutcomeUnknown` if the selected current
unsafe path emits that record. It MUST derive state from record payloads and
record metadata only.

**Source**: DR-038

**Rationale**: The fold tests whether accepted semantic history contains the
record path's execution meaning.

**Acceptance Criteria**:

- [ ] Happy, error, cancellation, replay, and unsafe record histories fold.
- [ ] An `AttemptOutcomeUnknown` fixture marks the matching attempt as
      indeterminate without inventing a settlement.
- [ ] The fold has no `AuthorityState`, shell, capability, or live attachment
      input.

#### REQ-033: Pure and strict fold

The semantic fold MUST be pure and deterministic. It MUST NOT mutate input
records or retain mutable references to their payloads. It MUST reject an
offset gap, non-monotonic offset, conflicting event identity, duplicate task,
unknown task or pull reference, conflicting action or pull identity, invalid
attempt transition, duplicate settlement, settlement for an unknown attempt,
and task closure before all record pulls are settled.

**Source**: DR-039

**Rationale**: A journal projection is useful only if malformed or conflicting
history cannot produce plausible state.

**Acceptance Criteria**:

- [ ] Folding the same deep-frozen input twice produces deep-equal output.
- [ ] Input remains unchanged.
- [ ] One negative fixture covers each listed invalid history class.
- [ ] Reordering two dependent accepted records is rejected.

#### REQ-034: Semantic index content and secret exclusion

The folded `RecordExecutionIndex` MUST contain task identity, origin, pinned
program identity, input, task lifecycle, action index, pull index, pull ID,
complete record descriptor, attempt ID, attempt index, attempt lifecycle,
settlement outcome, outcome digest, resolution offset, and terminal task outcome
when present. It MUST NOT contain capabilities, nonces, leases, restore values,
attachment identifiers, execution Scopes, signing material, queues, resolvers,
Tasks, closures, or other live runtime objects.

**Source**: DR-040, DR-041

**Rationale**: Semantic history must support replay diagnostics without leaking
private authorization or process state.

**Acceptance Criteria**:

- [ ] A complete live history projects every required semantic field.
- [ ] An active history omits only fields that have no accepted record yet.
- [ ] A recursive key and value inspection finds no prohibited private or live
      field.
- [ ] The index serializes after converting its read-only maps to deterministic
      entry arrays.

#### REQ-035: Transition-by-transition comparison

After each accepted record-path transition, the proof MUST read committed
records, fold them, and compare the result with current public
`task.execution-state`, `pull.state`, and execution-tree projection data that
has a semantic counterpart. The comparison MAY normalize deployment-specific
storage metadata. It MUST NOT normalize task, action, pull, attempt, descriptor,
outcome, digest, receipt position, or terminal lifecycle differences.

**Source**: DR-042

**Rationale**: The fold must agree with current observable semantics at each
frontier, not only after task completion.

**Acceptance Criteria**:

- [ ] Comparison occurs after open, reserve, resolution, completion, and each
      accepted unsafe transition command.
- [ ] Memory and stored modes use the same semantic normalizer.
- [ ] A fixture with one altered semantic identity, position, outcome, or digest
      fails comparison.
- [ ] Private authority fields are neither projected nor compared.

#### REQ-036: Stored CAS reevaluation

A forced stored CAS conflict MUST discard the failed command evaluation and all
of its proposed entries, private values, outcomes, capabilities, and receipts.
The stored shell MUST rerun the complete current decision pipeline against the
new head. Only the successful commit's records may enter the fold or permit a
Workflow resume.

**Source**: DR-043

**Rationale**: CAS retries must reevaluate authority decisions; they cannot
reuse speculative semantic or private outputs.

**Acceptance Criteria**:

- [ ] A deterministic store barrier creates a real compare-and-swap conflict.
- [ ] The failed evaluation's entries are absent from `readTree()`.
- [ ] The returned result and fold correspond to the successful reevaluation.
- [ ] One committed reservation or resolution frontier is observable.

### 2.7 Verification and decision gate

#### REQ-037: Compile-time conformance

The proof test suite MUST compile positive fixtures for a valid Workflow,
`record()`, and `ephemeral()`. It MUST compile negative fixtures with checked
`@ts-expect-error` assertions for direct plain-Operation yield and plain
Operation use as a Workflow child. The compile check MUST run with TypeScript
5.9.3 and the repository configuration.

**Source**: DR-044

**Rationale**: Runtime tests cannot prove the authoring boundary.

**Acceptance Criteria**:

- [ ] All positive fixtures compile without suppression.
- [ ] Each forbidden use produces an expected compiler error.
- [ ] Removing a forbidden-use error causes an unused `@ts-expect-error`
      failure.
- [ ] The package `check` command includes the fixtures.

#### REQ-038: Scope and resource conformance

Tests MUST prove that `provide()` returns the handle while the attachment stays
active, resource Context reaches only resource descendants, durable and
ephemeral evaluation each receives a new `Scope.run()` child Task scope, and
caller scope exit finalizes every owned Task.

**Source**: DR-045

**Rationale**: Ownership and Context direction are the central Effection claims
of the proof.

**Acceptance Criteria**:

- [ ] Lifecycle probes establish the topology in Section 4.4.
- [ ] The host uses the handle while the resource task remains suspended after
      `provide()`.
- [ ] Parent and sibling Context isolation is verified.
- [ ] Every child cleanup probe settles before the scenario exits.

#### REQ-039: Runtime scenario coverage

Runtime scenarios MUST cover immediate proposal before host wait, successful
record execution, accepted record error, accepted record cancellation, settled
replay, closure and middleware suppression on replay, attachment disposal,
wrong command, duplicate command, concurrent exchange, and missing
`ProgramEffectRuntimeContext`.

**Source**: DR-046

**Rationale**: The proof must exercise positive, negative, replay, and teardown
behavior.

**Acceptance Criteria**:

- [ ] Each listed case has an observable assertion.
- [ ] Success, error, and cancellation compare live and replay terminal results.
- [ ] Protocol-negative cases assert no closure execution and no Workflow
      resume.
- [ ] Missing Context asserts no proposal or authority command.

#### REQ-040: Cross-shell authority scenarios

Authority scenarios MUST run in both memory and stored modes. They MUST cover
failed reservation commit, forced CAS retry, unsafe indeterminate detachment,
failed resolution, accepted resolution, and loss after settlement commit before
Workflow resume.

**Source**: DR-047

**Rationale**: The proof claims one semantic protocol across both current shell
implementations.

**Acceptance Criteria**:

- [ ] A shared scenario harness executes the matrix in both modes.
- [ ] Mode-specific setup does not replace authority methods.
- [ ] Equivalent semantic records and public results match after allowed
      metadata normalization.
- [ ] The post-settlement-loss case reconstructs without closure execution.

#### REQ-041: Causal test synchronization

Scenarios MUST synchronize through named queue, command, commit, attempt, CAS,
and resume barriers. They MUST NOT use sleeps, polling, manual reducer cranks,
or incidental call counts as synchronization. Exact counts MAY be asserted when
the count is itself specified behavior, such as one authorization or no replay
attempt.

**Source**: DR-048

**Rationale**: Causal controls make race and crash windows deterministic.

**Acceptance Criteria**:

- [ ] Every forced window names the semantic event that opens and releases it.
- [ ] No test relies on elapsed time to infer progress.
- [ ] Count assertions correspond to an explicit protocol guarantee.

#### REQ-042: Test teardown verification

Every proof scenario MUST fail teardown if a Queue remains open, a resolver
remains pending, an owned Task or resource remains active, or a controlled store
operation remains unanswered. Teardown checks MUST run for successful and
failed scenario bodies.

**Source**: DR-049

**Rationale**: A passing assertion cannot hide leaked structured-concurrency or
store work.

**Acceptance Criteria**:

- [ ] The scenario harness installs teardown checks in an Effection or test
      finalizer.
- [ ] Deliberate queue, resolver, Task, resource, and store leaks each make a
      harness self-test fail.
- [ ] Failure-path scenarios complete teardown without timeout polling.

#### REQ-043: Positive success gate

The evidence verdict MUST be `pass` only when compile-time Workflow restriction,
attachment-resource ownership, Context inheritance, authority ordering,
settled replay suppression, unsafe ambiguity, CAS reevaluation, semantic fold,
and trust-boundary checks all conform. A pass MUST NOT weaken any current
identity, capability, schema, size, receipt, or error guarantee.

**Source**: DR-050

**Rationale**: The proof is valuable only as one coherent vertical path.

**Acceptance Criteria**:

- [ ] The evidence report links each gate to passing tests or source checks.
- [ ] No gate is waived because another gate passed.
- [ ] The report names the current authority guarantees it preserved.

#### REQ-044: Rejection gate

The evidence verdict MUST be `reject` if the proof requires a raw authority
driver in Workflow scope, private capability material in semantic records, a
foreign captured Scope in the host, a second production command stack, a
production feature selector, or special behavior in Effection's reducer. The
proof MUST remain test-only even when its verdict is `pass`.

**Source**: DR-051

**Rationale**: These conditions would invalidate the intended ownership or
security model.

**Acceptance Criteria**:

- [ ] The report evaluates each rejection condition separately.
- [ ] A source check confirms no prohibited production stack or selector.
- [ ] A recursive fold check confirms no capability material.
- [ ] A pass verdict still states that no production cutover is authorized.

#### REQ-045: Detailed migration map

The evidence report SHOULD map the current responsibilities in
`program-authoring.ts`, `program-context.ts`, `local-program-driver.ts`,
`program-driver-contract.ts`, `program-runtime.ts`, and
`journal-program-runtime.ts` to one of `retain`, `move`, `replace`, or `delete`
for a possible future atomic migration. It SHOULD also name the later work for
worker and AgentCore drivers.

**Source**: DR-052

**Rationale**: A responsibility map shows whether the proof can simplify the
whole runtime instead of adding another layer. This is a SHOULD because a
rejected proof may not justify a detailed migration plan.

**Acceptance Criteria**:

- [ ] A pass verdict includes every named source file and one disposition per
      relevant responsibility.
- [ ] The map distinguishes production cutover work from proof code.
- [ ] Any omitted map in a rejection explains why further mapping has no value.

### 2.8 Environmental and integrity constraints

#### REQ-046: Pinned implementation environment

The proof MUST use Effection `4.1.0-alpha.9`, TypeScript `5.9.3`, and the current
workspace dependency graph. It MUST NOT add a package or create a dependency
cycle.

**Source**: Approved design Constraints and Dependencies; DR-006, DR-008

**Rationale**: Effect typing and resource behavior are version-sensitive, and
the proof must fit the current package graph.

**Acceptance Criteria**:

- [ ] Lockfile and workspace catalog resolve the pinned versions.
- [ ] No new workspace package or circular dependency is introduced.
- [ ] Package build and type checks run through existing scripts.

#### REQ-047: Append-only accepted history

The proof MUST treat accepted semantic records as immutable and append-only. It
MUST NOT rewrite an accepted record, insert an entry at an old offset, or fold a
failed shell evaluation. Current canonical JSON, keyring, schema registry,
outcome bounds, and error taxonomy MUST remain authoritative.

**Source**: Approved design Constraints; DR-035, DR-039, DR-043

**Rationale**: The proof cannot derive semantics by changing the history or
validation rules it claims to test.

**Acceptance Criteria**:

- [ ] Journal reads before and after later transitions preserve prior entries
      byte-for-byte under canonical representation.
- [ ] Offsets append monotonically.
- [ ] Failed evaluations do not alter accepted history.
- [ ] Validation and key material come from current shell configuration.

#### REQ-048: Existing-work protection

Implementation work MUST NOT reset, discard, overwrite, or reformat unrelated
changes in the existing Sweatpants worktree. Proof changes MUST remain limited
to test-only proof source, its tests, the testing export, and the evidence
artifact unless a build configuration change is required to compile those
files.

**Source**: Approved design Constraints

**Rationale**: The proof is being built in an active, dirty refactor worktree.

**Acceptance Criteria**:

- [ ] The implementation diff contains no unrelated source reset or broad
      formatting change.
- [ ] Any build configuration change is narrow and explained in the evidence
      report.

#### REQ-049: Authority and secret isolation

Only the host coordinator MAY call Journal Authority ports. Workflow code, the
record closure, the attachment handle, attachment events, and the semantic fold
MUST NOT receive a raw authority driver, program capability, resolution
capability, keyring, lease, nonce, restore ticket, or signing material. The host
coordinator MUST retain resolution capability only until accepted resolution or
teardown.

**Source**: DR-011, DR-018, DR-035, DR-041, DR-051

**Rationale**: Workflow execution and semantic history are outside the private
authority trust boundary.

**Acceptance Criteria**:

- [ ] Type and source inspection confines authority-port calls to the host
      coordinator.
- [ ] The attachment command/event schemas contain no capability field.
- [ ] Closure Context and arguments contain only pull ID, attempt ID, and
      cancellation signal.
- [ ] Teardown drops host-held capability references.

## 3. Normative Interfaces

This section fixes the interface shapes referenced by the requirements. The
proof may use different symbol names only when the types are equivalent and the
evidence report maps the names.

### 3.1 Workflow effects

```ts
import type { Effect, Operation } from "effection";
import type { Json } from "@sweatpants/foundation";
import type {
  OperationOutcome,
  RecordedOperationDescriptor,
  RecordAttemptContext,
  RecordOptions,
} from "@sweatpants/durable-execution";

type SerializableProgramProposal =
  | {
      readonly type: "operation";
      readonly descriptor: RecordedOperationDescriptor;
    }
  | { readonly type: "ephemeral" };

type DurableProgramEffect<T> = Effect<T> & {
  readonly proposal: SerializableProgramProposal;
};

type Workflow<T> = Generator<DurableProgramEffect<unknown>, T, unknown>;

function record<T extends Json>(
  options: RecordOptions,
  execute: (attempt: RecordAttemptContext) => Operation<T>,
): Workflow<T>;

function ephemeral<T>(operation: Operation<T>): Workflow<T>;
```

The `ephemeral` marker is local metadata. It is not an attachment proposal and
never reaches Journal Authority. The runtime-only record boundary is:

```ts
interface RuntimeRecordBoundary<T extends Json> {
  readonly serializable: Extract<
    SerializableProgramProposal,
    { readonly type: "operation" }
  >;
  readonly execute: (attempt: RecordAttemptContext) => Operation<T>;
}

interface ProofProgramEffectRuntime {
  perform<T extends Json>(
    boundary: RuntimeRecordBoundary<T>,
  ): Operation<OperationOutcome>;
}
```

`record()` unwraps the accepted `OperationOutcome` with current durable-program
semantics. An `ok` outcome returns its canonical JSON value. An `error` outcome
throws the corresponding durable error. A `cancelled` outcome throws
`DurableProgramCancellation` with its optional partial value.

### 3.2 Attachment commands and events

```ts
type ProofProgramCommand =
  | { readonly type: "start"; readonly input: Json }
  | {
      readonly type: "authorize-record";
      readonly actionIndex: number;
      readonly pullId: string;
      readonly attemptId: string;
      readonly descriptor: RecordedOperationDescriptor;
    }
  | {
      readonly type: "resume-record";
      readonly actionIndex: number;
      readonly outcome: OperationOutcome;
      readonly receipt: ResolutionReceipt;
      readonly replayed: boolean;
    }
  | { readonly type: "cancel"; readonly reason?: string };

type ProofProgramEvent =
  | {
      readonly type: "record-proposed";
      readonly actionIndex: number;
      readonly descriptor: RecordedOperationDescriptor;
    }
  | {
      readonly type: "record-attempt-completed";
      readonly actionIndex: number;
      readonly attemptId: string;
      readonly outcome: OperationOutcome;
    }
  | {
      readonly type: "completed";
      readonly actionIndex: number;
      readonly value: Json;
    }
  | {
      readonly type: "failed";
      readonly actionIndex: number;
      readonly error: SerializedApplicationError;
    };

interface ProofProgramAttachmentHandle {
  exchange(command: ProofProgramCommand): Operation<ProofProgramEvent>;
  setDisposition(reason: ProgramShutdownReason): void;
}

function openProofProgramAttachment(
  request: AttachProgramRequest,
  workflow: () => Workflow<Json>,
): Operation<ProofProgramAttachmentHandle>;
```

The bound Workflow uses `request.input`. `start.input` is a canonical protocol
check and must equal `request.input`. The first record proposal uses action
index `0`. A successful resume consumes that action and the terminal event uses
action index `1`.

The live state sequence is:

```text
created
  -> start
proposed(action 0)
  -> authorize-record
attempt-completed(action 0)
  -> resume-record
terminal(action 1)
```

The replay state sequence is:

```text
created
  -> start
proposed(action 0)
  -> resume-record(replayed = true)
terminal(action 1)
```

A protocol failure moves directly to `disposed`. Resource scope exit also moves
to `disposed`, but it is not logical cancellation.

### 3.3 Record execution index

```ts
interface RecordExecutionIndex {
  readonly tasks: ReadonlyMap<string, RecordTaskIndex>;
}

interface RecordTaskIndex {
  readonly taskId: string;
  readonly origin: TaskOrigin;
  readonly artifact: PinnedProgram;
  readonly input: Json;
  readonly actions: readonly RecordActionIndex[];
  readonly lifecycle:
    | { readonly status: "active" }
    | {
        readonly status: "closed";
        readonly outcome: OperationOutcome;
        readonly offset: string;
      };
}

interface RecordActionIndex {
  readonly actionIndex: number;
  readonly pullIndex: number;
  readonly pullId: string;
  readonly descriptor: RecordedOperationDescriptor;
  readonly attempts: readonly RecordAttemptIndex[];
  readonly settlement?: {
    readonly outcome: OperationOutcome;
    readonly outcomeDigest: string;
    readonly resolutionOffset: string;
  };
}

interface RecordAttemptIndex {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly status:
    | "started"
    | "detached"
    | "abandoned"
    | "completed"
    | "indeterminate";
}

function foldRecordExecutionIndex(
  records: readonly DurableSemanticRecord[],
): RecordExecutionIndex;
```

`PullResolved.attemptId`, when present, marks that attempt `completed` unless an
accepted unsafe transition has already marked it `abandoned` or
`indeterminate`. `PullIndeterminate` marks the named attempt `indeterminate` at
that frontier. A following `AttemptAbandoned` records the terminal abandoned
state while the pull settlement retains the authority-created indeterminate
outcome. The fold comparator preserves both facts.

### 3.4 Ownership topology

A conforming attachment has this ownership tree:

```text
Activation scope
├─ attachment resource task scope
│  ├─ command-supervisor Task
│  │  └─ record-attempt Task while authorized
│  └─ Workflow Task
│     └─ effect-evaluation child Task while an effect is entered
└─ bounded authority command and query Operations
```

The host coordinator is in the Activation scope. It owns bounded authority
Operations but does not own or expose the attachment's Workflow and attempt
Tasks.

## 4. Protocol Semantics

### 4.1 Attachment acquisition

1. The Activation Operation yields `openProofProgramAttachment()`.
2. Effection starts the attachment resource task as a child of the Activation
   scope.
3. The resource creates its queues, pending-resolver registry, runtime Context,
   command supervisor, and Workflow Task.
4. The Workflow may publish its first event into the buffered event queue.
5. The resource calls `provide(handle)` and suspends.
6. The Activation Operation receives the handle. The resource and its children
   remain active.

### 4.2 Live record

1. The host exchanges `start` and receives `record-proposed`.
2. The host sends `execution.reserve-pull` through `JournalAuthorityPort`.
3. The shell commits `PullRequested` and `AttemptStarted` atomically.
4. The host sends `authorize-record` with the accepted action, pull, attempt,
   and descriptor identities.
5. The resource supervisor starts the attempt Task.
6. The Task returns one canonical `OperationOutcome` in
   `record-attempt-completed`.
7. The host sends `execution.resolve-pull` with its retained resolution
   capability and that outcome.
8. The shell commits `PullResolved`.
9. The host repeats the exact reservation and receives the committed outcome and
   receipt.
10. The host sends `resume-record` with the confirmed values.
11. The effect child settles. Effection resumes the Workflow generator.
12. The host receives the next event, which is terminal in this proof.

### 4.3 Settled reconstruction

1. A fresh attachment starts the root Workflow.
2. The same synchronous and ephemeral work runs again.
3. The same record proposal reaches the host.
4. Exact reservation returns the committed settlement.
5. The host skips authorization and sends the committed outcome and receipt in
   `resume-record` with `replayed: true`.
6. The Workflow reaches the same terminal result without closure execution.

### 4.4 Unsafe settlement loss

1. Reservation commits unsafe intent and attempt identity.
2. The resource executes the unsafe closure.
3. The deterministic rig captures its produced outcome.
4. The rig prevents `execution.resolve-pull` from accepting that outcome.
5. The host disposes or loses the settlement path.
6. The host issues current `execution.detach-attempt` handling.
7. Authority commits detachment, indeterminate, abandonment, and its own
   `effect_outcome_indeterminate` settlement.
8. Later exact replay uses only that accepted settlement.

## 5. Error Handling

| Condition | Required result | Attachment state |
| --- | --- | --- |
| Missing `ProgramEffectRuntimeContext` | Effect fails before publication | Workflow fails |
| Invalid record options or descriptor | Existing descriptor error | No boundary |
| Nested durable operation in closure | `nested_durable_operation` outcome | Awaiting authority settlement |
| Wrong, duplicate, concurrent, or out-of-order command | `program_protocol_error` | Disposed |
| Command after disposal | Existing stale attachment/capability behavior | Disposed |
| Closure throws | Existing serialized error outcome | Awaiting authority settlement |
| Attempt cancellation signal fires | Canonical cancelled outcome | Awaiting authority settlement |
| Record value is invalid or too large | Existing record validation error outcome | Awaiting authority settlement |
| Reservation or settlement rejected | Current authority error | Not resumed |
| Stored CAS retries exhausted | Current stored-shell error | Not resumed |
| Unsafe settlement path lost | Accepted `effect_outcome_indeterminate` | Replayable settlement |
| Scope exits with pending work | Pending operations reject; cleanup runs | Disposed |

Protocol failure is fail-closed. The implementation does not attempt to repair a
local message sequence after a protocol error. Authority rejection preserves
its current error code, details policy, and retry semantics.

## 6. Security Considerations

The host coordinator is the only proof component inside the Journal Authority
trust boundary. The Workflow and closure receive no authority driver or
capability. The attachment receives only accepted public identity needed to run
the closure. It does not receive the resolution capability.

The journal is semantic history. It contains descriptors, attempts, accepted
outcomes, and receipts as defined by current record payloads. It excludes
capabilities, key material, leases, nonces, restore state, attachment handles,
and live Effection objects.

Exact descriptor and attempt identity prevents replay under changed work.
Commit-before-authorization prevents execution from uncommitted intent.
Capability-bound settlement prevents an untrusted attempt from accepting its
own outcome. Commit-and-confirm-before-resume prevents a local result from
becoming program state before durable acceptance. Unsafe detachment converts an
ambiguous result into an authority-created indeterminate error rather than
replaying an unaccepted value.

## 7. Migration and Compatibility

This proof has no production compatibility mode. Current production programs
remain unrestricted `Operation<T>` factories. Current drivers continue to use
`attach`, `step`, `shutdown`, and optional `restore`. Current snapshots,
journals, capabilities, and remote transports remain unchanged.

A successful proof does not authorize production use. A future migration must
have a new approved design and specification. That work must choose one
production authoring contract and one semantic-state derivation model. It must
migrate all affected durable operations and drivers atomically or define a new
reviewed transition that does not leave a permanent mixed model.

Implementation work occurs in an existing dirty worktree. Conformance to this
specification does not authorize resetting or overwriting unrelated work.

## 8. Design Traceability

| Design requirement | Specification requirement |
| --- | --- |
| DR-001 | REQ-001 |
| DR-002 | REQ-002 |
| DR-003 | REQ-002 |
| DR-004 | REQ-003 |
| DR-005 | REQ-004 |
| DR-006 | REQ-001, REQ-046 |
| DR-007 | REQ-005 |
| DR-008 | REQ-006, REQ-046 |
| DR-009 | REQ-007 |
| DR-010 | REQ-008 |
| DR-011 | REQ-008, REQ-049 |
| DR-012 | REQ-009 |
| DR-013 | REQ-010 |
| DR-014 | REQ-011 |
| DR-015 | REQ-012 |
| DR-016 | REQ-013 |
| DR-017 | REQ-014 |
| DR-018 | REQ-015, REQ-049 |
| DR-019 | REQ-016 |
| DR-020 | REQ-016 |
| DR-021 | REQ-017 |
| DR-022 | REQ-017 |
| DR-023 | REQ-018 |
| DR-024 | REQ-018 |
| DR-025 | REQ-019 |
| DR-026 | REQ-020 |
| DR-027 | REQ-015, REQ-021 |
| DR-028 | REQ-022 |
| DR-029 | REQ-023 |
| DR-030 | REQ-008, REQ-024 |
| DR-031 | REQ-025 |
| DR-032 | REQ-026 |
| DR-033 | REQ-027 |
| DR-034 | REQ-028 |
| DR-035 | REQ-008, REQ-024, REQ-029, REQ-047, REQ-049 |
| DR-036 | REQ-025, REQ-026, REQ-030 |
| DR-037 | REQ-031 |
| DR-038 | REQ-032 |
| DR-039 | REQ-033, REQ-047 |
| DR-040 | REQ-034 |
| DR-041 | REQ-034, REQ-049 |
| DR-042 | REQ-035 |
| DR-043 | REQ-036, REQ-047 |
| DR-044 | REQ-037 |
| DR-045 | REQ-038 |
| DR-046 | REQ-039 |
| DR-047 | REQ-040 |
| DR-048 | REQ-041 |
| DR-049 | REQ-042 |
| DR-050 | REQ-043 |
| DR-051 | REQ-044, REQ-049 |
| DR-052 | REQ-045 |

## References

- [RFC 2119: Key words for use in RFCs to Indicate Requirement Levels](https://www.rfc-editor.org/rfc/rfc2119)
- [RFC 8174: Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words](https://www.rfc-editor.org/rfc/rfc8174)
- [Approved design memo](./authority-backed-effection-workflow-design.md)
- [Effection-native durable programs specification](./effection-native-durable-programs-spec.md)
- `sweatpants/packages/durable-execution/src/program-authoring.ts`
- `sweatpants/packages/durable-execution/src/program-driver-contract.ts`
- `sweatpants/packages/durable-execution/src/local-program-driver.ts`
- `sweatpants/packages/journal-authority/src/authority-contract.ts`
- `sweatpants/packages/journal-authority/src/journal-program-runtime.ts`
- `sweatpants/packages/journal-authority/src/semantic-record.ts`
- `sweatpants/packages/journal-authority/src/execution-forest.ts`
- `sweatpants/node_modules/effection/esm/lib/resource.d.ts`
- `sweatpants/node_modules/effection/esm/lib/types.d.ts`
- `sweatpants/node_modules/effection/esm/lib/queue.d.ts`
- `sweatpants/node_modules/effection/esm/lib/signal.d.ts`
- `sweatpants/node_modules/effection/esm/lib/channel.d.ts`
