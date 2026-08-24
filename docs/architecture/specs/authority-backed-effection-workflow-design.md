# Design: Authority-Backed Effection Workflow: Record Vertical Path

## Status

Draft

## Overview

This design defines a non-production vertical proof for one root program that
performs one durable `record` operation. The proof combines two models:

- Effection owns the live program, attachment, attempt, cancellation, and
  cleanup lifetimes.
- Journal Authority admits intent before execution, fences one attempt, accepts
  the outcome, and commits durable facts before the program resumes.

The proof tests a stricter authoring model than the current Sweatpants runtime.
A program returns `Workflow<T>`, where the generator may yield only
`DurableProgramEffect` values. Ordinary Effection work requires an explicit
`ephemeral(operation)` wrapper and reruns during reconstruction. This differs
from the earlier `effection-native-durable-programs` design, which deliberately
made a durable program an unrestricted `Operation<T>`. The proof does not
silently supersede that design. It gathers the evidence needed for a later
production cutover decision.

The program attachment is an Effection resource. Its resource task owns the
workflow task, a command supervisor, buffered queues, pending resolvers, and any
record-attempt task. The resource provides an attachment handle to the host.
The handle sends commands into the resource-owned supervisor; calling a handle
method does not move resource-owned work into the caller's scope.

The record path retains the current authority protocol:

```text
reserve and commit PullRequested + AttemptStarted
  -> execute the authorized closure
  -> resolve and commit PullResolved
  -> reserve again to confirm the committed outcome
  -> resume the workflow
```

The proof also builds a semantic record index by folding accepted journal
entries. It compares that index with public authority observations after each
transition. Capabilities, nonces, leases, attachment fences, and restore data
remain private and do not enter the semantic fold.

The implementation belongs under the existing
`@sweatpants/journal-authority/testing` boundary. It must not become a public
runtime alternative, a feature flag, or a permanent record-only state model.
A later reviewed design must authorize any production cutover.

## Goals

- Prove that `Workflow<T>` rejects ordinary Effection Operations unless the
  author wraps them with `ephemeral()`.
- Prove that a custom durable effect can use the current Effection reducer
  without changing Effection internals.
- Model a program attachment as an Effection resource that provides a handle
  while resource-owned tasks continue in the background.
- Use Effection queues and `withResolvers()` for buffered, one-consumer
  operation-to-operation coordination.
- Keep Signals limited to callbacks that originate outside Effection.
- Preserve intent-before-execution, exact descriptor identity, attempt fencing,
  capability-bound settlement, and commit-before-resume.
- Prove accepted record success, error, and cancellation replay without running
  the closure again.
- Prove the unsafe indeterminate window instead of testing only the repeatable
  happy path.
- Prove that the record path's semantic execution index can be derived from
  accepted journal entries without capability or control secrets.
- Run the same proof against current in-memory and stored authority ports.
- Produce enough evidence to accept or reject a later atomic production
  migration without landing a mixed runtime.

## Non-Goals

- Ship `Workflow<T>`, `ephemeral()`, the attachment-resource API, or the proof
  coordinator as a production export.
- Replace the current `DurableProgramFactory`, `ProgramDriver`, `ProgramPeer`,
  `ProgramRuntime`, or `JournalAuthorityPort` in this proof.
- Land a state where record pulls use journal-derived authority state while
  other pull kinds use independent semantic mutation.
- Migrate effects, elicitations, waits, emissions, clocks, child operations,
  cancellation unwind, activation, or recovery.
- Change capability claims, program identity equations, descriptor digests,
  result schemas, retry-safety rules, journal payloads, receipts, or public
  error codes.
- Weaken descriptor comparison to `{ type, name }`.
- Put capabilities, nonces, leases, restore tickets, attachment identifiers, or
  signing material into semantic history.
- Replace stored-authority CAS, add session partitioning, or optimize journal
  head hashing in this proof.
- Use an Effection Channel for the single-consumer attachment protocol.
- Use an Effection Signal for messages sent from one Operation to another.
- Treat a record attempt as a resource when it returns one terminal outcome and
  provides no early handle.
- Provide backward compatibility for a future production Workflow cutover.
- Decide the future production migration solely from source-line counts.

## Requirements

Each requirement has a stable ID and MoSCoW priority. Priorities map forward to
specification keywords: Must to MUST, Should to SHOULD, and Could to MAY.

### Proof containment and evidence

- **DR-001 (Must):** The vertical proof must live under the existing
  `@sweatpants/journal-authority/testing` boundary or an equivalent
  package-owned test-only boundary. Default package exports and production
  composition must not expose or select it.
- **DR-002 (Must):** The proof must not change the active production
  `DurableProgramFactory`, `ProgramDriver`, `ProgramRuntime`, authority command
  algebra, snapshot format, or journal payload union.
- **DR-003 (Must):** No runtime flag, compatibility adapter, or descriptor kind
  may select between the proof and production paths.
- **DR-004 (Must):** The proof must run through real `JournalAuthorityPort`,
  `AuthorityJournalPort`, and current in-memory and stored shell compositions.
  It must not mock authority methods or return fabricated command results.
- **DR-005 (Must):** A successful proof must identify the production types and
  source paths that a later atomic cutover could remove or replace. Failure to
  identify a simpler replacement path counts as negative evidence, not as a
  reason to ship the proof.
- **DR-006 (Must):** The proof must be removed or remain quarantined behind the
  test-only export until a separate reviewed design authorizes a production
  cutover. It must not become an undocumented incubating API.

### Workflow and durable effects

- **DR-007 (Must):** The proof must define
  `Workflow<T> = Generator<DurableProgramEffect<unknown>, T, unknown>` or a
  type-equivalent form that causes TypeScript to reject a plain
  `Operation<T>` yielded directly from a Workflow.
- **DR-008 (Must):** `DurableProgramEffect<T>` must be structurally assignable
  to the pinned Effection `Effect<T>` contract without modifying Effection's
  reducer, scope, task, or effect implementation.
- **DR-009 (Must):** The proof program factory must return `Workflow<T>` and
  must execute synchronous JavaScript normally.
- **DR-010 (Must):** `record()` must return `Workflow<T>` and yield one durable
  effect that carries a serializable record descriptor plus a runtime-only
  closure.
- **DR-011 (Must):** The serializable proposal sent to the host must not contain
  the closure, scope, context object, resolver, task, signal, queue, or
  attachment handle.
- **DR-012 (Must):** The proof must provide
  `ephemeral<T>(operation: Operation<T>): Workflow<T>`. Its wrapped operation
  must create no authority command or semantic journal entry and must run again
  on reconstruction.
- **DR-013 (Must):** `ephemeral()` must preserve structured cancellation. Its
  Effect evaluation must start the wrapped Operation with `Scope.run()` from
  the workflow coroutine's current scope. Effection therefore gives the
  wrapped Operation a new child Task scope with inherited Context values. The
  child Task must stop when its owner scope stops.
- **DR-014 (Must):** Durable Effect evaluation must also start its runtime
  Operation as a child Task with `Scope.run()`. That Operation must resolve the
  attachment runtime through `ProgramEffectRuntimeContext.expect()` in its
  inherited child scope and fail closed when the Context is absent. It must not
  read a fabricated scope view or fall back to a global authority.
- **DR-015 (Must):** A record closure may run ordinary Effection Operations but
  must fail with the retained `nested_durable_operation` behavior if it tries to
  enter another durable program effect.

### Effection resource and communication semantics

- **DR-016 (Must):** The proof attachment must be an Effection `resource()`
  Operation. Its resource task must call `provide(attachmentHandle)` and remain
  suspended until the caller's owning scope ends.
- **DR-017 (Must):** The attachment resource must set its internal effect-runtime
  Context in the resource task's scope before it spawns the workflow. The
  workflow and internal supervisor may inherit that Context. The host caller
  must not observe it.
- **DR-018 (Must):** The attachment handle provided to the host must contain
  only bounded protocol operations and disposition control. It must not expose
  the resource task's `Scope`, queues, pending resolvers, workflow Task, record
  closure, or raw transport.
- **DR-019 (Must):** Calling an attachment-handle method must enqueue a command
  and await a one-shot reply. It must not execute the record attempt directly
  in the host caller's scope.
- **DR-020 (Must):** The resource must start its command supervisor and workflow
  as child Tasks before or while it provides the attachment handle. Work that
  must survive an individual handle call must remain owned by the attachment
  resource scope.
- **DR-021 (Must):** The attachment protocol must use one buffered Effection
  `Queue` per single-consumer direction, or one equivalent buffered queue with
  closed typed envelopes. A proposal or terminal event produced before the host
  waits must not be lost.
- **DR-022 (Must):** Each command/reply or proposal/resume rendezvous must use a
  distinct `withResolvers()` instance. Resolving or rejecting it more than once
  must not advance the workflow twice.
- **DR-023 (Must):** Internal Operation-to-Operation messages must not use an
  Effection `Signal`. A Signal may appear only in an adapter whose source is a
  synchronous callback outside Effection.
- **DR-024 (Must):** The proof must not use an Effection Channel for the
  attachment command path because that path has one consumer and cannot drop a
  message before subscription.
- **DR-025 (Must):** One authorized record closure must run as one spawned Task
  owned by the attachment resource. It must not be modeled as a resource unless
  a later design introduces a value that must be provided before the attempt
  completes.
- **DR-026 (Must):** Attachment teardown must reject all pending resolvers,
  close its queues, stop the workflow, supervisor, and attempt Tasks, and run
  cleanup without sleep, polling, or a durable proposal against the dead
  attachment.
- **DR-027 (Must):** Attachment disposal must remain distinct from logical
  workflow cancellation. Ordinary scope exit must not append a cancellation
  record.

### Typed attachment protocol

- **DR-028 (Must):** Proposal, authorization, attempt completion, resume, and
  terminal messages must use distinct discriminated types. The proof must not
  use an optional `authorizedOutcome` field to give one message two phases.
- **DR-029 (Must):** The attachment handle must expose one sequential exchange
  Operation or an equivalent typed pair that preserves command/event ordering.
  Concurrent host commands against one pending workflow boundary must fail
  closed.
- **DR-030 (Must):** The record proposal must carry task action position,
  descriptor identity, and retry safety through the existing authority request
  types. The proof must not derive a weaker local identity.
- **DR-031 (Must):** The host coordinator must reserve before it sends an
  authorization command. It must never run the closure from an uncommitted
  reservation result.
- **DR-032 (Must):** After the attempt Task returns an outcome, the host
  coordinator must submit resolution and wait for shell commit. It must then
  perform exact reservation replay and receive the committed outcome and
  receipt before it sends the resume command.
- **DR-033 (Must):** A rejected resolution, failed reservation commit, stale
  capability, or stored CAS exhaustion must not resolve the workflow effect as
  successful.
- **DR-034 (Must):** Exact replay of a settled record must skip authorization
  and must not start the closure, attempt Task, or closure middleware.

### Authority guarantees and semantic fold

- **DR-035 (Must):** The proof must retain the current program and resolution
  capability checks, full descriptor digest, result schema validation, outcome
  bounds, audience checks, pull identity, attempt identity, and public result
  semantics.
- **DR-036 (Must):** The live happy path must commit `PullRequested` and
  `AttemptStarted` before the closure starts, and must commit `PullResolved`
  before the workflow resumes.
- **DR-037 (Must):** The unsafe ambiguity scenario must execute or produce an
  unsafe attempt outcome, lose the settlement path before authority acceptance,
  detach the attempt, and prove the retained indeterminate behavior. The
  produced but unaccepted outcome must never replay.
- **DR-038 (Must):** The proof must fold the record path from accepted
  `TaskOpened`, `PullRequested`, `AttemptStarted`, `AttemptDetached`,
  `PullIndeterminate`, `AttemptAbandoned`, `PullResolved`, and `TaskClosed`
  records as applicable. If the selected current path emits
  `AttemptOutcomeUnknown`, the fold must handle it too.
- **DR-039 (Must):** The semantic fold must be pure, deterministic, and based
  only on journal records. It must reject offset gaps, conflicting task or pull
  identity, invalid attempt transitions, duplicate settlement, and premature
  task closure.
- **DR-040 (Must):** The folded index must contain task lifecycle, action and
  pull positions, attempt lifecycle, settlement outcome, settlement digest,
  receipt position, and terminal task outcome needed for record replay
  diagnostics.
- **DR-041 (Must):** The folded index must not contain capabilities, nonces,
  leases, restore values, attachment identifiers, signing material, or live
  runtime objects.
- **DR-042 (Must):** After each accepted transition, the proof must compare the
  folded semantic index with the corresponding public authority query and
  journal projection. Deployment-specific storage metadata may be normalized;
  semantic identity, positions, outcomes, and terminal state may not.
- **DR-043 (Must):** A forced stored CAS conflict must discard the failed
  evaluation and rerun reservation or resolution through the current complete
  decision path. Only committed entries may enter the fold or resume the
  workflow.

### Verification and decision gate

- **DR-044 (Must):** Compile-time tests must prove that a valid Workflow,
  `record()`, and `ephemeral()` compile; direct `yield*` of a plain Operation
  from a Workflow fails; and a plain Operation cannot be passed as a Workflow
  child without explicit adaptation.
- **DR-045 (Must):** Resource and effect-evaluation tests must prove that
  `provide()` returns the handle to the caller while the resource-owned
  workflow and supervisor remain active; resource Context is inherited only by
  resource children; each durable or ephemeral Effect evaluation receives a
  new child Task scope through `Scope.run()`; and caller scope exit finalizes
  every owned Task.
- **DR-046 (Must):** Runtime scenarios must cover immediate proposal before host
  wait, successful record execution, accepted error, accepted cancellation,
  settled replay, closure suppression on replay, attachment disposal, wrong or
  duplicate command, and missing effect-runtime Context.
- **DR-047 (Must):** Authority scenarios must run in memory and stored modes and
  cover failed reservation commit, CAS retry, unsafe indeterminate detachment,
  failed resolution, accepted resolution, and crash after settlement before
  resume.
- **DR-048 (Must):** Scenarios must synchronize with named queue, command,
  commit, attempt, and resume barriers. They must not use sleeps, polling,
  manual reducer cranks, or incidental call counts as synchronization.
- **DR-049 (Must):** Teardown must fail the test if any queue remains open, any
  resolver remains pending, any Task or resource remains active, or any store
  operation remains unanswered.
- **DR-050 (Must):** The proof is successful only if the Workflow type boundary,
  attachment-resource ownership, authority ordering, unsafe ambiguity behavior,
  and semantic fold all pass without weakening current identity or trust
  boundaries.
- **DR-051 (Must):** The proof must be judged unsuccessful if it requires a raw
  authority driver in the workflow scope, capability material in the journal,
  a foreign captured Scope in the host, a second production command stack, or
  special behavior in Effection's reducer.
- **DR-052 (Should):** The proof should leave a concise migration map for a
  future design that names which current `program-authoring.ts`,
  `local-program-driver.ts`, `program-driver-contract.ts`,
  `program-runtime.ts`, and `journal-program-runtime.ts` responsibilities would
  move, remain, or disappear.

## Proposed Type and Ownership Model

### Workflow types

```ts
type DurableProgramEffect<T> = Effect<T> & {
  readonly proposal: SerializableProgramProposal;
};

type Workflow<T> = Generator<DurableProgramEffect<unknown>, T, unknown>;
```

The proof uses the Effect contract exported by the pinned Effection package. It
does not invent a narrower `CoroutineView`, import a private Coroutine
implementation, or treat a raw coroutine scope as the effect's execution
scope. The effect factory uses the scope Effection supplies during evaluation
only to call `Scope.run()`. That public operation starts the runtime work as a
new child Task with normal Context inheritance and structured teardown.

### Runtime-only record effect

```ts
interface RecordWorkflowProposal<T extends Json> {
  readonly serializable: {
    readonly type: "operation";
    readonly descriptor: RecordedOperationDescriptor;
  };
  readonly execute: (attempt: RecordAttemptContext) => Operation<T>;
}

function record<T extends Json>(
  options: RecordOptions,
  execute: (attempt: RecordAttemptContext) => Operation<T>,
): Workflow<T>;

function ephemeral<T>(operation: Operation<T>): Workflow<T>;
```

Only `serializable` may enter an attachment event or transport. `execute`
remains in the attachment resource.

### Attachment resource

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
  | { readonly type: "completed"; readonly actionIndex: number; readonly value: Json }
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
): Operation<ProofProgramAttachmentHandle>; // implemented with resource()
```

The attachment resource owns the protocol queues and pending-boundary state.
`exchange()` adds a command and awaits a reply; it does not execute closure work
in the host scope.

### Resource-owned topology

```text
Activation scope
├─ attachment resource task scope
│  ├─ command-supervisor task
│  │  └─ record-attempt task while authorized
│  └─ workflow task
│     └─ effect-evaluation child task while one effect is entered
└─ bounded authority command operations
```

The resource task sets the proof effect-runtime Context before spawning its
children. The host receives only `ProofProgramAttachmentHandle` from
`provide()`.

### Semantic record index

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
    | { readonly status: "closed"; readonly outcome: OperationOutcome; readonly offset: string };
}

interface RecordActionIndex {
  readonly actionIndex: number;
  readonly pullIndex: number;
  readonly pullId: string;
  readonly descriptor: RecordedOperationDescriptor;
  readonly attempts: readonly {
    readonly attemptId: string;
    readonly attemptIndex: number;
    readonly status: "started" | "detached" | "abandoned" | "completed" | "indeterminate";
  }[];
  readonly settlement?: {
    readonly outcome: OperationOutcome;
    readonly outcomeDigest: string;
    readonly resolutionOffset: string;
  };
}
```

This is semantic data only. Private authorization remains in the real authority
state and is observed only through permitted command/query results.

## Call Stacks

### Attachment acquisition

```text
Activation operation
  -> yield* openProofProgramAttachment()
     -> Effection resource creates a child resource task
     -> resource task creates queues and pending-boundary storage
     -> resource task sets proof effect-runtime Context
     -> resource task spawns workflow and command supervisor
     -> resource task calls provide(handle) and suspends
  <- caller receives handle and continues in Activation scope
```

The Context set inside the resource is visible to the workflow and supervisor
children. It is not visible to the Activation caller.

### Live record success

```text
workflow task
  -> record() yields DurableProgramEffect
  -> Effection enters the effect with the workflow coroutine
  -> effect factory calls the supplied scope's Scope.run()
  -> Effection creates an effect-evaluation child Task and inherited Context
  -> child Operation resolves proof runtime with Context.expect()
  -> runtime publishes record-proposed to buffered resource queue
  -> effect waits on its ProgramResume resolver

host activation
  -> attachment.exchange(start)
  <- record-proposed
  -> JournalAuthorityPort.command(execution.reserve-pull)
     -> shell decides
     -> shell commits PullRequested + AttemptStarted
  <- authorized pull and attempt
  -> attachment.exchange(authorize-record)
     -> resource command supervisor spawns record-attempt Task
     -> attempt Task runs closure with RecordAttemptContext
  <- record-attempt-completed
  -> JournalAuthorityPort.command(execution.resolve-pull)
     -> shell verifies capability and outcome
     -> shell commits PullResolved
  <- accepted receipt
  -> JournalAuthorityPort.command(execution.reserve-pull)
  <- resolved committed outcome and receipt
  -> attachment.exchange(resume-record)
     -> resource resolves the pending workflow effect
     -> Effection reducer resumes the generator
  <- next record proposal or terminal event
```

### Settled replay

```text
fresh attachment resource and workflow task
  -> workflow reaches the same record effect
  -> host receives record-proposed
  -> reserve returns resolved
  -> host does not send authorize-record
  -> no attempt Task starts
  -> host sends resume-record with committed outcome and receipt
  -> workflow continues
```

### Unsafe indeterminate attempt

```text
reserve commits intent and attempt
  -> attachment executes unsafe closure or produces its outcome
  -> settlement path is lost before authority accepts outcome
  -> attachment is disposed or replaced
  -> authority detaches unresolved attempt
  -> authority records indeterminate/abandoned evidence
  -> authority settles retained effect_outcome_indeterminate behavior
  -> produced but unaccepted outcome is discarded
  -> later replay returns only the authority-accepted disposition
```

### Resource teardown

```text
Activation scope ends
  -> Effection interrupts attachment resource task
  -> resource rejects pending command and resume resolvers
  -> queues close
  -> supervisor, workflow, and attempt child Tasks stop
  -> ordinary cleanup runs
  -> no logical cancellation entry is fabricated
```

## Design Decisions

### Decision 1: Build a quarantined proof before revising the production model

- **Context:** The current runtime already implements the earlier approved
  Effection-native design. That design chose unrestricted `Operation<T>`
  authoring. `Workflow<T>` reverses a deliberate choice and the authority
  refactor is still a large working-tree change.
- **Options considered:**
  1. Change production types and drivers directly. This tests the idea against
     real code but risks another broad cutover before its value is known.
  2. Reject Workflow typing because the current runtime supports ordinary
     Operations. This avoids churn but does not test the compiler-enforced
     boundary that motivated the comparison.
  3. Build one package-owned, test-only record proof over real authority ports.
- **Choice:** Option 3.
- **Rationale:** The proof tests the disputed design without creating two
  production runtimes. A later cutover remains an explicit reviewed decision.

### Decision 2: Test `Workflow<T>` rather than rename `Operation<T>`

- **Context:** A type alias that still accepts every Operation would not prove
  the durable-yield constraint.
- **Options considered:**
  1. Keep unrestricted Operation authoring.
  2. Add a nominal marker to existing program factories without changing yield
     types.
  3. Constrain the generator yield type to `DurableProgramEffect` and require
     `ephemeral()` for ordinary work.
- **Choice:** Option 3 in the proof.
- **Rationale:** This is the compile-time property under evaluation. The proof
  must expose its real authoring cost instead of hiding ordinary work behind an
  unchanged type.

### Decision 3: Keep `ephemeral()` explicit

- **Context:** Ordinary Effection work is useful but is not authority-backed and
  reruns during reconstruction.
- **Options considered:**
  1. Reject all ordinary Operations.
  2. Auto-lift every Operation into Workflow, which erases the distinction.
  3. Require an explicit transparent wrapper.
- **Choice:** Option 3.
- **Rationale:** The wrapper makes rerun behavior visible and auditable. Tests
  measure whether that explicitness is useful or too costly in Sweatpants
  programs.

### Decision 4: Make the attachment, not the pull provider, the resource

- **Context:** In Effection, a resource provides a value to its caller while its
  resource task and children remain alive until the caller's scope ends. A
  record attempt only returns one terminal outcome.
- **Options considered:**
  1. Treat a pull provider and each attempt as resources.
  2. Keep manual attach/shutdown with opaque handles.
  3. Use one attachment resource that provides a host handle and owns workflow,
     supervisor, queues, resolvers, and attempt Tasks.
- **Choice:** Option 3.
- **Rationale:** The lifetime matches Effection's resource contract. Attempts
  remain ordinary child Tasks.

### Decision 5: Let Effection create effect-evaluation scopes and inherit Context

- **Context:** Context values set in a resource task are inherited by that
  task's children, not by its parent caller. Entering an Effect does not justify
  inventing a partial coroutine type or treating a captured scope as a new
  execution scope.
- **Options considered:**
  1. Set the effect runtime Context inside the resource and assume the host sees
     it.
  2. Read the coroutine scope directly through a proof-owned `CoroutineView`
     and run runtime logic in that scope.
  3. Set the Context in the attachment resource, spawn the workflow beneath it,
     and have each Effect factory call `Scope.run()` so Effection creates a
     child Task scope that inherits the Context.
- **Choice:** Option 3.
- **Rationale:** The workflow and each effect evaluation receive normal
  Effection ownership and Context inheritance. The host does not receive the
  internal Context, and the proof does not invent a scope abstraction that
  Effection already supplies.

### Decision 6: Queue resource-owned work instead of running it through handle methods

- **Context:** A method on a provided object executes in the method caller's
  scope unless it explicitly hands work back to its owner.
- **Options considered:**
  1. Execute attempts directly in `attachment.exchange()`.
  2. Capture the resource Scope and call it from every handle method.
  3. Have handle methods enqueue commands; a resource-owned supervisor executes
     them and settles one-shot replies.
- **Choice:** Option 3.
- **Rationale:** Ownership remains visible and testable. The host does not hold
  a foreign Scope handle.

### Decision 7: Use Queue and `withResolvers`, not Signal or Channel

- **Context:** The attachment protocol is buffered, sequential, and
  single-consumer. Effection Signals are for synchronous callbacks outside an
  Operation. Channels are unbuffered broadcasts and may drop messages before a
  subscriber exists.
- **Options considered:** Signal, Channel, or Queue plus one-shot resolver.
- **Choice:** Queue plus `withResolvers()`.
- **Rationale:** It matches the cardinality, buffering, and request/reply shape.

### Decision 8: Keep the authority protocol stronger than outcome journaling

- **Context:** A record closure can mutate an external system before its outcome
  reaches durable storage.
- **Options considered:**
  1. Execute then append one outcome event, as the default durable-streams path
     does.
  2. Commit intent and attempt, execute, then commit settlement.
- **Choice:** Option 2.
- **Rationale:** It preserves retry safety, attempt fencing, and the unsafe
  indeterminate path.

### Decision 9: Keep exact descriptor and capability identity

- **Context:** Record proposals and settlements cross process and trust
  boundaries. `{ type, name }` cannot detect changed input or contract data.
- **Options considered:** weak positional identity, full current identity, or a
  new proof-only identity.
- **Choice:** Reuse full current identity.
- **Rationale:** The proof tests composition, not weaker correctness.

### Decision 10: Fold semantic records as evidence, not as a production state path

- **Context:** The target architecture derives semantic state from accepted
  entries, but landing record-only evolution would create a mixed authority.
- **Options considered:**
  1. Change the production record handler only.
  2. Omit journal evolution from the proof.
  3. Build a pure test-only fold over records emitted by the real authority and
     compare it with public observations.
- **Choice:** Option 3.
- **Rationale:** It proves whether current records contain enough semantic
  information without creating a second production state model.

### Decision 11: Include unsafe ambiguity in the vertical path

- **Context:** A repeatable success path would not exercise the main guarantee
  that distinguishes Sweatpants from outcome-only journaling.
- **Options considered:** happy path only, repeatable detach only, or unsafe
  produced-but-unaccepted outcome.
- **Choice:** Include all three, with unsafe ambiguity required for success.
- **Rationale:** The proof must preserve the hard guarantee, not only the easy
  replay case.

### Decision 12: Use current memory and stored shells

- **Context:** The architecture claims one decision semantics across local and
  CAS-backed deployment.
- **Options considered:** a proof-owned fake authority, memory only, or both
  real shell compositions.
- **Choice:** Both real shell compositions, with the current controllable store
  binding for deterministic contention.
- **Rationale:** A fake command result would bypass the property under test.

### Decision 13: Defer remote-driver and complete cutover work

- **Context:** Worker and AgentCore drivers add transport and detached-scope
  concerns. The first question is whether the local resource/Workflow model
  earns its cost while preserving authority semantics.
- **Options considered:** migrate all drivers in the proof or prove local
  semantics and provide a migration map.
- **Choice:** Prove local semantics and map remote changes.
- **Rationale:** Remote migration is production work. The proof still uses the
  serializable command/event shape needed by those drivers.

## Constraints

- Work occurs in the existing dirty `sweatpants` worktree. Implementation must
  not reset, discard, or overwrite unrelated user changes.
- Sweatpants pins `effection@4.1.0-alpha.9` and TypeScript `5.9.3` in
  `sweatpants/pnpm-workspace.yaml`. The proof must use those versions.
- `resource()` creates a child task owned by the caller scope. `provide()`
  resolves the resource Operation and suspends the resource task until the
  caller scope ends. The design must not assume upward Context inheritance.
- A provided handle's methods run in their caller's scope unless they enqueue
  work to a resource-owned task or use another explicit ownership mechanism.
- `createSignal()` is not an internal Operation-to-Operation message bus.
- The proof may use current test-only shell constructors and controlled store
  bindings, but workflow code must resolve only the scoped public authority
  facade.
- The semantic journal remains append-only. The proof may not alter or rewrite
  an accepted record.
- The current capability keyring, schema registry, canonical JSON, size bounds,
  and error taxonomy remain authoritative.
- Stored CAS retries may evaluate a command more than once. Failed-evaluation
  entries, capabilities, outcomes, and receipts are not observable proof input.
- Test synchronization uses causal operations and pending handles, not time.
- The proof adds no package and creates no dependency cycle.

## Dependencies

### Internal dependencies

- `packages/durable-execution/src/program-authoring.ts` defines the current
  unrestricted `DurableProgramFactory`, `DurableProgramContext`, record closure,
  and proposal types. **Risk: high** because the proof deliberately tests an
  alternative type boundary.
- `packages/durable-execution/src/program-context.ts` implements the current
  `DurableProposalExecutor` bridge and nested-record guard. **Risk: high**
  because a future cutover would replace part of this bridge.
- `packages/durable-execution/src/local-program-driver.ts` owns the current
  attachment scope, buffered queue, resolvers, manual `attach/step/shutdown`
  facade, and record execution. **Risk: high** and the main comparison target.
- `packages/durable-execution/src/program-driver-contract.ts` defines current
  `ProgramCommand`, optional `authorizedOutcome`, `ProgramStep`, attachment,
  restore, and shutdown contracts. **Risk: high** for a later cutover; unchanged
  by this proof.
- `packages/durable-execution/src/program-runtime.ts` defines `ProgramPeer` and
  driver registry dispatch. **Risk: medium** because a future resource-shaped
  `open()` must preserve scoped driver composition.
- `packages/journal-authority/src/journal-program-runtime.ts` contains the
  current reserve/authorize/resolve/confirm loop. **Risk: high** and the host
  coordinator baseline.
- `packages/journal-authority/src/authority-decisions.ts` and
  `decision-pipeline.ts` provide current capability, descriptor, state, and
  semantic proposal behavior. **Risk: high**, but the proof calls them through
  public ports rather than forking them.
- `packages/journal-authority/src/in-memory-shell.ts` and `stored-shell.ts`
  provide the two real shell modes. **Risk: medium**.
- `packages/journal-authority/src/execution-forest.ts` is an existing pure
  semantic projection and a precedent for the proof fold. **Risk: low**.
- `packages/journal-authority/src/testing/` owns current cross-shell conformance
  support and is the selected quarantine boundary. **Risk: medium** because the
  proof must not leak into production exports.
- `packages/tool-runtime-local/src/local-worker-durable-driver.ts` and
  `packages/tool-runtime-agentcore/src/durable-driver.ts` are later migration
  targets for resource-shaped attachment transports. **Risk: medium-high**;
  they are not changed by the proof.

### External dependencies

- `effection@4.1.0-alpha.9`, pinned in `sweatpants/pnpm-workspace.yaml`, supplies
  Effect structural contracts, scopes, Tasks, `resource`, Context, Queue,
  `withResolvers`, `spawn`, `action`, Signal, and Channel. **Risk: medium**
  because the version is alpha and resource semantics are load-bearing.
- TypeScript `5.9.3` supplies generator yield-type checking and structural
  assignability. **Risk: medium** until the compile-time proof passes.
- Vitest `3.0.5` runs type-adjacent, pure fold, resource-lifetime, and
  integration scenarios. **Risk: low**.

## Open Questions

None. This design authorizes a quarantined record-path proof only. The proof
uses constrained Workflow typing, explicit `ephemeral()`, an attachment
resource, resource-owned queues/supervisor/attempt Tasks, real authority ports,
intent-before-execution, unsafe ambiguity, and a test-only semantic fold. It
does not authorize a production cutover.

## Research Notes

### Existing Effection-native design

- `.pi/specs/effection-native-durable-programs-design.md` chose unrestricted
  `Operation<Result>` authoring in DR-001 and arbitrary ordinary Effection
  composition in DR-003. It made explicit durable context Operations the only
  journal-visible boundaries in DR-011.
- `.pi/specs/effection-native-durable-programs-spec.md` carries that choice into
  REQ-001 and REQ-003. The new proof tests a different compile-time boundary and
  therefore must not claim to be a minor implementation of that specification.
- The existing design already established important semantics retained here:
  ordinary work may rerun, accepted record outcomes do not rerun, attachment
  disposal differs from logical cancellation, and unsafe attempts use explicit
  retry policy.

### Current Sweatpants implementation

- `packages/durable-execution/src/program-authoring.ts` defines
  `DurableProgramFactory` as returning `Operation<O>`. `DurableProgramContext`
  methods also return Operations.
- `packages/durable-execution/src/program-context.ts` implements
  `createDurableProgramContext(executeProposal)`. `record()` publishes a
  `ProgramStepProposal` with a runtime-only closure and prevents nested durable
  scheduling with a `recording` guard.
- `packages/durable-execution/src/local-program-driver.ts` creates an attachment
  scope, starts the program as a scope-owned task, buffers frontiers in an
  Effection Queue, and suspends each proposal with `withResolvers()`.
- `packages/durable-execution/src/program-driver-contract.ts` separates
  `ProgramCommand` and `ProgramStep` but places an optional
  `authorizedOutcome` on an operation step after authorization. The proof tests
  distinct event types for these phases.
- `packages/journal-authority/src/journal-program-runtime.ts` performs reserve,
  authorization, resolution, exact replay confirmation, and resume. The record
  branch is the behavioral baseline.
- `packages/journal-authority/src/semantic-record.ts` defines the accepted
  record vocabulary used by the fold.
- `packages/journal-authority/src/execution-forest.ts` already proves that task,
  action, pull, attempt, settlement, and child topology can be projected from
  semantic records without private capabilities.

### Effection semantics verified from the pinned package

- `sweatpants/node_modules/effection/esm/lib/resource.d.ts` states that a
  resource passes a value to its caller while the resource Operation continues
  in the background. `provide()` suspends the resource until the caller passes
  out of scope.
- `sweatpants/node_modules/effection/esm/lib/resource.js` implements that rule by
  creating a prioritized child task owned by the caller scope, resolving a
  `withResolvers()` gate from `provide(value)`, and then suspending the resource
  task.
- `sweatpants/node_modules/effection/esm/lib/types.d.ts` states that Context
  values inherit from parent scopes to children and that `Context.set()` affects
  the current scope, not its parent.
- The same file states that `Scope.run()` starts a Task in the explicit Scope.
  A provided object's methods do not inherit the resource task scope merely by
  closing over its values.
- `sweatpants/node_modules/effection/esm/lib/queue.d.ts` defines Queue as a
  buffered single subscription with synchronous `add()`.
- `sweatpants/node_modules/effection/esm/lib/channel.d.ts` defines Channel as an
  unbuffered broadcast and notes that messages sent without subscribers are
  dropped.
- `sweatpants/node_modules/effection/esm/lib/signal.d.ts` says Signal adapts
  callbacks outside Operations and warns not to use it for messages sent from
  within Operations.
- `sweatpants/node_modules/effection/esm/lib/action.d.ts` defines `action()` as a
  callback adapter whose executor returns mandatory cleanup.

### Executable.md comparison

- `executable.md/packages/durable-streams/types.ts` defines
  `Workflow<T> = Generator<DurableEffect<unknown>, T, unknown>` and relies on
  structural compatibility with Effection Effect.
- `executable.md/packages/durable-streams/effect.ts` performs replay/live dispatch
  in `DurableEffect.enter()` without changing Effection's reducer.
- `executable.md/packages/durable-streams/ephemeral.ts` wraps ordinary Operations
  as journal-transparent durable effects that rerun on replay.
- `executable.md/packages/durable-streams/run.ts` derives a replay index from
  retained journal events. Its default effect path appends outcome after
  execution, which is intentionally not copied here.
- `executable.md/packages/durable-streams/live-coordinator.ts` adds
  operation-specific execute/publication coordination. This supports the split
  used here: Effection owns effect execution while Sweatpants Journal Authority
  retains the stronger reserve/attempt/settle protocol.

### Why this is a proof instead of a cutover

- The earlier Effection-native migration already replaced proposal-only manual
  generator execution with ordinary Effection Operations and a buffered
  proposal bridge. The current question is not whether Sweatpants can run
  Effection programs; it can.
- The disputed value is whether compile-time Workflow restriction, explicit
  `ephemeral()`, resource-shaped attachment acquisition, and journal-derived
  semantic state produce a simpler and safer whole.
- A record-only production migration would leave two semantic state models and
  two authoring contracts. The quarantine lets tests answer the disputed points
  without making that state permanent.
