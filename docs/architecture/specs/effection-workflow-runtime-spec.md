# Normative Specification: Production Effection Workflow Runtime

## Status
Implemented — final cutover conformance passed; migration-window clauses are historical constraints, not surviving dual-runtime behavior.

## Abstract

This specification defines the sole production Effection workflow runtime promoted from the approved record-vertical proof (`.pi/specs/authority-backed-effection-workflow-spec.md`). It fixes constrained workflow authoring with explicit ephemeral work; required generic pulls with manifest-pinned contracts; resource-owned local and remote attachments; Authority-owned replay, child topology, preparation, cancellation, and settlement; host/execution placement; and physical deletion of all superseded runtime paths.

## 1. Introduction

### 1.1 Purpose

The record vertical proved that authority-backed durable programs can run as
Effection-native workflows with resource-owned attachments, port-composed
attempt policy, and journal-folded semantic state. This specification turns
that proof into binding requirements for the production runtime, its consumer
cutover, and the deletion of the paths it replaces.

### 1.2 Scope

Covered: runtime packaging, authoring surface, attachment topology, attempt
coordination, boundary validation, replay and restore, consumer cutover,
deletion.

Not covered: parallel composition combinators (`all`, `race`, `spawn`, `join`)
beyond fail-closed rejection; changes to the journal authority decision core,
capability model, or storage formats; authoring-model details governed by
`.pi/specs/effection-native-durable-programs-design.md`.

### 1.3 Terminology

- **MUST**: Absolute requirement (RFC 2119)
- **MUST NOT**: Absolute prohibition (RFC 2119)
- **SHOULD**: Recommended but not required (RFC 2119)
- **SHOULD NOT**: Not recommended but not prohibited (RFC 2119)
- **MAY**: Optional (RFC 2119)
- **Attachment**: The resource-owned coordinator between a running workflow and the authority.
- **Boundary kind**: One descriptor kind of `DurableOperationDescriptor` or `EmissionDescriptor`.
- **Sequential kinds**: `effect`, `record`, `elicit`, `wait`, `invoke`, `sample`, `foreign`.

### 1.4 Final Cutover Amendments

#### REQ-024: Single production runtime
Production durable execution **MUST** use the workflow runtime exclusively. No runtime selector, superseded runtime service, installer, or alternate local drive loop **MAY** remain in source, tests, exports, or generated package declarations.

#### REQ-025: One interaction primitive and typed pull contracts
`DurableProgramContext` **MUST** require exactly one interaction member, `pull(descriptor)`. Kind-specific ergonomics **MUST** remain in authoring helpers. A program that authors a typed pull kind **MUST** pin its input and output descriptors in `DurableProgramManifest.pulls`, and Authority **MUST** validate both request and settlement through those descriptors.

#### REQ-026: Explicit remote evaluator activation
Worker, Lambda, and AgentCore evaluators **MUST** implement `ProgramDriver` through the workflow attachment runtime. `driveProgramDriverActivation` **MUST** drive exactly one evaluator attachment; `driveWorkflowTree` **MUST** remain the sole owner of child allocation and recursion. Remote attachment resources **MUST** close explicitly and **MAY** use detached ownership only when their transport outlives one command operation.

#### REQ-027: Verbatim journal input and explicit staging
`PullRequested.descriptor` **MUST** equal the descriptor proposed at the Authority boundary. Model-context storage or another composition step **MUST** complete before that boundary. Runtime dispatch and resolution **MUST NOT** enrich or rewrite the journaled descriptor.

#### REQ-028: Pull-owned sampling lifecycle
Model sampling **MUST** use the `sample` pull kind. Its attachment-epoch owner fence **MUST** gate preparation, authorization, partial acceptance, cancellation, settlement, and post-settlement acknowledgement. Host and execution placement **MUST** retain identical journal semantics.

## 2. Functional Requirements

### 2.1 Packaging and Export

#### REQ-001: Runtime location and entry
The runtime MUST live under `packages/journal-authority/src/workflow/` and MUST
export its public surface through the existing production entry of
`@sweatpants/journal-authority`.

**Source**: DR-001

**Rationale**: Same-package placement avoids new packaging plumbing and keeps
canonical helpers reachable; entry-level export keeps consumer imports stable.

**Acceptance Criteria**:
- [ ] All runtime sources reside under `src/workflow/`.
- [ ] No runtime symbol is exported from any other package path.
- [ ] `pnpm validate:exports` passes after each phase.

#### REQ-002: Export stability during migration
Existing exports of `@sweatpants/journal-authority` MUST remain present and
type-compatible through phases 1–3. Removal of superseded exports MAY occur
only in phase 4.

**Source**: DR-002

**Rationale**: Consumers flip by scope composition during migration; breaking
exports mid-window would force simultaneous edits everywhere.

**Acceptance Criteria**:
- [ ] Package type-check against a frozen snapshot of current public types succeeds in phases 1–3.
- [ ] Phase-4 diff enumerates every removed export.

#### REQ-003: Promotion renames
Promoted symbols MUST drop testing-era qualifiers: `ProofProgram*` names become
`Program*`, and no promoted export name MAY contain `Proof` or reference
`testing`.

**Rationale**: Production names must not carry quarantine vocabulary.

**Acceptance Criteria**:
- [ ] No exported runtime symbol matches `/Proof|Testing/iu`.

### 2.2 Workflow Authoring Surface

#### REQ-004: Constrained workflow typing
Workflow bodies MUST be generators typed `Workflow<T>` whose direct child
effects are durable boundaries. Ordinary Operations MUST be wrapped by
`ephemeral()` to appear as children. A plain Operation yielded directly as a
workflow child MUST be a compile-time type error, pinned by a checked negative
fixture using `@ts-expect-error`.

**Source**: DR-004

**Rationale**: The constrained type makes every durable crossing visible at the
authored call site, matching `.pi/specs/effection-native-durable-programs-design.md`.

**Acceptance Criteria**:
- [ ] Direct plain-Operation child fails compilation (negative fixture compiles only with `@ts-expect-error`).
- [ ] `ephemeral(op)` composes and reruns per invocation, invisible to the journal fold.

#### REQ-005: Boundary kind coverage
The runtime MUST support exactly these pull descriptor kinds via one
generalized boundary mechanism with a per-kind adapter table:
`EffectDescriptor`, `RecordedOperationDescriptor`, `DurableElicitDescriptor`,
`WaitDescriptor`, `DurableInvokeDescriptor`; plus `EmissionDescriptor` as a
non-pull action. Receipt of `DurableAllDescriptor`, `DurableRaceDescriptor`,
`DurableSpawnDescriptor`, or `DurableJoinDescriptor` MUST fail closed with a
protocol error before any live execution or journal write.

**Source**: DR-005

**Rationale**: The kind list is the literal union at
`durable-execution/src/program-contract.ts:174-184`; parallel combinators are
deferred by design Non-Goals and must never half-execute.

**Acceptance Criteria**:
- [ ] Each supported kind completes propose → authorize → settle → resume against memory and stored shells.
- [ ] Each combinator kind rejects with `program_protocol_error` and writes no journal entries.

#### REQ-006: Retry-safety fidelity
Every boundary kind MUST enforce retry-safety semantics identical to current
behavior: `repeatable` re-executes on restore; `unsafe` yields the authority
indeterminate result on lost settlement; `idempotent` mechanisms deduplicate by
their declared key.

**Source**: DR-006

**Rationale**: These semantics are settled kernel behavior; the runtime must
preserve them bit-for-bit.

**Acceptance Criteria**:
- [ ] Unsafe lost-settlement scenario produces the indeterminate outcome in both shells.
- [ ] Idempotent duplicate settlement is suppressed and journaled as duplicate, not accepted twice.

#### REQ-007: Settlement validation
Boundary values MUST pass canonical-value validation and inline-size checks at
settlement; failures map to existing codes (`record_value_invalid`,
`record_value_too_large`, and per-kind peers).

**Source**: DR-007

**Rationale**: Proved settlement guards must not weaken during generalization.

**Acceptance Criteria**:
- [ ] Non-canonical values reject with the mapped code before publication.
- [ ] Oversized inline values reject with the mapped code including cause chaining.

### 2.3 Attachment Ownership Topology

#### REQ-008: Single owning resource
A running program MUST own exactly one attachment resource that owns the command
supervisor task, event queue, tracked resolvers, dispose gate, and attempt
tasks. The public handle MUST expose only `exchange()`, `setDisposition()`, and idempotent `close()`.

**Source**: DR-008

**Rationale**: Bounded handles keep authority capabilities out of caller reach,
as proven by the vertical's `Reflect.ownKeys(handle)` check.

**Acceptance Criteria**:
- [ ] Handle own-keys equal the declared operation set.
- [ ] Scope disposal cancels in-flight attempts and runs cleanup exactly once.

#### REQ-009: Concurrent exchange fencing
Concurrent `exchange()` calls MUST fail closed: the second caller receives
`program_protocol_error`, the attachment closes, and the resource-owned attempt
MUST cancel with cleanup observed.

**Source**: DR-009

**Rationale**: Preserves the single-writer invariant the proof enforces today.

**Acceptance Criteria**:
- [ ] Deterministic concurrent-exchange scenario yields the protocol error on the second call and cancellation of the held attempt.

#### REQ-010: Journal-derived semantic state
Semantic progress MUST derive by folding accepted journal entries. Capabilities,
nonces, leases, restore bookkeeping, and live Effection values MUST NOT appear
in messages or folds.

**Source**: DR-010

**Rationale**: Kernel DR-025 consistency posture; keeps the fold authoritative.

**Acceptance Criteria**:
- [ ] Strict fold comparison against `projectExecutionForest()` passes for every conformance scenario, live and restored.

### 2.4 Attempt Coordination Boundary

#### REQ-011: Fail-closed coordination port
Live attempts MUST dispatch through a `definePort` boundary whose declaration
core throws when uninstalled. Each attachment MUST install its ordinary-path
driver at `min` inside its own scope.

**Source**: DR-011

**Rationale**: Follows the `JournalAuthorityPort` model proven by the vertical's
`RecordAttemptPort`.

**Acceptance Criteria**:
- [ ] Dispatch without an installed driver rejects before executing fenced work.
- [ ] Two parallel attachments install independent drivers without collision.

#### REQ-012: Middleware placement conformance
Host middleware MUST compose at `max` around the installed driver regardless of
installation order. Tests MUST pin ordering across scopes: outer host layer,
inner descendant layer, driver innermost.

**Source**: DR-012

**Rationale**: Matches Effection `createApi` semantics demonstrated in
`api-internal.js` and pinned by the vertical's ordering test.

**Acceptance Criteria**:
- [ ] Observed order equals `["host", "descendant", "descendant-done", "host-done"]` around a successful attempt.

#### REQ-013: Supervisor-owned cancellation mapping
Cancellation mapping MUST stay outside the coordination boundary. Abort signals
or `DurableProgramCancellation` escaping middleware or driver MUST resolve to a
cancelled outcome after dispatch returns or throws.

**Source**: DR-013

**Rationale**: Middleware must not be able to redefine what cancellation means.

**Acceptance Criteria**:
- [ ] Throwing and aborting drivers both produce `{ status: "cancelled" }` outcomes through max middleware.

### 2.5 Boundary Validation

#### REQ-014: Parser-covered inputs
Authoring options, commands, receipts, descriptors, and disposition reasons
MUST parse through closed Foundation `Parser<T>` schemas at their throwing
boundaries. Manual shape assertions MUST NOT remain on these paths.

**Source**: DR-014

**Rationale**: Replaces repetitive assertions with one declarative schema per
boundary, as adopted in the vertical.

**Acceptance Criteria**:
- [ ] Every listed input type has an exported parser with positive and negative unit cases.
- [ ] Grep finds no residual manual key/type checks on covered paths.

#### REQ-015: Error-code preservation
Parser failures at throwing boundaries MUST raise the established public code
for that boundary (`invalid_descriptor`, `program_protocol_error`, peers) with
the first issue message when available.

**Source**: DR-015

**Rationale**: Public error contracts outlive the refactor.

**Acceptance Criteria**:
- [ ] Existing invalid-input tests pass unchanged after parser adoption.

### 2.6 Replay and Restore

#### REQ-016: Restore procedure
Restoring a session/task MUST (a) rebuild attachment state by folding stored
journal entries through the existing recovery queries —
`authority.recoverable-sessions`, `pull.state`, and the recovery-ticket
operations — then (b) run the workflow fresh while each boundary consults
accepted history for a fencing-verified identity match before any live work.

**Source**: DR-016

**Rationale**: Effection cannot resume a suspended generator; fresh-run replay
against authority-owned history inherits CAS guarantees instead of rebuilding
an engine-private index.

**Acceptance Criteria**:
- [ ] A killed-and-restored program resumes with identical semantic state and no duplicated live execution.
- [ ] Restore path invokes no raw segment reads around the decision pipeline.

#### REQ-017: Match feeds stored outcomes; mismatch is fatal
A boundary whose descriptor identity matches accepted history MUST receive the
stored outcome without live execution. A mismatch MUST fail fatal with a
divergence error before any live execution or journal write.

**Source**: DR-017

**Rationale**: Silent re-execution after divergence would double real-world
side effects; fatal default matches kernel fail-closed posture.

**Acceptance Criteria**:
- [ ] Replay suppression scenario executes each accepted boundary zero times live.
- [ ] Edited-body divergence scenario rejects before side effects.

#### REQ-018: Duplicate settlement parity
Restore-time settlements MUST suppress duplicates exactly as live replay does.

**Source**: DR-019

**Rationale**: One suppression rule, two paths; drift here corrupts history.

**Acceptance Criteria**:
- [ ] Shared suppression fixture passes identically pre-kill and post-restore.

### 2.7 Consumer Cutover

#### REQ-019: Side-by-side driver window
During migration, old and new runtimes MUST both install behind their ports.
Library internals MUST NOT branch on configuration flags to select a runtime;
the selection point MUST be the consumer-facing facade. **Amendment
(post-vertical)**: the ratified mechanism is an explicit `runtime?: "workflow"
| "local"` option on the `tool-runtime-local` facade (default `"local"`) — a
consumer-boundary choice, not internal flag branching. `createWorkflowProgramDriver`
satisfies the full `ProgramDriver` contract so port-scoped installs remain the
underlying mechanism.

**Source**: DR-020

**Rationale**: Ports scope installs naturally; flags would leave permanent
seams for temporary needs.

**Acceptance Criteria**:
- [x] The migration parity suite passed before deletion.
- [x] The runtime selector and old-driver leg were removed after the gate.
- [x] Production has one workflow path; remote placement varies only by `ProgramDriver` route.

#### REQ-020: Consumer access discipline
`durable-chat-runtime` handlers and `tool-runtime-local` /
`tool-runtime-agentcore` facades MUST consume the runtime only through port
facades. Consumers import the journal-authority workflow entry and durable-execution driver contracts; no deleted runtime module is reachable.

**Source**: DR-021

**Rationale**: Facade-only access preserves middleware integrity end-to-end.

**Acceptance Criteria**:
- [x] Import scan shows no consumer reaching runtime internals (`tool-runtime-local` imports only the journal-authority root facade surface: `durableToolWorkflow`, `driveActivation`, `InstalledEffectPort`, `openProgramAttachment`).

#### REQ-021: Parity evidence
Cutover MUST complete with parity evidence over a shared conformance fixture
set: identical public error codes, journal shapes, and forest projections
between runtimes.

**Source**: DR-022

**Rationale**: Behavioral equivalence is the cutover gate, not vibes.

**Acceptance Criteria**:
- [x] The pre-deletion fixture set covered record, effect, emission, elicit, wait, invoke, refusal, and public error semantics.
- [x] Worker, fenced placement, model sampling, foreign-tool continuation, cancellation, and host replacement pass outside-in acceptance.
- [x] The comparison leg was deleted after cutover; workflow regression and platform suites remain.

Foreign tools run through the pinned workflow adapter child so ToolSession sample and elicitation backchannels remain journaled topology rather than resolver transport.

### 2.8 Deletion

#### REQ-022: Retention list
These `durable-execution` modules MUST remain: `checkpoint.ts` (consumed by
`history-store`, `storage-sqlite`, `chat-core`), `program-identity.ts`,
`purity-scan.ts`, `program-contract.ts` (descriptor unions), `program-driver-contract.ts`, `program-values.ts`, `program-execution-context.ts`, and schema/store modules with external consumers.

**Source**: DR-023

**Rationale**: Verified live importers; deletion here would break unrelated
packages.

**Acceptance Criteria**:
- [x] Retained modules compile and pass their post-deletion tests.

#### REQ-023: Deletion targets
The cutover MUST delete `journal-program-runtime.ts`, `program-runtime.ts`, `local-program-driver.ts`, `local-program-host.ts`, the proposal-bridge `program-context.ts`, old runtime-context and installer files, automatic foreign-child factories, runtime selectors, deprecated aliases, and old parity legs. Driver contracts, program authoring/context contracts, execution identity, and the narrow workflow evaluator MUST remain.

**Source**: DR-023

**Rationale**: Closures shift during phases 1–3; the scan, not this document,
is authoritative at deletion.

**Acceptance Criteria**:
- [x] Zero workspace imports of deleted modules; module graph, exports, and product-surface validators pass.

## 3. Non-Functional Requirements

#### NFR-001: Deterministic synchronization
Internal protocol synchronization MUST use causal operations (queues,
resolvers, abort signals). Sleeps, polling, and call-count synchronization MUST
NOT appear in runtime or test code.

#### NFR-002: Static-analysis gates
All new code MUST pass focused `oxfmt --check` and type-aware `oxlint` with
zero warnings, including the repository `no-nested-yield` rule.

#### NFR-003: Quarantine until phase gate
Before phase-1 approval, runtime changes MUST stay inside
`journal-authority/src/testing/` and `src/workflow/`; consumer-facing edits
MUST be called out per file in review.

## 4. Interfaces

### 4.1 Authoring surface
`Workflow<T>`, `ephemeral()`, effect/record/emission mechanisms, and required `DurableProgramContext.pull(descriptor)`. SDK helpers own kind-specific ergonomics (REQ-003, REQ-025).

### 4.2 Attachment handle
`exchange(command): Operation<ProgramEvent>`, `setDisposition(reason)`, and idempotent `close(reason): Operation<void>`; commands/events use the promoted proof protocol
algebra parsed by exported Foundation parsers.

### 4.3 Coordination port
`RecordAttemptPort`-shaped `definePort` per boundary family needing host
policy; contract members return `Operation`s; declaration cores fail closed.

### 4.4 Authority interaction
All pulls, resolutions, recoveries, and emissions flow through existing
`JournalAuthorityPort` command/query operations; the runtime invents no
authority endpoints.

## 5. Error Handling

Public codes preserved verbatim: `invalid_descriptor`,
`program_protocol_error`, `stale_program_capability`, `nested_durable_operation`,
`record_value_invalid`, `record_value_too_large`, `program_cancelled`,
plus per-kind peers. New failure mode: divergence on replay mismatch raises a
fatal error before side effects; code assigned at implementation and added to
the parity fixture set. Parser failures embed the first schema issue message
when available.

## 6. Security Considerations

Capability minting, fencing, audience scoping, and CAS commit semantics are
unchanged and remain in the kernel. The runtime MUST NOT bypass ports to touch
stores or journals directly (REQ-016). Bounded handles prevent callers from
extracting raw resolvers or capabilities (REQ-008).

## 7. Migration / Compatibility

Four phases: (1) promote runtime into `src/workflow/` alongside proof;
(2) generalize boundary kinds and land the crash-resume vertical;
(3) consumer flips over ports with parity fixtures;
(4) delete superseded modules per REQ-022/REQ-023 and remove superseded
exports. Pre-release breakage of pinned artifacts follows
`effection-native-durable-programs-design.md`; no shims.

## References

- Design memo: `.pi/specs/effection-workflow-runtime-design.md`
- Proof evidence: `.pi/evidence/authority-backed-effection-workflow.md`
- Proof spec: `.pi/specs/authority-backed-effection-workflow-spec.md`
- Kernel design / revision memo: `.pi/specs/journal-authority-kernel-design.md`, `.pi/specs/journal-authority-kernel-revision-memo.md`
- Authoring model: `.pi/specs/effection-native-durable-programs-design.md`
- Descriptor union: `durable-execution/src/program-contract.ts:174-184`
- Port machinery: `foundation/src/port.ts`, Effection `4.1.0-alpha.9` `api-internal.js`
