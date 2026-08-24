# Normative Specification: Durable Tool Cancellation and Partial Results

## Status
Draft — amended 2026-08 to make successor-message queueing optional client-local policy.

## Abstract

This specification defines cancellation for ordinary and crank-native durable tools. Ordinary tools receive scope-bound abort signals and use Effection-owned resources for live cleanup. Durable tools use journaled cancellation frontiers, authoritative effect settlement, one-shot typed generator interruption, durable cleanup replay, recursive child cancellation, and a separate force-orphan path. Durable effects may return schema-validated partial results when cancelled. The specification also defines transcript repair, optional client-local post-cancellation messages, and a fluent `createDurableTool` builder aligned with `createTool` inference.

This specification supersedes the blanket cancellation-first rule in `DR-075` of `crank-native-durable-remote-tools-design.md`. The settleable-effect versus non-settleable-pull rules below are authoritative when the documents differ.

## 1. Introduction

### 1.1 Purpose

Cancellation crosses two distinct execution boundaries. An ordinary tool is a live Effection operation whose resources can be cancelled cooperatively. A durable program is reconstructed from an append-only journal and cannot use one process's signal or generator frame as durable state. This specification gives each boundary an honest cancellation contract while preserving committed external facts, useful partial observations, structured cleanup, and valid model history.

### 1.2 Scope

This specification covers:

- ordinary `createTool` invocation cancellation;
- crank-native `createDurableTool` cancellation;
- durable effect settlement and partial cancellation results;
- cancellation/reply races and processless activation;
- structured descendant cancellation;
- hard force-orphan escalation;
- cancelled-turn and tool-result projection;
- the authority boundary for optional client-local post-cancellation message queueing;
- fluent durable-tool authoring.

This specification does not promise rollback of external mutations, preempt arbitrary JavaScript, make detached work implicit, define a general artifact store, or treat transport/process loss as user cancellation.

### 1.3 Normative language

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are interpreted as described by RFC 2119 and RFC 8174 when written in uppercase.

### 1.4 Terminology

- **Cancellation frontier**: The task-local next unconsumed action index recorded when cancellation is accepted, plus the unresolved pull ID at that position when one exists.
- **Settleable effect attempt**: An authorized attempt with either a live handler that can observe cancellation or a reachable durable server-task protocol that can accept cancellation and return a terminal disposition.
- **Non-settleable pending pull**: An unresolved pull with no reachable live or durable settlement path. This includes pending user input, waits, not-yet-started children/effects, detached attempts, and unreachable external resolvers.
- **Cancellation unwind**: Strict replay to the cancellation frontier followed by one typed cancellation injection and execution of authored catch/finally cleanup.
- **Committed fact**: A schema-valid effect result, child result, durable emission, or other semantic record accepted before authority was revoked. Signal delivery alone neither creates nor removes a committed fact.
- **Unknown outcome**: An external action may have executed, but no trustworthy terminal disposition can be accepted. Unknown is not success, failure, or rollback.
- **Graceful cancellation**: Cancellation that settles the frontier, replays pinned code, executes cleanup, closes descendants, and terminates cancelled.
- **Force orphaning**: Administrative termination that revokes authority and records skipped cleanup without claiming graceful cancellation.

## 2. Data and State Model

### 2.1 Ordinary tool context

```ts
interface BaseToolCtx {
  readonly signal: AbortSignal;
  readonly messages: readonly ToolMessage[];
  notify(message: string, progress?: number, level?: LogLevel): Operation<void>;
  log(level: LogLevel, message: string): Operation<void>;
}
```

`signal` is live scope state. It is not a durable value.

### 2.2 Durable effect definition and disposition

`RetrySafety` is inherited unchanged from §3.2 of `replay-crank-driver-spec.md` and remains part of effect semantic identity.

```ts
declare const effectInputType: unique symbol;
declare const effectOutputType: unique symbol;
declare const effectCancellationPartialType: unique symbol;

interface EffectDefinition<I extends Json, O extends Json, P extends Json = never> {
  readonly [effectInputType]?: I;
  readonly [effectOutputType]?: O;
  readonly [effectCancellationPartialType]?: P;
  name: string;
  version: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  cancellation?: {
    partialSchema: JsonSchema;
  };
  retrySafety: RetrySafety;
}

type DurableEffectDisposition<O extends Json, P extends Json = never> =
  | { status: "ok"; value: O }
  | { status: "error"; error: SerializedApplicationError }
  | ([P] extends [never]
      ? { status: "cancelled"; partial?: never }
      : { status: "cancelled"; partial?: P });

type DurableEffectHandler<I extends Json, O extends Json, P extends Json = never> = (
  input: I,
  context: DurableEffectContext,
) => Operation<DurableEffectDisposition<O, P>>;
```

The authority persists the disposition as the pull outcome. A cancelled partial is optional even when declared.

### 2.3 Cancellation records

```ts
interface CancellationFrontier {
  actionIndex: number;
  pullId?: string;
}

interface CancellationRequestedRecord {
  type: "CancellationRequested";
  taskId: string;
  commandId: string;
  reason?: string;
  frontier: CancellationFrontier;
}

interface CancellationPartialDiscardedRecord {
  type: "CancellationPartialDiscarded";
  taskId: string;
  pullId: string;
  reason: "schema_validation_failed" | "payload_too_large";
}

interface AttemptOutcomeUnknownRecord {
  type: "AttemptOutcomeUnknown";
  taskId: string;
  pullId: string;
  attemptId?: string;
  reason: "no_settlement_path" | "force_orphaned";
}
```

`CancellationPartialDiscarded` MUST contain no rejected payload, arbitrary error, schema text, or secret.

### 2.4 Durable cancellation state

```ts
type DurableCancellationState =
  | { type: "none" }
  | { type: "requested"; commandId: string; reason?: string; frontier: CancellationFrontier }
  | { type: "settling_pull"; commandId: string; pullId: string }
  | { type: "cancelling_children"; commandId: string; childTaskIds: readonly string[] }
  | { type: "unwinding"; commandId: string }
  | { type: "cancelled"; commandId: string }
  | { type: "orphaned"; reason: "program_version_unavailable" | "program_corrupt" | "cleanup_stuck" };
```

Only legal transitions defined by REQ-011 in §3.2 are permitted.

### 2.5 Tool-history terminal results

```ts
type CancelledToolResult = {
  status: "cancelled";
  partial?: Json;
};

type InterruptedToolResult = {
  status: "interrupted";
  outcome: "unknown";
  message: string;
};
```

These are model-facing projections, not private capabilities or raw journal records.

## 3. Functional Requirements

### 3.1 Ordinary tool cancellation

#### REQ-001: Scope-bound ordinary tool signal

Every ordinary tool invocation **MUST** receive a readonly `AbortSignal` on `ToolCtx`. The runtime **MUST** mint that signal from the Effection scope that owns the invocation and **MUST** abort it when the scope is cancelled or exits.

**Source**: DR-001

**Rationale**: Ordinary tools need a familiar bridge to cancellable platform APIs without making the signal durable authority.

**Acceptance Criteria**:
- [ ] Every ToolCtx composition path supplies a signal.
- [ ] Cancelling the owning scope aborts the exact signal supplied to the tool.
- [ ] Independent invocations receive independent signals.

#### REQ-002: External abort propagation and failure precedence

Ordinary runtime adapters **MUST** pass the tool signal to abort-aware fetch, process, worker, and remote SDK operations. When a boundary throws after the signal aborts, the adapter **MUST** classify cancellation before translating other errors and **MUST NOT** expose arbitrary thrown values.

**Source**: DR-002

**Rationale**: Cancellation frequently manifests as an SDK-specific abort exception rather than a common error class.

**Acceptance Criteria**:
- [ ] A fetch/process fixture receives the invocation signal and stops cooperatively.
- [ ] An abort-like error after signal delivery becomes cancellation, not generic tool failure.
- [ ] A failure occurring before abort remains the classified failure.

#### REQ-003: Lexical resource ownership

Ordinary tool resources **MUST** be owned by Effection `resource`, `ensure`, an owned child scope, or equivalent generator `finally` cleanup. Cleanup operations **MUST** be awaited and **MUST NOT** outlive the invocation scope as floating promises.

**Source**: DR-003

**Rationale**: A signal requests cancellation; structured ownership guarantees release.

**Acceptance Criteria**:
- [ ] Bash cancellation terminates and joins its process tree.
- [ ] Resource cleanup runs on success, failure, and cancellation.
- [ ] Static/runtime checks find no unowned cleanup promise.

#### REQ-004: Paired ordinary tool cancellation result

Cancelling an ordinary tool **MUST** produce one terminal result paired with the original tool-call ID. The runtime **MUST NOT** leave an unresolved provider tool call in subsequent history.

**Source**: DR-004

**Rationale**: Provider protocols require tool-call/tool-result pairing.

**Acceptance Criteria**:
- [ ] A cancelled call has exactly one terminal result with the same call ID.
- [ ] Reconnect/history reconstruction contains no dangling call.

#### REQ-005: Signal data minimization

A live tool `AbortSignal`, its controller, listeners, and raw reason **MUST NOT** be persisted, serialized, included in snapshots, logged, or treated as proof of rollback. Public cancellation diagnostics **MUST** use explicit safe fields.

**Source**: DR-005, DR-058

**Rationale**: Signals are activation-local capabilities and may carry arbitrary reasons.

**Acceptance Criteria**:
- [ ] Persistence/public-frame scans contain no signal/controller object or arbitrary reason.
- [ ] Safe cancellation records contain only declared identifiers and safe reason strings.

#### REQ-006: Ordinary mutation commit point

Every mutating ordinary-tool adapter **MUST** define a linearization point. Before that point cancellation **MAY** discard staged work. After that point the adapter **MUST** finish and expose the committed fact and **MUST NOT** report rollback merely because the signal aborted.

**Source**: DR-006

**Rationale**: Cancellation timing cannot undo a committed filesystem or remote mutation.

**Acceptance Criteria**:
- [ ] Pre-commit cancellation leaves no mutation and removes staging resources.
- [ ] Post-commit cancellation reports the committed mutation.
- [ ] A deterministic barrier test covers cancellation during commit.

#### REQ-007: Bounded ordinary progress

Long-running ordinary tools **SHOULD** emit bounded structured progress or artifact references through existing tool-event seams. They **SHOULD NOT** embed unbounded raw logs in cancelled tool results.

**Source**: DR-007

**Rationale**: Partial observations are useful after cancellation but provider context is bounded.

**Acceptance Criteria**:
- [ ] A long-running fixture exposes structured progress before cancellation.
- [ ] Oversized logs are truncated or referenced rather than copied wholesale.

### 3.2 Cancellation command, frontier, and activation

#### REQ-008: Atomic cancellation acceptance

Graceful durable cancellation **MUST** atomically append one `CancellationRequested` record containing task ID, command ID, first informational reason, and cancellation frontier. Acceptance for a parked or ownerless task **MUST** atomically mark its session runnable.

**Source**: DR-008, DR-059

**Rationale**: Cancellation and its wakeup must survive process absence.

**Acceptance Criteria**:
- [ ] Cancellation record and runnable marker commit together.
- [ ] A recovery coordinator discovers and activates ownerless cancelled work.
- [ ] No transient notification is required for recovery.

#### REQ-009: Cancellation idempotency and first reason

The first accepted cancellation **MUST** fix the task frontier and informational reason. Later cancellation requests for that task **MUST** return accepted/idempotent acknowledgement, **MUST** preserve the first reason, and **MUST NOT** append another frontier or conflict solely because a later reason differs.

**Source**: DR-009

**Rationale**: Human-readable reasons are informational and multiple users may cancel concurrently.

**Acceptance Criteria**:
- [ ] Equal and different-reason duplicates leave one cancellation record.
- [ ] Every duplicate acknowledgement identifies the original command/frontier.

#### REQ-010: Operational loss is not cancellation

Request disconnect, response-stream cancellation, worker/container loss, attachment loss, ownership expiry, and deployment **MUST NOT** append `CancellationRequested` or close a task cancelled.

**Source**: DR-010

**Rationale**: Operational loss and user intent are distinct facts.

**Acceptance Criteria**:
- [ ] Fault injection at each listed loss point creates no cancellation record.
- [ ] Recovery continues or reports interruption according to the existing durability contract.

#### REQ-011: Cancellation state machine

The authority **MUST** implement only the following cancellation transitions:

```text
none -> requested
requested -> settling_pull | cancelling_children | unwinding
settling_pull -> cancelling_children | unwinding
cancelling_children -> unwinding
unwinding -> cancelled
requested | settling_pull | cancelling_children | unwinding -> orphaned
```

It **MUST NOT** expose `cancelled` while effects, cleanup operations, or descendants remain nonterminal.

**Source**: DR-011, DR-023, DR-035

**Rationale**: A terminal label must not conceal ongoing cleanup.

**Acceptance Criteria**:
- [ ] Invalid transitions are rejected without journal mutation.
- [ ] Public state remains `cancelling` until all graceful work closes.

### 3.3 Frontier settlement

#### REQ-012: Signal or cancel a settleable effect

Before applying cancellation to a frontier pull, the authority **MUST** classify it deterministically. An attempt is settleable if and only if it is in `started` state with a live attachment able to observe `DurableEffectContext.cancellation`, or it exposes a reachable durable server-task cancellation protocol able to return a terminal disposition. Completed, revoked, superseded, abandoned, detached, unreachable, and unattempted pulls are non-settleable for this cancellation. When the frontier contains a settleable effect attempt, ProgramRuntime **MUST** immediately deliver the safe cancellation reason through the live handler signal or reachable durable server-task protocol.

**Source**: DR-012

**Rationale**: External work should begin stopping promptly while semantic settlement remains durable.

**Acceptance Criteria**:
- [ ] A table-driven test classifies started-live and reachable server-task attempts settleable.
- [ ] The same table classifies completed, revoked, superseded, abandoned, detached, unreachable, and unattempted cases non-settleable identically on in-memory and Redis backends.
- [ ] Live handlers observe signal abort before program cancellation injection.
- [ ] Durable server tasks receive one idempotent cancel command.

#### REQ-013: Await one settleable disposition

Cancellation request alone **MUST NOT** revoke a settleable live pull. The authority **MUST** accept its first valid terminal disposition and **MUST** remain in `settling_pull` until disposition or force-orphan. This rule covers installed-effect attempts and host-resolved pulls such as model sampling. If force-orphan revokes the capability before disposition, resolution **MUST** return `capability_revoked` under the precedence in §5.

**Source**: DR-013

**Rationale**: A reachable live resolver owns knowledge of its commit point.

**Acceptance Criteria**:
- [ ] Cancellation may remain pending while the live pull shuts down.
- [ ] The pull capability remains valid until settlement or explicit revocation.
- [ ] No subsequent program action is reserved while settling.

#### REQ-014: Direct cancellation of non-settleable pulls

For a non-settleable pending pull, the command lane **MUST** append a payload-free cancelled resolution without waiting for a handler. It **MUST** revoke stale resolution capabilities. If an old external action may have run, it **MUST** also append `AttemptOutcomeUnknown` and **MUST NOT** fabricate a completed result. Revoking a detached attempt under this requirement is the `detached` to `revoked` transition that specializes the parent attempt-state algebra in `DR-101` of `crank-native-durable-remote-tools-design.md` for explicit user cancellation.

**Source**: DR-014

**Rationale**: Elicits, waits, detached attempts, and unreachable resolvers have no terminal handler to await.

**Acceptance Criteria**:
- [ ] Parked elicit and wait pulls resolve cancelled immediately.
- [ ] Detached/unreachable capabilities reject late resolution after cancellation.
- [ ] Potential external execution is represented as unknown.

#### REQ-015: Cancellation versus external response race

Cancellation and an external response **MUST** serialize through first-writer-wins journal transactions. If cancellation resolves a non-settleable pull first, a later response **MUST** be rejected. If the response resolves first, that outcome **MUST** be preserved and cancellation **MUST** be injected before the next program action.

**Source**: DR-015

**Rationale**: User responses and cancellation are competing commands over one pull.

**Acceptance Criteria**:
- [ ] Deterministic barriers prove both orderings.
- [ ] Exactly one `PullResolved` exists.

#### REQ-016: Completion after cancellation request

A valid `{ status: "ok" }` disposition returned by a settleable effect after cancellation request **MUST** be journaled as a committed fact. ProgramRuntime **MUST** replay that result into the generator but **MUST** inject cancellation before accepting the following ordinary proposal.

**Source**: DR-016

**Rationale**: The effect may have crossed its commit point before observing cancellation.

**Acceptance Criteria**:
- [ ] A commit-barrier fixture preserves its completed result.
- [ ] No operation after that result is dispatched before cancellation injection.

#### REQ-017: Cancelled or failed disposition before unwind

A valid cancelled or failed disposition returned while cancellation is requested **MUST** be journaled before cancellation unwind. A cancelled disposition **MUST** deliver typed cancellation at that effect boundary; a failed disposition **MUST** remain an auditable effect fact while the enclosing task still terminates cancelled after authored error/finally handling.

**Source**: DR-017

**Rationale**: Replay must reconstruct what the effect reported before reconstructing cleanup.

**Acceptance Criteria**:
- [ ] Journal order is disposition before cleanup pull.
- [ ] Final task outcome is cancelled for both disposition branches.

### 3.4 Replay, injection, and cleanup

#### REQ-018: Fresh replay to cancellation frontier

After frontier settlement, ProgramRuntime **MUST** create a fresh exact-version attachment and strictly replay all recorded actions through the cancellation frontier. It **MUST NOT** depend on the original generator, process, or transport attachment.

**Source**: DR-018

**Rationale**: Cancellation of parked work must be processless and replay-correct.

**Acceptance Criteria**:
- [ ] Destroying all live state before cancellation still runs cleanup.
- [ ] Replay dispatches no already-resolved work.

#### REQ-019: Typed cancellation injection

ProgramRuntime **MUST** inject a catchable `DurableProgramCancellation` equivalent to `generator.throw()` at the next unresolved program boundary. The local driver **MUST NOT** implement graceful cancellation solely with `generator.return()`.

**Source**: DR-019

**Rationale**: Authored compensation may distinguish cancellation while `finally` remains guaranteed.

**Acceptance Criteria**:
- [ ] A catch block identifies the typed cancellation.
- [ ] A finally block executes whether or not cancellation is caught.

#### REQ-020: One-shot cancellation and normal cleanup

One accepted cancellation command **MUST** be injected exactly once. Operations yielded by cancellation catch/finally cleanup **MUST** use normal durable execution and **MUST NOT** be immediately cancelled again by the same command.

**Source**: DR-020, DR-022

**Rationale**: One-shot delivery preserves ordinary `finally` syntax without sticky cancellation scopes.

**Acceptance Criteria**:
- [ ] Multiple cleanup pulls resolve normally.
- [ ] Duplicate cancellation commands do not reinject cancellation.
- [ ] Cleanup pulls use normal reservation, capability, schema, and replay rules.

#### REQ-021: Cancellation cannot be swallowed into success

If authored code catches cancellation and returns a value, ProgramRuntime **MUST** discard that value as successful/tool output and **MUST** close the task cancelled after cleanup. The runtime **MUST NOT** project the returned value to model/public history. Facts intended to survive **MUST** cross an accepted effect or durable-emission boundary.

**Source**: DR-021

**Rationale**: Explicit user intent remains authoritative without creating a hidden result channel.

**Acceptance Criteria**:
- [ ] A catch-and-return fixture closes cancelled.
- [ ] Its return value is absent from public/model projections.
- [ ] A durable emission from the same catch remains available.

#### REQ-022: Closure after cleanup and descendants

A gracefully cancelled task **MUST NOT** append `TaskClosed(cancelled)` until every cleanup pull and every structured descendant is terminal.

**Source**: DR-023

**Rationale**: Terminal cancellation certifies completed structured unwind.

**Acceptance Criteria**:
- [ ] Every cleanup/descendant close offset precedes the parent close.
- [ ] Crash during cleanup resumes without duplicate cleanup effects.

### 3.5 Effect dispositions and partial results

#### REQ-023: Closed effect disposition contract

Every durable effect handler **MUST** return the closed `DurableEffectDisposition` algebra in §2.2. Handler adapters **MUST** detect cancellation before classifying thrown errors, **MUST** project expected failures to explicit error dispositions, and **MUST NOT** persist arbitrary thrown values.

**Source**: DR-024

**Rationale**: Durable settlement must distinguish completion, failure, and cooperative cancellation explicitly.

**Acceptance Criteria**:
- [ ] Type gates reject raw-JSON durable effect handlers.
- [ ] All three dispositions round-trip through the authority.
- [ ] Arbitrary errors produce safe serialized errors only.

#### REQ-024: Declared cancellation partial schema

A cancelled disposition **MAY** contain `partial` only when the effect definition declares `cancellation.partialSchema`. Without that declaration, any partial field **MUST** be discarded under REQ-026 and the effect **MUST** settle payload-free cancelled.

**Source**: DR-025

**Rationale**: Partial output is a typed branch of the effect contract, not an arbitrary side channel.

**Acceptance Criteria**:
- [ ] Declared partial parses and persists.
- [ ] Undeclared partial degrades to payload-free cancellation with an audit marker.

#### REQ-025: Compile-time disposition inference

Effect input, successful output, and cancellation-partial schemas **MUST** carry compile-time witnesses. Registration and handler APIs **MUST** infer `DurableEffectDisposition<Output, Partial>` without requiring explicit generic arguments.

**Source**: DR-026

**Rationale**: Runtime parsing and TypeScript authoring must share one contract.

**Acceptance Criteria**:
- [ ] Type tests infer successful and partial result fields.
- [ ] Incorrect successful or partial shapes fail compilation.

#### REQ-026: Partial parsing and graceful degradation

The authority **MUST** canonicalize and parse a supplied cancellation partial against its declared schema and inline size limit before persistence. On schema or size failure, it **MUST** discard the partial, append exactly one safe `CancellationPartialDiscarded` record with only the allowed reason, and settle the pull as payload-free cancelled. Invalid partial data **MUST NOT** block graceful unwind.

**Source**: DR-027

**Rationale**: Losing a summary is preferable to stranding completed cleanup.

**Acceptance Criteria**:
- [ ] Valid partial persists unchanged as canonical JSON.
- [ ] Invalid-schema and oversized partials each produce the correct marker and payload-free cancellation.
- [ ] Marker/public diagnostics contain none of the rejected payload.

#### REQ-027: Partial-result truthfulness

A cancellation partial **MUST** contain only authoritative observations available at cancellation settlement. It **MUST NOT** claim successful completion, rollback, or absence of an external commit unless the handler can prove that fact.

**Source**: DR-028

**Rationale**: Partial summaries guide future work and must not fabricate external state.

**Acceptance Criteria**:
- [ ] Bash partial reports completed tests and explicit incomplete status.
- [ ] Edit-before-commit may report `committed: false`; uncertain edit reports unknown rather than false.

#### REQ-028: Competing disposition idempotency

The first valid terminal disposition **MUST** win. A later canonically equal disposition **MUST** return the original duplicate receipt. A later different disposition **MUST** return a typed conflict and **MUST NOT** overwrite history.

**Source**: DR-029

**Rationale**: Cancellation can race multiple live or detached attempts.

**Acceptance Criteria**:
- [ ] Concurrent equal dispositions converge on one resolution.
- [ ] Concurrent unequal dispositions preserve one winner and report conflict.

#### REQ-029: Cancelled replay

Replay of a cancelled effect **MUST** return the exact recorded cancelled disposition and partial, or the exact payload-free degraded disposition, without invoking the handler or re-emitting partial output.

**Source**: DR-030

**Rationale**: Cancellation results are durable effect facts.

**Acceptance Criteria**:
- [ ] Handler invocation count remains zero during replay.
- [ ] Recorded partial/digest is byte-identical after recovery.

#### REQ-030: Bounded partial design

Cancellation partial schemas **SHOULD** use bounded structured summaries rather than raw log arrays and **SHOULD** use authorized artifact references when the deployment provides them.

**Source**: DR-031

**Rationale**: Provider context and semantic journals should not absorb unbounded logs.

**Acceptance Criteria**:
- [ ] Reference fixture summarizes logs and uses an artifact reference for full output.

### 3.6 Structured propagation and force orphaning

#### REQ-031: Recursive leaves-first child cancellation

Graceful cancellation **MUST** propagate recursively through the structured child tree. If the frontier is a child pull, the parent **MUST** remain in `cancelling_children` while each child settles its own frontier, replays, injects cancellation, executes cleanup, and closes descendants. All descendant closes **MUST** precede parent-pull cancellation and parent cleanup.

**Source**: DR-032

**Rationale**: Child cleanup is part of the parent's structured lifetime.

**Acceptance Criteria**:
- [ ] Nested child journal ordering is leaves-first.
- [ ] Parent cannot close while any descendant remains active.

#### REQ-032: Explicit external durable ownership

Work intended to outlive a cancelled tool **MUST** be represented by a separately owned durable resource/session with explicit identity, status, and cancellation semantics. The durable-tool API **MUST NOT** provide implicit detached child work.

**Source**: DR-033

**Rationale**: Detachment is a different ownership contract, not a cancellation option.

**Acceptance Criteria**:
- [ ] Detached spawn is unavailable from the normal tool context.
- [ ] External task handles remain independently observable after parent cancellation.

#### REQ-033: Force-orphan command

The system **MUST** expose a separately authenticated force-orphan command. It **MUST** revoke unresolved capabilities, best-effort terminate known live handles and descendants, append `CleanupSkipped` and `TaskOrphaned`, and **MUST NOT** append clean `TaskClosed(cancelled)`.

**Source**: DR-034, DR-035

**Rationale**: Operators need an honest escape hatch for missing code or non-settling cleanup.

**Acceptance Criteria**:
- [ ] Normal users cannot invoke force orphaning without administrative authority.
- [ ] Late revoked capabilities fail.
- [ ] Public state distinguishes orphaned from cancelled.

#### REQ-034: Force-orphan race

A completion durably accepted before force-orphan **MUST** remain committed. Force-orphan **MUST NOT** overwrite any accepted effect, child, or task fact.

**Source**: DR-036

**Rationale**: Administrative termination does not rewrite history.

**Acceptance Criteria**:
- [ ] Completion-first preserves the result.
- [ ] Force-first revokes unresolved capability and records unknown where required.

### 3.7 Conversation and model history

#### REQ-035: Cancel turn, not session

Graceful cancellation **MUST** terminate only the selected active turn/task and **MUST** leave the conversation/session open for later commands unless a separate close-session command exists.

**Source**: DR-037

**Rationale**: Users cancel work in order to continue with a better instruction.

**Acceptance Criteria**:
- [ ] A new turn starts after cancellation closes.
- [ ] Session identity and completed history are preserved.

#### REQ-036: Client-local successor policy

Cancellation authority, conversation storage, host checkpoints, and AG-UI events **MUST NOT** persist, publish, hydrate, or recover pending successor-message queue state. A client **MAY** retain pending user inputs locally while cancellation settles. It **MUST NOT** submit them until authoritative state proves that the targeted execution is terminal and normal message admission is permitted. A locally retained input **MUST NOT** count as accepted server work before that admission succeeds. Client close or reload **MAY** discard it unless the application independently persists it.

**Source**: DR-038

**Rationale**: Queueing is an optional client UX policy, not shared conversation authority.

**Acceptance Criteria**:
- [ ] Server checkpoints, histories, command receipts, and AG-UI frames contain no pending local successor.
- [ ] Queue, drop, and interrupt clients can use different local policies against the same server contract.
- [ ] A local successor is sent only after terminal cancellation and never creates a concurrent root.
- [ ] Closing an in-memory client may discard its pending successor without server cleanup.

#### REQ-037: Preserve cancelled-turn facts

Subsequent model history **MUST** preserve completed turns, committed effect/tool facts, valid cancellation partials, and durable user-visible observations from the cancelled turn.

**Source**: DR-039

**Rationale**: Future instructions often depend on partial test failures or committed edits.

**Acceptance Criteria**:
- [ ] A follow-up model sees completed test failures from a cancelled suite.
- [ ] A committed edit result remains visible after enclosing turn cancellation.

#### REQ-038: Interrupted assistant text and redaction

User-visible partial assistant text **MUST** be retained with an interrupted/cancelled marker. Private reasoning, capabilities, transport handles, live signals, secrets, and malformed partial protocol values **MUST NOT** enter model/public history.

**Source**: DR-040, DR-058

**Rationale**: Useful narrative context should survive without exposing private runtime state.

**Acceptance Criteria**:
- [ ] Reconnect renders the partial text and marker once.
- [ ] Redaction scans find none of the prohibited values.

#### REQ-039: Terminal repair for unfinished tool calls

Every unfinished tool call **MUST** receive exactly one paired terminal result. A gracefully settled cancellation **MUST** project `status: "cancelled"` and its valid partial when present. Force-orphaned or uncertain non-settleable work **MUST** project `status: "interrupted", outcome: "unknown"` and **MUST NOT** be represented as completed.

**Source**: DR-041

**Rationale**: Provider history requires pairing and users require honest uncertainty.

**Acceptance Criteria**:
- [ ] Provider transcript validation accepts every repaired history.
- [ ] Graceful and unknown-outcome cases have distinct projections.

#### REQ-040: Cleanup and late-result privacy

Cleanup effect results **MUST** remain private unless the program explicitly emits durable user/model-visible output. A late result rejected after revocation **MUST** remain private audit data and **MUST NOT** replace the terminal tool result.

**Source**: DR-042, DR-043

**Rationale**: Cleanup mechanics and stale outcomes are not user task results.

**Acceptance Criteria**:
- [ ] Default model history excludes cleanup result payloads.
- [ ] Revoked late outcome cannot alter public/model state.

#### REQ-041: Default bounded model projection

Model-facing cancellation projection **SHOULD** use the structured partial and artifact references rather than raw logs. A future pure projector **MAY** customize presentation but **MUST NOT** perform effects or influence authority settlement.

**Source**: DR-044

**Rationale**: Model presentation is a projection, not workflow control.

**Acceptance Criteria**:
- [ ] Default projection is bounded.
- [ ] Projector type/runtime gates reject effectful projection contracts.

### 3.8 Fluent durable-tool builder

#### REQ-042: Fluent builder stages

The public builder **MUST** support:

```ts
createDurableTool(name)
  .description(description)
  .identity({ version, digest })
  .parameters(schema)
  .output(schema) // optional
  .elicits(definitions) // optional
  .effects(definitions)
  .execute(generator);
```

Builder type-state **MUST** prevent `.execute()` before description, identity, parameters, and effects are supplied.

**Source**: DR-045

**Rationale**: Durable authoring should match `createTool` ergonomics without hiding pinned identity.

**Acceptance Criteria**:
- [ ] Valid chains infer all types and construct one frozen durable tool.
- [ ] Type tests reject missing required stages and stage-order misuse.

#### REQ-043: Input and implementation-output inference

`.parameters()` **MUST** infer generator input. If `.output()` is omitted, `.execute()` **MUST** infer its return type and **MUST** require that type to extend canonical `Json`.

**Source**: DR-046

**Rationale**: Durable tools should retain ordinary builder output inference.

**Acceptance Criteria**:
- [ ] No explicit generic is required for inferred input/output.
- [ ] Date, function, undefined, and other non-Json returns fail type/runtime gates.

#### REQ-044: Optional refined output parsing

When `.output()` is omitted, the manifest **MUST** use JSON Schema `true` and the authority **MUST** still enforce canonical JSON and size limits. When `.output()` is provided, its schema **MUST** constrain the generator return type and parse persisted completion output.

**Source**: DR-047, DR-048

**Rationale**: Schema omission means any canonical JSON, not absence of durable validation.

**Acceptance Criteria**:
- [ ] Omitted output accepts varied canonical JSON and rejects noncanonical/oversized values.
- [ ] Provided schema rejects an invalid completion before task close.

#### REQ-045: Exact identity and declared effects

The builder **MUST** require exact version and digest through `.identity()`. `.effects()` **MUST** define the exact effect definitions available to the typed program context. Concrete handlers, routes, credentials, and live clients **MUST NOT** enter the program manifest or module.

**Source**: DR-049, DR-050

**Rationale**: Replay identity and effect purity are semantic requirements.

**Acceptance Criteria**:
- [ ] Missing/invalid digest fails construction.
- [ ] Undeclared effect use fails type/runtime validation.
- [ ] Manifest contains no handler or credential.

#### REQ-046: No second cancellation DSL

The normal fluent builder **MUST NOT** add `.onCancel()`, `handoff`, or mandatory `nonCancellable` stages. Authors **MUST** use ordinary catch/finally and declared effects for compensation and cleanup. Cancellation partial typing **MUST** belong to effect definitions/dispositions, not a second tool output channel.

**Source**: DR-051, DR-052

**Rationale**: One structured language is easier to replay and explain.

**Acceptance Criteria**:
- [ ] Public surface contains none of the prohibited builder stages.
- [ ] Bash/edit examples express cleanup with finally and durable effects.

#### REQ-047: Package placement

The Zod-backed fluent adapter **SHOULD** live with `createTool` in `@sweatpants/core` and **SHOULD** lower to the framework-independent manifest constructor in `@sweatpants/session-contract`. `session-contract` **SHOULD NOT** acquire a Zod dependency.

**Source**: DR-053

**Rationale**: Core already owns Zod authoring while session-contract is the semantic leaf.

**Acceptance Criteria**:
- [ ] Package-boundary tests preserve session-contract dependencies.
- [ ] Builder output is accepted by the low-level session-contract registry.

## 4. Verification Requirements

#### REQ-048: Shared authority cancellation corpus

One backend-neutral conformance corpus **MUST** run unchanged against in-memory and Redis authorities. It **MUST** cover cancellation before effect settlement, completion-before-cancellation, valid/invalid/oversized partials, differing duplicate reasons, direct elicit/wait cancellation, response races, process loss during unwind, cleanup replay, late conflicts, runnable discovery, and force-orphan.

**Source**: DR-054, DR-055, DR-059

**Rationale**: Redis and process-local semantics must not diverge at cancellation boundaries.

**Acceptance Criteria**:
- [ ] Both backends execute the identical case definitions.
- [ ] Normalized records, receipts, runnable state, and error codes agree.
- [ ] Redis tests use real CAS operations without global destructive test hooks.

#### REQ-049: Optional AgentCore transport equivalence

After core authority conformance is complete, AgentCore **MAY** run the shared local-driver cancellation/unwind fixture and compare normalized semantic records.

**Source**: DR-056

**Rationale**: This is valuable transport evidence but may ship after core semantics.

**Acceptance Criteria**:
- [ ] If implemented, container replacement and remote cancellation produce the local normalized journal.

#### REQ-050: Product cancellation flow

Product tests **MUST** cancel a long-running bash/test process, preserve a structured partial failure summary, retain a follow-up in optional client-local state until authoritative cancellation terminalizes, admit it as a normal message, and prove that the next model turn can use the committed partial facts.

**Source**: DR-057

**Rationale**: The coding-agent scenario validates cancellation, history repair, and UX together.

**Acceptance Criteria**:
- [ ] Process tree is confirmed stopped.
- [ ] Partial summary identifies completed/failed tests.
- [ ] Follow-up starts only after cancellation close and references the first failure.

#### REQ-051: Cancellation boundary secrecy

Static and runtime tests **MUST** prove that persisted/public cancellation data contains no live signal/controller, capability token, process handle, arbitrary thrown value, environment, or secret.

**Source**: DR-058

**Rationale**: Cancellation touches privileged runtime boundaries and public history.

**Acceptance Criteria**:
- [ ] Canonical snapshot and public-frame scans reject every prohibited fixture.
- [ ] Safe diagnostics expose only stable IDs, symbolic codes, and approved text.

## 5. Error Catalog

| Code | Meaning | Required behavior |
|---|---|---|
| `cancellation_conflict` | Cancellation targets a different task/frontier identity than the accepted command | Reject without mutation; differing informational reason alone is not conflict |
| `cancellation_blocked` | Graceful cancellation cannot load the pinned program | Leave nonterminal and offer force-orphan |
| `task_terminal` | Command/response targets a terminal task | Return expected rejection value |
| `capability_revoked` | A non-settleable/force-orphaned capability is no longer admissible | Reject late result and retain audit only |
| `resolution_conflict` | One pull already has a different disposition | Preserve first disposition |
| `idempotency_conflict` | Competing attempts report different dispositions | Preserve winner and emit private high-severity diagnostic |
| `schema_validation_failed` | Successful output or cancellation partial failed its schema | Successful output rejects; cancelled partial degrades under REQ-026 |
| `payload_too_large` | Inline value exceeds authority limit | Successful output rejects; cancelled partial degrades under REQ-026 |
| `program_version_unavailable` | Exact pinned bundle cannot be loaded for unwind | Graceful cancellation blocks; force-orphan may proceed |
| `program_corrupt` | Pinned bundle exists but cannot be parsed or replayed safely | Graceful cancellation blocks; force-orphan may proceed with corrupt reason |
| `cleanup_stuck` | Cleanup cannot settle under operational policy | Remain cancelling until force-orphan |
| `outcome_unknown` | Non-settleable external attempt may have run | Project interrupted/unknown, never completed |

Expected rejection outcomes **MUST** be typed values at service/command boundaries. Thrown errors are reserved for defects or framework-mandated exception contracts. Cancellation **MUST** be detected before generic error translation.

Resolution validation **MUST** use this precedence: (1) parse and authenticate capability claims; (2) check attempt/capability revocation, returning `capability_revoked`; (3) check an existing pull disposition, returning duplicate for the same canonical disposition or `resolution_conflict`/`idempotency_conflict` for a different one; (4) check task closure, returning `task_terminal` only after `TaskClosed` exists. Implementations **MUST NOT** choose among these codes based on backend timing.

## 6. Security Considerations

- Cancellation and force-orphan commands **MUST** authenticate their principals. Force-orphan **MUST** require separate administrative authority.
- Resolution capabilities **MUST** remain audience-, pull-, task-, journal-incarnation-, and schema-bound.
- Cancellation reasons **MUST** be bounded safe strings and **MUST NOT** contain arbitrary serialized errors.
- Partial-result schemas **MUST** apply data minimization. Secrets, credentials, environments, raw thrown values, and live handles **MUST NOT** enter partials.
- Rejected partials **MUST NOT** appear in discard markers or diagnostics.
- Private journal encryption obligations from the parent crank-native specification remain applicable.
- Public/model projections **MUST** redact private reasoning, capability claims, request state, and transport metadata.
- Force-orphan audit records **MUST** preserve who authorized the command through safe principal identity without exposing credentials.

## 7. Migration and Compatibility

This change is intentionally breaking for private pre-release APIs and snapshots.

1. `BaseToolCtx` gains required `signal`; every context constructor must be updated atomically. Existing ordinary authored tools remain source-compatible because additional context fields do not require use.
2. `DurableEffectHandler` changes from `Operation<Json>` to `Operation<DurableEffectDisposition<...>>`; registrations and local/AgentCore transport DTOs must migrate together.
3. `EffectDefinition` gains a cancellation-partial type witness and optional schema.
4. `OperationOutcome` gains optional partial data on cancelled outcomes.
5. The semantic journal gains cancellation frontier, partial-discard, and unknown-outcome records and must increment its snapshot/schema version.
6. The blanket post-cancellation rejection in the current authority and its conformance expectation must be deleted and replaced with REQ-012–017.
7. Local driver cancellation must change from return-only behavior to typed interruption and continued cleanup driving.
8. The fluent builder is additive in `@sweatpants/core`; the low-level manifest constructor remains available to runtime/generated code.
9. No migration reader for previous private ProgramRuntime authority snapshots is required. Deployment must drain or explicitly orphan incompatible nonterminal pre-release tasks.

## 8. Conformance Ordering Examples

### 8.1 Settleable effect completes after cancellation request

```text
TaskOpened
PullRequested(effect)
AttemptStarted
CancellationRequested(frontier=pull)
PullResolved(ok committed result)
[replay]
DurableProgramCancellation injected before next proposal
cleanup PullRequested
cleanup AttemptStarted
cleanup PullResolved
TaskClosed(cancelled)
```

### 8.2 Settleable effect cancels with partial

```text
TaskOpened
PullRequested(effect)
AttemptStarted
CancellationRequested(frontier=pull)
PullResolved(cancelled, partial)
[replay injects typed cancellation at effect boundary]
cleanup...
TaskClosed(cancelled)
```

### 8.3 Invalid cancellation partial degrades

```text
CancellationRequested
CancellationPartialDiscarded(payload_too_large)
PullResolved(cancelled, no partial)
cleanup...
TaskClosed(cancelled)
```

### 8.4 Parked elicitation cancellation wins

```text
PullRequested(elicit)
CancellationRequested(frontier=pull)
PullResolved(cancelled)
[late user response with revoked capability -> capability_revoked]
[replay injects typed cancellation]
cleanup...
TaskClosed(cancelled)
```

### 8.5 Nested child cancellation

```text
parent CancellationRequested
child CancellationRequested
child effect settlement
child cleanup pulls
child descendants TaskClosed
child TaskClosed(cancelled)
parent child pull PullResolved(cancelled)
parent cleanup pulls
parent TaskClosed(cancelled)
```

### 8.6 Force orphan

```text
CancellationRequested
[settlement/cleanup cannot continue]
CleanupSkipped
AttemptOutcomeUnknown (when applicable)
TaskOrphaned
```

## References

- Approved design: [durable-tool-cancellation-design.md](durable-tool-cancellation-design.md)
- Parent design: [crank-native-durable-remote-tools-design.md](crank-native-durable-remote-tools-design.md)
- Parent specification: [replay-crank-driver-spec.md](replay-crank-driver-spec.md)
- RFC 2119: <https://www.rfc-editor.org/rfc/rfc2119>
- RFC 8174: <https://www.rfc-editor.org/rfc/rfc8174>
- Temporal cancellation scopes: <https://docs.temporal.io/develop/typescript/workflows/cancellation-scopes>
- Restate invocation cancellation: <https://docs.restate.dev/services/invocation/managing-invocations#cancel>
- Flue durable execution: <https://flueframework.com/docs/guide/durable-execution/>
