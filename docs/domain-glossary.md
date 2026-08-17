# Sweatpants Domain Glossary

**Status:** Living design glossary  
**Purpose:** Record the shared language established during architecture design.  
**Normative force:** Informative unless an accepted ADR or specification says otherwise.

This glossary follows domain-driven and responsibility-driven design. A term names one domain concept, not a convenient code bucket. New code should use an agreed term consistently. Proposed terms remain explicitly provisional until the architecture that needs them is approved.

## Certainty labels

- **Agreed** — explicitly aligned during design discussion. Treat this as the current shared language.
- **Established** — already present in accepted ADRs or existing durable behavior.
- **Provisional** — useful working language, but its exact boundary or name remains open.

## Core durability language

### Durability

**Status:** Agreed

The overall capability by which accepted work survives replacement of hosts, runtimes, transports, and other replaceable compute.

`Durability` is currently an umbrella domain concept, not an agreed package name.

### Host

**Status:** Established

Replaceable compute that interprets external observations, turns them into domain commands, and owns the one demand-pulled crank for an activation.

A Host may be destroyed at any time. Host-local state is not durable truth. A Host acts only under an authority-issued activation fence.

See [ADR-001](./adr/001-one-crank-turner.md).

### Worker

**Status:** Agreed

Replaceable compute that performs tool, model, child-agent, or other external work on behalf of a Host.

A Worker proposes observations or outcomes. It does not directly establish authoritative durable truth or append canonical Session History.

### Structured Execution Tree

**Status:** Agreed

The runtime-owned hierarchy of a root Durable Execution, its child executions, effect scopes, live projection, and finalizers. Parent scopes own child lifetimes, propagate cancellation, join completion, and clean up in reverse lifetime order.

For chat, one Turn's Structured Execution Tree is the consistency boundary. Separate execution identity or physical placement does not by itself create a separate aggregate. Child completion and resolution of the waiting parent are one authority transition.

### Execution Tree Snapshot

**Status:** Agreed at the responsibility level; exact representation provisional

The authority-controlled state of one active Structured Execution Tree. It contains the root and active-child control state, pending inputs and effects, cancellation state, activation fence, compact completed-child outcomes required for replay, checkpoint state, deterministic unpublished projection facts, and durable references to external data required for correctness.

An Execution Tree Snapshot excludes completed Turn History, raw token streams, cold audit mechanics, large artifact bodies, obsolete activation or restore mechanics, transport state, and storage-adapter details.

The snapshot is one logical consistency boundary even when large immutable payloads or replay material are physically stored outside its compare-and-swap document.

### Durable Reference

**Status:** Agreed at the responsibility level; exact representation provisional

An opaque stable identifier for durable data stored outside a mutable compare-and-swap document. The referenced value remains in the same required durability class as the execution state that depends on it.

A Durable Reference does not universally require a content digest. Storage within one trusted atomic boundary may rely on transactional identity and immutability. Integrity evidence may be added when a value crosses a trust boundary, cannot be atomically committed with its reference, or is independently reconstructed and compared.

This is deliberately reversible: reference formats may later gain integrity metadata without changing aggregate ownership, lifecycle, or retention boundaries.

### Expected Failure

**Status:** Agreed

A modeled operational or application failure such as tool rejection, provider failure, schema failure, or child failure. Expected Failure is represented as a typed outcome and handled by program logic; it is not Host loss.

### Logical Cancellation

**Status:** Agreed

A domain request to terminate a computation with a cancelled outcome, such as user cancellation, supersession, or a parent no longer requiring a child. The Journal Authority records Logical Cancellation. The runtime delivers it through the normal crank protocol, runs authored finalizers, joins children, and records the semantic outcome.

Logical Cancellation of a parked branch marks the branch runnable. It does not abort the branch because no computation is active. Logical Cancellation accepted during active work may cause the Host to abort that active attempt before the runtime delivers cancellation at the durable frontier.

See [ADR-005](./adr/005-cancel-abort-and-dispose.md).

### Abort

**Status:** Agreed

An operational request to stop active work now. Abort targets a live attempt, pull loop, provider request, worker, process, or Effection scope. It is process-local or placement-local and may use `AbortSignal` to reach cooperative external APIs.

Abort is not a durable outcome and does not imply Logical Cancellation. Request disconnect, Host shutdown, ownership loss, and process replacement may abort live work without cancelling the program. A parked branch has no active work to abort.

See [ADR-005](./adr/005-cancel-abort-and-dispose.md).

### Dispose

**Status:** Agreed

Release of owned runtime resources after they are no longer needed. Disposal closes scopes, workers, subscriptions, queues, buffers, and handles. It does not choose or prove a semantic outcome.

Normal completion, failure, Logical Cancellation, Host shutdown, and process replacement may all cause disposal. The owner preserves any required terminal or recovery state before deleting resources needed to recover it.

See [ADR-005](./adr/005-cancel-abort-and-dispose.md).

### Graceful Host Shutdown

**Status:** Agreed

An expected process lifecycle event such as SIGTERM, deployment drain, or supervisor-requested shutdown. It is not Logical Cancellation of the user's Turn.

During Graceful Host Shutdown, the Host stops accepting work, stops starting new effects, drains owned scopes within a bounded grace period, runs finalizers, checkpoints quiescent work where possible, releases activation ownership, and shuts down attachments as scope exit rather than user cancellation.

### Catastrophic Host Loss

**Status:** Agreed

An ungraceful loss such as power failure, kernel kill, process corruption, or immediate machine disappearance. Finalizers and shutdown hooks are not guaranteed to run.

Recovery returns to the last Authority-Accepted Frontier. Work not accepted by the Journal Authority was never promised. Catastrophic Host Loss constrains fallback recovery semantics but does not define the normal execution lifecycle.

### Authority-Accepted Frontier

**Status:** Agreed

The latest state transition durably accepted by the Journal Authority. It is the recovery boundary after Catastrophic Host Loss.

### Journal Authority

**Status:** Established; internal decomposition provisional

The serialization authority that decides which concurrent Host command becomes authoritative. It validates current state, activation fencing, capabilities, idempotency, and transition legality before atomically committing durable state.

The Journal Authority is not the same as a storage adapter. Redis, memory, or Cloudflare storage may provide compare-and-swap and persistence without owning durable-execution policy.

Current design phrase:

> Host-authored, authority-committed, history-projected.

### Host-authored

**Status:** Agreed

The Host interprets worker, model, tool, user, or child-agent observations and proposes their canonical semantic meaning. External executors cannot write durable outcomes directly.

### Authority-committed

**Status:** Agreed

A proposed Host transition becomes durable truth only after acceptance by the Journal Authority under the current activation fence and state revision.

### History-projected

**Status:** Agreed

Long-lived, user-readable history is derived from committed semantic facts. Projection does not decide execution correctness.

## Session and chat language

### Session

**Status:** Agreed at the conceptual level; exact cross-domain schema provisional

A long-lived identity and readable projection of what occurred. A Session is not itself an indefinitely replayed execution.

Different bounded contexts may project different Session views. A generic Session should not force chat, A2A, and tool-specific history entries into one universal union.

### Conversation

**Status:** Agreed

The chat bounded context's long-lived Session: an ordered, readable history of human interactions and agent results.

A Conversation may contain many completed Turns and at most one canonical active Turn unless a future concurrency policy explicitly permits more.

### Turn

**Status:** Agreed

One complete human-facing interaction in the chat bounded context.

A Turn begins when a human message is accepted. The agent may then perform any number of model invocations, reasoning steps, tool executions, child-agent executions, elicitations, retries, parks, and resumptions. The Turn ends when the agent presents a terminal result or the interaction terminally fails, is cancelled, or is superseded.

A model/tool loop is not a new Turn. An elicitation response resumes the existing Turn rather than starting another Turn.

```text
Human message
  -> model invocation
  -> tool and child-agent work
  -> further model invocations
  -> terminal agent result
```

The entire sequence is one Turn.

### Agent Step

**Status:** Provisional

One internal model-led decision cycle within a Turn, typically a model invocation followed by proposed tool calls, child work, or a terminal response.

`Agent Step` exists to avoid using `Turn` for internal model/tool loops.

### Model Invocation

**Status:** Agreed

One call to a model provider. A completed Model Invocation contributes one canonical terminal effect outcome to durable execution. Token deltas are live UX data and are not replay inputs.

See [ADR-002](./adr/002-one-host-owned-reconnect-log.md).

### Elicitation Response

**Status:** Agreed

Human continuation input requested by an already active Turn, Tool Execution, or Child Execution. It resumes that execution and does not create a new chat Turn.

## Execution language

### Crank

**Status:** Agreed

One demand-pulled advance of a program. The crank supplies a resume input, runs the program until it parks or terminates, and returns the next durable proposal or outcome. `ProgramRuntime.run()` is the sole crank turner for durable programs.

A response to a parked ask and Logical Cancellation of that ask are both crank inputs. Abort is not a crank input. It stops an active crank attempt so a later crank can continue from accepted durable state.

See [ADR-001](./adr/001-one-crank-turner.md) and [ADR-005](./adr/005-cancel-abort-and-dispose.md).

### Durable Execution

**Status:** Agreed as a concept; package boundary provisional

A bounded recoverable computation with an input, active state, effects or child executions, and one terminal outcome.

A Durable Execution is not necessarily the lifetime of a Conversation. In chat, one Turn is the candidate root Durable Execution boundary. One Durable Execution may pass through multiple Quiescent Checkpoints and, where a driver supports portable continuations, multiple replay-bounded Execution Segments without creating another human-facing Turn.

### Effect

**Status:** Established

One declared nondeterministic operation proposed by a durable program and resolved through an authority-accepted terminal outcome.

Examples include model invocation, ordinary tool invocation, sleep, or a request to start child work.

### Durable Effect

**Status:** Agreed as a concept; package boundary provisional

An Effect whose authorization and terminal outcome participate in durable recovery. Recovery reuses an accepted terminal outcome rather than repeating completed nondeterministic work.

### Tool Execution

**Status:** Agreed

Execution of a tool operation.

An ordinary Tool Execution may be a leaf Durable Effect with one terminal outcome. A tool that can park, elicit, spawn work, or survive host replacement is a Child Execution with its own active state.

### Child Execution

**Status:** Agreed

A recoverable branch started and structurally owned by a parent Durable Execution. It has its own identity, active state, placement, and terminal outcome while remaining part of the parent's Structured Execution Tree and consistency boundary unless an explicit detached-execution contract says otherwise.

The authority atomically records child completion, resolves the waiting parent pull, marks the parent runnable, and replaces detailed child state with a compact terminal representation. A parent requires the accepted terminal outcome, not the child's complete internal recovery history.

### Parked

**Status:** Agreed

The state of one nonterminal program branch that is waiting on an authority-recorded input or outcome. A parked branch has no active computation to abort. Logical Cancellation marks it runnable and supplies cancellation through a later crank.

A parked branch does not imply that its complete execution tree is quiescent. Siblings, children, or Host-owned effects may still be advancing.

### Quiescent Cut

**Status:** Agreed

An authority-established durable frontier at which every nonterminal branch in an execution tree is parked on authority-recorded input, no accepted resolution remains immediately runnable, every terminal child outcome required by a parent is incorporated or durably preserved, and no Host-owned work remains in flight.

Operational quiescence is established by the Effection scope tree having parked or joined all Host-owned branches and effects. The Host may then propose durable quiescence. Only the Journal Authority can establish a Quiescent Cut under an exact state revision and activation fence. Neither operational nor durable quiescence substitutes for the other.

### Quiescent Checkpoint

**Status:** Agreed

An automatically authority-committed checkpoint at a Quiescent Cut. It contains the active task topology, pending inputs, terminal outcomes still required by parents, exact integrity frontier, and driver recovery material required to reconstruct the execution.

A Quiescent Checkpoint permits raw pre-checkpoint authority mechanics to be archived or deleted from the hot path. It does not necessarily eliminate replay of accepted program actions.

### Recovery Checkpoint

**Status:** Agreed

A Quiescent Checkpoint containing a compact per-task replay tape and parked frontier sufficient to reconstruct fresh program attachments without scanning complete Session History or raw pre-checkpoint authority records.

A Recovery Checkpoint bounds recovery to the active execution topology and compact accepted actions. A local JavaScript generator may still need to consume that replay tape to reconstruct its continuation.

### Continuation Checkpoint

**Status:** Provisional

A stronger, driver-provided checkpoint containing a portable serialized continuation. It allows recovery without replaying accepted actions before the checkpoint.

Arbitrary JavaScript generator stacks cannot provide this automatically. Compiled state machines, provider-durable runtimes, explicit chat state machines, or checkpoint-capable sandboxes may support it.

### Execution Segment

**Status:** Provisional

A replay-bounded epoch within one logical Durable Execution. A Continuation Checkpoint may end one Execution Segment and begin another without ending the Durable Execution or creating a new human-facing Turn.

### Terminal Outcome

**Status:** Established

The canonical accepted result of an Effect or Durable Execution. It may represent success, application failure, cancellation, or another explicitly modeled terminal disposition.

A Terminal Outcome is correctness data and must not exist only in a lossy user-facing projection.

### Terminal Capsule

**Status:** Provisional

A bounded authoritative record replacing the detailed active state of a terminal Durable Execution. It retains the execution identity, canonical Terminal Outcome, parent relationship, and other bounded evidence required for idempotency and recovery. Integrity metadata is included only where the relevant boundary requires it.

The exact name and required fields remain open.

### Terminal Folding

**Status:** Agreed as a lifecycle; exact protocol provisional

The process by which a terminal execution:

1. replaces detailed hot recovery state with a bounded terminal record; and
2. projects user-meaningful facts into long-lived Session History.

Terminal Folding does not mean copying every internal authority record into Session History.

### Execution Terminality

**Status:** Agreed

The point at which a Durable Execution's canonical Terminal Outcome is authority-committed and will not be re-executed. Execution Terminality protects correctness but does not by itself prove that the outcome is visible in Session History.

### Turn Publication

**Status:** Agreed

The point at which the Session Head has atomically advanced to a History Pointer whose committed projection includes the Turn's terminal result.

Execution Terminality and Turn Publication are separate durable transitions. On the normal path, the Turn's structured scope owns publication and waits for it before reporting the Turn as published and closing the final response. If Catastrophic Host Loss occurs after Execution Terminality but before Turn Publication, a replacement projector may complete publication from durable terminal state without rerunning model, tool, or child work.

### Terminal Unpublished

**Status:** Agreed as a state; exact representation provisional

A recoverable state in which a Turn's root Durable Execution is terminal but its authority-accepted Projection Facts have not yet been committed through the Session Head. It is publication work, not runnable agent work. Publication recovery consumes the explicit Projection Facts and does not inspect private execution-journal mechanics.

## Hot path, history, and audit

### Hot Path

**Status:** Agreed

The state and operations required to advance or recover currently executing work. Hot-path cost should be bounded by the active Durable Execution or execution segment, not by the lifetime of its Session.

### Replay Tape

**Status:** Provisional

The minimal ordered sequence of accepted operation outcomes and emission acknowledgements required to reconstruct a fresh ProgramDriver attachment up to a parked frontier.

A Replay Tape is correctness data for an active execution. It is not Session History or Audit History. It may be stored in immutable chunks and referenced by the Execution Tree Snapshot so each authority mutation does not rewrite the complete tape.

### Execution Journal

**Status:** Agreed at the conceptual level; exact representation provisional

The hot recovery record for an active Durable Execution. It contains the facts needed to recover and advance that execution under host replacement.

An Execution Journal is not the long-lived user-facing Session History. At a Quiescent Cut, its recovery-relevant state may be materialized as a Quiescent Checkpoint so recovery does not scan raw pre-checkpoint records.

### Session History

**Status:** Agreed

The durable, readable projection used for scrolling, hydration, and presentation of completed work in a Session.

Session History contains domain-meaningful entries such as messages, tool summaries, elicitation exchanges, errors, and terminal results. It excludes authority mechanics such as lease renewal, stale-host fencing, restore-ticket issuance, and effect-reservation internals.

Session History is a read model. Correctness-critical full outcomes remain in execution state or terminal records.

### Projection Fact

**Status:** Agreed

An explicit bounded-context semantic fact proposed by the Host and ordered and accepted by the Journal Authority for downstream read-model projection. Examples include an accepted user message, completed tool summary, completed elicitation, terminal assistant response, or Turn failure.

Projection Facts are not inferred by scraping internal authority records. The generic durable layer owns their ordered emission envelope and acceptance frontier; chat, A2A, and tool domains own their payload meanings and schemas.

### History Projection

**Status:** Agreed

A deterministic mapping from authority-accepted Projection Facts to domain-specific Session History entries. Internal execution and persistence records are private and are never the Session History source contract.

Projection ownership belongs to the bounded context. Chat, A2A, and tool sessions may share history storage mechanics without sharing one semantic entry union.

History Projection is idempotent and recoverable. A projector writes immutable history content before compare-and-swap advancing the Session Head. Failure after terminal execution commit cannot cause agent work to repeat.

### History Segment

**Status:** Provisional

An immutable physical storage or pagination chunk containing one or more Session History entries.

A Turn is a semantic folding boundary. A History Segment is a physical storage boundary. They need not be one-to-one.

### History Pointer

**Status:** Provisional

A durable reference to an immutable committed Session History frontier, potentially containing a segment identifier and position. It may also carry integrity evidence where the storage or trust boundary requires it.

### Session Head

**Status:** Provisional

A small mutable, compare-and-swap-controlled record that points to a Session's committed History Pointer and its currently active root execution, if any.

Proposed shape:

```ts
interface SessionHead {
  sessionId: string;
  revision: number;
  historyHead: HistoryPointer | null;
  activeExecutionId: string | null;
}
```

### Live Projection

**Status:** Established

Transient or retained user-experience output produced while an execution remains active, such as model token deltas. The UI may combine committed Session History with a Live Projection for the active Turn.

Live Projection is not a replay input. See [ADR-002](./adr/002-one-host-owned-reconnect-log.md).

### Audit History

**Status:** Agreed as a separate concern; retention policy provisional

Detailed historical information useful for diagnostics, compliance, or observability but unnecessary for execution recovery or ordinary Session reading.

Audit History may retain internal branch and authority events after Terminal Folding. It must not remain on the hot replay path solely because it may be useful for debugging.

## Internal-cycle language

The following terms must not be used as synonyms for `Turn`:

- model turn;
- tool turn;
- LLM turn;
- reasoning turn.

Use `Agent Step`, `Model Invocation`, `Tool Execution`, or `Child Execution` as appropriate.

## Runtime mechanism taxonomy

Every effectful boundary is classified as a Coroutine, Stream, Signal, or access to Durable State. These mechanisms must not be disguised as one another.

### Coroutine

**Status:** Agreed

One structured computation with one terminal result or error, represented by an Effection `Operation<T>`. Coroutines inherit parent cancellation, own child lifetimes, and run finalizers during normal completion, Expected Failure, Logical Cancellation, and Graceful Host Shutdown.

A durable program is a Coroutine whose accepted progress can be reconstructed through ProgramDriver replay or checkpoint semantics.

### Stream

**Status:** Agreed

An ordered, demand-pulled sequence of values over time. Streams provide visible backpressure and use explicit cursors or LSNs when retained.

Examples include model token chunks, AG-UI events, replay-entry sources, retained response buffers, and paginated Session History. A Stream does not create a second crank or hide an autonomous producer queue.

### Signal

**Status:** Agreed

An ephemeral notification that authoritative state may have changed. A Signal is a wakeup optimization, not the only carrier of correctness data. After waking, a consumer rereads Durable State by revision or cursor.

Signals may be duplicated, coalesced, or arrive before a waiter starts. Accepted work remains discoverable from Durable State even if an ephemeral Signal is lost.

### Durable State

**Status:** Agreed

Authority-committed data that answers what is currently true, what was accepted, what is runnable, and which outcome replay must receive.

Execution Tree Snapshots, Replay Tapes, Terminal Capsules, Projection Facts, Session Heads, and Session History are forms of Durable State with different lifecycle and retention responsibilities.

Coroutines change Durable State through Dynamic APIs. Streams expose ordered projections of it. Signals notify consumers to reread it.

### Mechanism selection rule

**Status:** Agreed

- Use `Operation<T>` for one structured result.
- Use a Stream or explicit cursor/subscription for ordered values over time.
- Use a Signal only as a wakeup followed by an authoritative reread.
- Place correctness facts behind authority-controlled Durable State rather than callbacks, event emitters, queues, or in-memory notifications.

Sweatpants does not wrap Effection primitives merely to rename them. A Sweatpants abstraction is justified only when it adds durable replay, checkpoint, retention, authority, or domain semantics.

## Effection architecture language

### Operation

**Status:** Established

The only authored abstraction for effectful or suspending work. Effectful Sweatpants ports return Effection `Operation<T>` values so cancellation, errors, resource cleanup, and shutdown remain owned by a structured scope.

Promises are permitted only at unavoidable external library boundaries and are immediately adopted into the owning Effection scope. They are not the framework's port or domain-service model.

### Dynamic API

**Status:** Agreed

A proxiable API created with Effection's `createApi`. Dynamic APIs are the primary public surface for effectful framework capabilities such as program driving, Journal Authority operations, durable effects, execution storage, history storage, and Turn publication.

Callers invoke scoped operations, for example `yield* JournalAuthority.operations.reserve(request)`, rather than receiving and passing service objects.

### Port

**Status:** Agreed

One effectful boundary declared once with `definePort`, whose declaration is simultaneously the contract type, the runtime operation list, and the fail-closed default when nothing is installed.

A Port is a module-level identity with a per-scope implementation. It exports no Context, so callers cannot reach around the seam to an installed Driver; the only entry point is `installDriver`. Ports are the standard shape for Execution Store, Conversation Store, tool-session storage, and other infrastructure boundaries.

```ts
export const ExecutionStorePort = definePort<ExecutionStore>("execution-store", {
  *loadControl(_executionId) { return unavailable(); },
  // ...
});
```

A Port is not a singleton instance. It holds no mutable state, and two scopes may resolve two different Drivers concurrently.

A Port member's return type determines what Middleware may do to it, because Middleware inherits that type. `Operation<T>` admits effectful Middleware; a plain `T` admits only synchronous Middleware and permanently excludes latency, fault-injection, deadline, and authority interception. Call sites cannot observe the difference, so the choice is invisible until someone needs to intercept the seam.

Default to `Operation<T>`. Choose a synchronous member when "this must never become effectful" is the intended invariant, and record that intent at the declaration.

### Driver

**Status:** Agreed

A concrete adapter implementing a Port's contract at an infrastructure boundary: memory, Redis, remote HTTP, Cloudflare, or a test double. Driver operations return Operations and inherit the caller's cancellation and lifetime.

A Driver owns persistence or transport mechanics only. It never decides domain transition validity, retry safety, or quiescence. Drivers install as the innermost link of a Port, so policy and observation Middleware always surround them.

Redis, memory, remote HTTP, and Cloudflare implementations are Drivers or API proxies, never Promise-returning repositories. This term replaces the earlier "Scoped Driver", which described the same concept when installation was done directly through Context.

### Store

**Status:** Agreed

A Port whose responsibility is durable persistence of one record family, named for what it stores rather than how: Execution Store, History Store, tool-session store.

Stores are deliberately narrow. Execution Store persists execution control records, immutable payloads, and replay material. History Store persists Session Heads, immutable History Segments, and cursors. A Store never interprets domain semantics of the records it holds.

### Scope

**Status:** Established

An Effection lifetime that owns tasks, resources, finalizers, Context values, and installed Port Drivers and Middleware.

Scope is the unit of ownership and teardown. Installations are inherited by child scopes, may be shadowed by a child, are isolated between concurrent siblings, and disappear when the installing scope exits. Structured cleanup, graceful shutdown, and cancellation are expressed through Scope rather than detached background tasks.

### Middleware

**Status:** Established

Scope-local composition around Dynamic API or Port operations. Middleware may provide tracing, metrics, logging, fault injection, deadlines, routing, remote proxying, and test substitution.

Middleware installs at `max` by default and therefore surrounds Drivers, which install at `min`. Installation order between Middleware and Driver does not matter; ordering between Middleware layers does.

Fundamental durability invariants such as activation fencing, capability validation, retry safety, parent/child atomicity, transition validity, and quiescence verification remain in the mandatory domain/authority path. They must not disappear when optional middleware is absent.

### Naming rule: define, create, install, use

**Status:** Agreed

- `define*` declares an immutable module-level contract evaluated once, carrying identity but no mutable state: `definePort`, `defineDurableEffect`, `defineDurableProgramManifest`.
- `create*` constructs a new runtime instance with its own state and lifetime, callable many times: `createMemoryExecutionStore`, `createToolSessionRegistry`, `createChannel`.
- `install*` binds an implementation or Middleware into the current Scope and lasts exactly as long as that Scope: `installDriver`, `installExecutionStore`, `installStorageMetrics`.
- `use*` reads a scoped capability inside an Operation: `useScope`, `useJournalAuthority`.

If calling it twice produces two independent stateful things, it is `create*`. If calling it twice is meaningless because it declares one thing, it is `define*`. If its effect ends when a Scope exits, it is `install*`.

### Pure Domain Transition

**Status:** Agreed

A synchronous deterministic transformation of an Execution Tree Snapshot and explicit command inputs into a decision containing next state, result, private records, and Projection Facts. It performs no I/O and requires neither Promise nor Operation.

## Provisional architectural responsibility split

This split is directionally agreed but has not yet been approved as a package design:

```text
Durable Execution Model
  decides valid domain transitions

Journal Authority Dynamic API
  serializes and atomically commits domain transitions through Operations

Execution Store Port / Driver
  persists versioned state without owning domain policy

History Projector
  derives bounded-context Session History

History Store Port / Driver
  persists immutable history segments and supports pagination through Operations
```

Candidate package names remain provisional:

```text
@sweatpants/durable-effects
@sweatpants/durable-execution
@sweatpants/journal-authority
@sweatpants/history-store
```

`Durability` currently names the umbrella capability rather than a package.

## Open questions

1. What exact state must a Terminal Capsule retain, and for how long?
2. Which ProgramDriver implementations can supply Continuation Checkpoints, and what portable contract proves them?
3. Which pending remote effects are compatible with a Quiescent Cut, and what durable late-resolution capability do they require?
4. Which Journal Authority responsibilities are domain decisions versus transaction and persistence coordination?
5. Which audit details, if any, require long-term retention?
6. Should `Agent Step` be the canonical name for one internal model-led cycle?
7. What bounded grace policy governs Graceful Host Shutdown before it degrades into Catastrophic Host Loss semantics?

## Change discipline

- Add a term when design discussion first depends on a shared meaning.
- Mark it **Provisional** until explicitly aligned.
- Promote it to **Agreed** when the participants align on its meaning.
- Link accepted architectural decisions rather than duplicating incompatible definitions here.
- When implementation names disagree with this glossary, record the mismatch during migration; do not silently redefine the domain term to match legacy code.
