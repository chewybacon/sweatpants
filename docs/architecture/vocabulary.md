# Vocabulary — Post-Cutover Language

> **Design-authority notice:** The approved [durable execution spine design](../../../.pi/specs/durable-execution-spine-design.md) is normative for Venue, Step, attribution, replay, peer strands, Mandate, R7′, and the `ephemeral` rename. Conflicting entries below are superseded rather than alternate current definitions.

**Status:** Draft for adoption
**Supersedes:** conflicting entries in `docs/domain-glossary.md` (see Stale-doc register)
**Companion:** [responsibility-map.md](./responsibility-map.md)

## Ledger

**Ratified:** R1′–R6′ · strand · fork group · durability class ·
evidence-not-recipe · notify/log ruling · delivery contract.

**Proposed:** R7′ structure-vs-order · leaf · venue · live-edge handoff
name · attribution-chain placement · delegated-audience transcoding ·
fork-group expiry values · driver→evaluator rename.

One concept, one word. If a noun needs an adjective to be understood in this
codebase, the noun is wrong. This document defines the words the system is
allowed to use, states each concept's function and lifetime, and lists the
collisions phase-one renames must resolve.

## The system in two sentences

> Within a **session**, Authority **leases** each **task** — grouped into
> **turns** — to one **activation** at a time.
>
> Every interaction is **reserved** before it proceeds — replayed from
> history, authorized, or parked — and **handlers** perform pulls and
> **effects** whose **resolutions** become journal records, spending
> **capabilities** addressed to their **audience**; **emissions** leave in
> parallel, offset-stamped; parked interactions await **settlement** from
> outside.

Every named concept has exactly one owner and one lifetime. Words absent from
these sentences (program, workflow, placement, attachment, exchange, kind,
port, driver, tree, runtime, registration, handler, context, conversation)
describe artifacts, forms, transports, conventions, composition, or product —
they do not act.

## Definitions

### Product and tenancy

**conversation** — The product-level thread: participants, visible history,
its own authority projection (`ConversationHead`: idle/active,
`activeLogicalTurnId`, `activeExecutionId`, revision). Owns *admission* — who
may start an execution on this thread. Not a nickname for session; see open
question 1.

**session** — The outermost durable scope; owner of the journal namespace.
Every authority query takes `sessionId`; storage, turns, tasks, and pulls all
live inside one. Nothing durable crosses sessions.

**turn** — Grouping of tasks inside a session: one conversational exchange,
one root task, its invoked children (`turn-0/root`). The kernel treats turns
as immutable task attributes and rejects operations naming a foreign turn.
Partitioning, not machinery.

### Durable truth

**Authority (kernel)** — The validator and sole mutator of durable journal
state. Decision pipeline, commit loop, execution forest. Host layers speak to
it through narrow ports; nothing else writes history. "Kernel" is its
adjectival form (kernel policy, kernel invariant): inside, invariants hold by
construction; outside, only capabilities grant anything.

**task** — The durable unit of execution: one pinned program bound to one
input inside a session, carrying `taskId`. Tasks form an execution **forest**
per session. The thing that has history: attachments and activations die
constantly; the record sequence is where progress lives.

**journal** — The append-only, ordered record sequence of a session — the
artifact every other word serves. Offsets order it; snapshots serialize it;
replay walks it; boundaries protect it (`AuthorityJournalContract`).

**replay** — Reconstructing execution by walking journal records instead of
re-running code: a fresh attachment starts each activation and is fed settled
outcomes until it reaches the live frontier. Strict replay is a manifest
capability flag; divergence is an invariant breach, not a retry.

**attempt** — One try of one reserved operation within an activation:
`attemptId`/`attemptIndex`, lifecycle `started → completed` with `detached`,
`revoked`, `superseded` as exits. Cancellation detaches attempts rather than
pretending they never ran.

**receipt** — Kernel-issued proof token for a committed action:
`ResolutionReceipt` (offset + outcomeDigest), `EmissionReceipt` (offset).
Carried back into resume/acknowledge commands so progress claims are
evidence-backed, never asserted.

**record** — One committed semantic fact in the journal (pull lifecycle,
emission, closure). Replay is walking records; attempts re-execute only what
records do not yet cover.

**transition** — `KernelTransition {state, entries, result}`: one validated
application of a command, expressed as data. Deciding is separated from
committing — the decision core produces transitions purely; the commit loop
applies them. This is why kernel behavior is testable as data.

**decision stage** — One of five named checkpoints each authority command
passes through (`decision-diagnostics`, `semantic-consistency`,
`structural-validation`, `common-idempotency`, `exhaustive-dispatcher`),
with enter/complete/reject diagnostics per stage. No rejection is anonymous:
the journal can always say which stage refused and why.

**command / query** — The kernel's two input paths, split on the contract:
`command<C>` changes state (typed `AuthorityCommand` union, proof-carrying,
entering through decision stages, producing transitions); `query<Q>` reads
(`pull.state`, `task.input`, `cancellation-state`). Everything any host can
do to durable state is one of these typed commands — no side doors.

**snapshot** — Kernel state as verifiable data. Whole-state:
`DurableAuthoritySnapshot`, parsed and verified (chain, indexes, semantic
consistency) before a restored process trusts it. Encoding sense:
`canonicalSnapshot` — hash-stable canonical JSON underlying digests.
State you can check instead of state you must believe.

**boundary** — Dependency rules with a test attached: package-boundary tests
(forbid journal-authority depending on hosts/tool-runtimes/transports),
module-graph layering, leaf-module import direction. A boundary that fails
nothing when crossed was a suggestion. Trust boundary: where untrusted input
crosses and is projected, never accepted raw (e.g. sandbox affinity).

### Execution lifecycle

**lease** *(adopted; code currently says Activation)* — Kernel-granted,
time-bounded ownership of executing one task epoch: claim / renew / release,
holder + duration, fenced by epoch and `notBefore`. Exclusivity and recovery.
The kernel side already behaves as a lease (`releaseReason: "lease_lost"`).

**activation** — One attempt to drive one attached task to park-or-terminal.
Ends at the first park or terminal event; cheap to create, expected to die.
Distinct from lease: the lease spans cancellation windows; an activation is
one exercise of it.

**attachment** — One live execution session bound to one task epoch:
`AttachProgramRequest` (full identity) → `ProgramAttachment` (runtime-only
handle, MUST NOT enter durable JSON). Replay is not resumption — it is a
fresh attachment walking settled history.

**placement** — Where-and-under-what-identity: program pin + route +
evaluator kind + epoch, fixed when an attachment binds. Fencing evidence:
settlement must prove it belongs to the activation that proposed the park.
Constructed once at bind time; never derived at use sites (current bug being
corrected).

**exchange** — One ordered command→event step spoken to a live attachment
(`start`, `resume-record`, `authorize-record`, `ack-emission`, `cancel`).
Single-flight by protocol. In-process transport; `ProgramPeer.operations.step`
is the same conversation over a process-independent wire — identical
semantics, different transports, which is why the two pumps rhyme but never
merge.

**Mandate** — The runtime-only bind envelope authorizing one caught-up task
to cross the live edge: typed address, strand and exact program pin, placement,
attachment identity, fork context, task lease, bound frontier proof, and
program capability. Commands are relative through `ExecutionComposition`;
consumers never reconstruct identity/capability/counter clumps. A Mandate is
issued only by bind CAS and never enters durable JSON or projection.

**reservation** — The kernel's live admission decision on one newly proposed
interaction, with the closed answers `authorized` (proceed with the admitted
attempt) or `pending` (park). Recorded outcomes are replay input and are
unrepresentable at the live edge.

**resolution** — The commit turning a live outcome into history: reserve →
authorize → perform → resolve-pull. After resolution, replays see it; before,
they re-execute. The boundary between attempt and record.

**settlement** — Resolving a parked pull after its owning activation has
ended: look up descriptor, assemble placement-bearing context, perform via
resolver, commit through resolve-pull. The return path of parking — how
participants, clocks, finished children, and model-runtime talk back.
Distinct from the tree-level reactivation policy (`WorkflowTreeHost.settle`),
which consumes settlements and should be renamed `onPark`.

**disposition** — Declared ending-classification supplied by an owner:
`setDisposition(reason)` on the attachment handle (how the attachment ended,
read by scope teardown) and interaction dispositions (`ModelSampleDisposition`,
`EphemeralToolDisposition`). Three-way distinction to preserve: outcome = what
the program produced; disposition = how the attempt ended, declared by its
owner; release reason = why the lease freed. Values overlap; declarer and
subject differ.

**park** — Suspension state and act: `{ state: "parked", reason, pullId }`,
reasons drawn only from pull kinds allowed to wait (elicit, wait, child,
ephemeral, sample). Normal control flow, not failure. Reason set stays closed.

**execution** *(canonical sense)* — One epoch-numbered attempt window of a
task: the span bounded by lease grant and release within one
`executionEpoch`. Other current senses to retire or rename: the kernel
command namespace (`execution.*` — fine as namespace), the placement side in
host-vs-execution routing (wants its own noun), and `activeExecutionId`
(pending audit against epochs).

**cancellation** — Cooperative durable unwind: request-cancellation →
begin-cancellation-unwind (frontier proof attached) → cancel injected at the
next step boundary → attachment reports `program_cancelled` while pulls sit
in `settling_pull`; live attempts detach, parked history stands. Has its own
spec; never a hard kill.

**fence** — Any mechanism making a stale actor *provably* stale rather than
merely discouraged: epochs on placements, single-use capabilities,
frontier proofs, lease ownership. Fencing is why two activations can race
and only one commits.

**restore / recovery** — Re-establishing an evaluator after process loss:
Authority produces a capability-free forest replay plan; the common replay
walker reconstructs exactly to the planned head; advancement policy selects a
prepared target; bind CAS issues a Mandate. Diverged replay is terminal and
stale prepared state is discarded and replanned.

### Security grammar

**capability** — Unforgeable opaque token Authority mints to authorize one
operation: the program capability carried only inside a Mandate and the
`resolutionCapability` minted at reserve and spent at settlement.
Hosts cannot do what they were not granted; grants are single-use, journaled.

**audience** — The addressing half of the grammar: who must be spending.
Every ResolutionAuthority variant carries one; every resolve declares one.
Fixed society: `workflow-host`, `program-host`, `host-effects`,
`program-execution`, `model-runtime`, `scheduler`, `mutator`. Currently
free-form strings — typing it closed is a phase-one candidate.

**keyring** — `CapabilityKeyring`: the signing and verification material the
capability grammar runs on; `verifyResolutionCapability` checks capability
against declared audience before any settlement commits. Unforgeable is a
cryptographic property here, not an aspiration.

**digest** — Hash-stable content identity, computed over canonical JSON:
pins programs (`{id, version, digest}`), binds outcomes and frontiers,
anchors receipts. Equality by digest means equality of bytes, always.

**participant** — An external actor — usually a human — settling an
interaction from outside the system: holds a participant resolution authority
plus capability, answers elicitations through settlement. The reason parks
dare to end activations.

### Interactions

**pull** — The single parked-interaction primitive: authored programs propose
typed descriptors; registries hold policies; resolvers settle them. Kind
taxonomy lives under pull (elicit, wait, sample, ephemeral, invoke, effect).

**effect** — Named, versioned, schema-described side effect (`name@version`,
input/output schemas, cancellation partial, retrySafety). Attempt → outcome →
record; replay returns the record. Two transports (installed inline, routed
host-vs-execution), one concept.

**emission** — Durable fire-and-forget output: propose → append (receipt
carries offset) → acknowledge. Offset is proof of order. Never parks anyone;
flows one way. Gated by manifest `durableEmissions`.

**kind** — Tagging convention, not a domain concept. Several taxonomies share
the field name: pull kinds, semantic-record payload types, commands,
transport labels. Fine inside a union; abuse is cross-taxonomy reconciliation
(`route["driverKind"] ?? route["kind"]` merges two vocabularies with a
runtime fallback).

**resolver** — The host-registered policy object that settles one parked
pull kind (`PullResolver`: `audience()` + `perform()`). Impostors to purge:
the `resolver: {audience, route}` argument on `context.effect` is routing
metadata, not a resolver — rename to route/placement; `TrackedResolver`
attachment internals are private and may stay.

**native tool** — A tool whose body is an authored durable program behind a
tool surface; routed to evaluators through configured driver bindings.

**ephemeral tool** — A protocol-unaware external tool invoked as a live,
session-bound call: host retains authority, journals the exchange under a
canonical `invocationId`, exposes only `ephemeral_handle` references — lost
references retain the historical error literal `foreign_reference_lost` and
never dangle. `foreign` remains a read-only legacy descriptor spelling.

**projection** — Deriving public views from journal records without mutating
them: `projectRecords`, `projectExecutionForest`; the chat engine's entire
job. Projections are functions of history — recomputable, never authoritative.

### Artifacts and form

**program** — Authored durable code plus contract, pinned by
`{id, version, digest}`. Pure data. The unit of authoring and reuse; children
invoke programs, not attachments.

**workflow** — `Workflow<T>`: the Effection generator type authored program
bodies are written as. Reserved meaning; the phrase "workflow runtime"
should retire to "the runtime," and the route literal `driverKind: "workflow"`
should become a local/in-process evaluator kind.

**manifest** — A pinned program's declared contract in pure data: I/O
schemas, elicits, effects table, typed pull contracts, capability flags.
Machine-checkable without executing code; registries validate against it;
child manifests resolve without weakening exact identity.

**descriptor** — Serializable proposal for one interaction/output before
authorization (`DurableOperationDescriptor`, `EmissionDescriptor`,
`EffectDescriptor`). The unit raw-input journaling protects: journaled
verbatim, no enrichment. Descriptors are what records remember; steps are
how they traveled.

**affinity** — `SandboxAffinity {kind: invocation|conversation|workspace,
key}`: deployment-approved opaque binding deciding which sandbox serves
this work, projected only by trust-boundary drivers. Reuse policy as data.

### Composition and transport

**registration** — Composition-time binding of declared contract to live
implementation: effect registrations `{definition, handler}` installed on the
runtime port; pull-kind policies registered kernel-side; resolvers into the
registry. Happens once, before any attachment, never mutates mid-task.

**handler** — Process-local executable half of a declared operation body
(effect handler, tool handler); `HandlerContext` is its window onto the world.
Server entry points are endpoints, not handlers.

**driver** — The passive evaluator transport per ADR-001: advances only when
stepped. Contract: attach/restore/step/close. Impostors to purge: scenario
drivers (→ harnesses), `driverKind` string literals (→ typed evaluator kind).

**transport** — What carries the attachment conversation between drive and
evaluator compute. Fails independently of program semantics:
`transport_lost` is its own shutdown reason. Local exchange vs peer wire.

**protocol** — Grammar two parties honor across a boundary (shape +
ordering): ProgramPeer protocol, attachment-handle protocol, promoted proof
protocol. Protocol = grammar; transport = carrier; exchange = one utterance.

**frontier** — Provable replay position of an execution: which steps a
restored evaluator's state demonstrably contains, bound by digest and proof
(`RestoredFrontierProof`, `bind-frontier`). Makes fenced restore verifiable;
divergence rejects (`replay_diverged`, `restore_stale`).

**bridge** — Live-stream carriage across boundaries with enforced
backpressure (`stream-bridge` package). Moves untyped flowing data;
transports move protocol messages.

**pipeline** — Ordered-stage processing. Kernel sense: the decision pipeline
turning `AuthorityCommand` into `KernelTransition` with stage diagnostics.
Chat-client sense: UI frame pipelines. Different packages, noted collision.

**tree / forest** — Tree: one root task plus descendants via child modes
(invoke/all/race/spawn/join). Forest: all trees in a session, persisted by
the kernel. Children are topology, never transport.

**strand** *(adopted)* — One task's own record subsequence within the session
journal: taskId-partitioned, offset-ordered, replayed as a unit. Strands
never interleave contents; forest edges cross between them only as
descriptors and receipts.

**durability class** *(adopted; extends the existing `DurableTool.durability`
literal)* — Whether a child's continuation state is owned by the host strand
(`crank_native`) or by an external process (`peer_hosted`). Declared on
descriptors. Governs replay semantics (recipe versus log), park economics
(free versus rent), and loss handling (cold-walk versus errored outcome).
See R6′.

**fork group** *(ratified rule, shape in spine-types)* — The set of peers opened
by one suspension point (invoke/all/race). Ancestors freeze until the group
settles; members run as roots under the same rules. Failure propagation
between members is a declared `SupervisionStrategy` (β import — see
spine-types §0); deadlines give R5′ its teeth.

**leaf** *(candidate)* — An open strand's advancing tip: frontier plus any
open slot. Candidate because "head" is taken — `journalHead`/`journalHead`
Digest` mean the written tip of the spool, a different position.

**attribution chain** *(candidate)* — Delegation path carried on descriptors
raised inside a fork group, letting projections attribute questions to the
peer that raised them. Decided at proposal time, journaled verbatim.

**port** — Foundation seam mechanism: `definePort(name, declaration)`; calls
resolve implementations by walking up the Effection scope tree at call time
(substitutable, observable, fail-closed). `Port.bind(scope)` pins dispatch to
a named scope — the documented escape hatch. Instances: JournalAuthorityPort,
InstalledEffectPort.

**runtime** — Rationed to two earners: the workflow runtime (attachment
machinery + drives) and the durable-execution crank machinery. All other
`*-runtime` files should take their domain noun.

**crank** — The demand-pull discipline from ADR-001: exactly one component
turns the crank (consumes steps eagerly); everything below is demand-pulled.
Embodied today by the drives. Also the error brand (`CrankError`, `CrankCode`)
and durability marker (`crank_native`). Never a generic word for "loop."

**evaluator** — The deployment-side compute executing an attachment under
lease and fencing inside a placement: local, worker, agentcore. Informal
today (no contract bears the name); driver is the protocol, evaluator the
far side running it.

**invocation** — Tool-land's ephemeral unit: one call of a tool or foreign
operation, identified by `invocationId`, hosted via `ToolInvocationHost`;
affinity kind `"invocation"` binds a sandbox to exactly one call. Dies with
its transport request; survives only as records.

**step** — `ProgramStep`: the passive machine's state after applying one
command — `operation`, `emission`, `completed`, `failed`. Command-in,
step-out is the whole driver protocol grammar. Steps are proposals until
Authority commits them; replay frontiers are built from steps. Attempt-space
counterpart of the record.

### Composition pipeline

Four stages, four words, no overlap:

1. **authoring** declares contracts (manifests, effect definitions,
   descriptors).
2. **registration** binds declaration to live implementation
   (`{definition, handler}`, kind policies, resolvers).
3. **installation** mounts registrations onto a live port for a session/task
   (`installEffectRegistrations` → `InstalledEffectPort.installDriver`,
   `journal.install`). Happens before any attachment, never mid-task.
4. **execution** — handlers run when Authority authorizes.

Preceding all four:

0. **shell** — A complete named instantiation of the kernel's contract stack
   `{authority, journal, snapshot}`: `createInMemoryShellDrivers` (decisions
   applied directly to cloned state) and `createStoredShellDrivers`
   (commit-loop over segmented storage, snapshots verified on load). Same
   semantics, different state strategy — they must differ in nothing else,
   so the current wiring duplication between them is a convicted seam.
   Naming wart: the `...ShellDrivers` names use the driver impostor;
   `createInMemoryShell` says it exactly.

**scope** — Effection structured-concurrency lifetime container. Drives own
scopes; scopes guarantee teardown of process-side resources. Reserve the word
for Effection; tenancy fields like `scopeOwnerId` need their own noun.

**context** — Window onto a world, always paired with whose: program context
(authoring surface), resolution context (settle-site evidence bundle),
handler context, Effection framework contexts. `ModelContext` is product
vocabulary (LLM payload) and unrelated despite the suffix.

**drive** — Verb-family for the activation pumps: `driveActivation` (local),
`driveProgramDriverActivation` (remote evaluator), `driveWorkflowTree` (child
topology recursion). Candidates to unify under the Activation contract.

## Collision table

| Word | Roles today | Resolution |
|---|---|---|
| activation | kernel lease family + workflow attempt | kernel family renames to Lease (TS symbols only; snapshot field `activationLease` stays) |
| host | six unrelated roles | abolished: AuthorityPort, SessionRuntime (pending open question 1), EffectRouter, RootScope, createJournalSamplingService |
| driver | transport contract + test scaffolding + route strings | keep contract per ADR-001 or rename via superseding ADR; purge impostors either way |
| kind | several tag taxonomies + cross-taxonomy fallbacks | keep in unions; Route gets one owned `evaluatorKind` discriminant |
| turn | journal task grouping + conversation logical turn | prove equality in types/decisions or rename one |
| resolver | settle-policy object + exchange continuation + routing metadata | keep sense 1; rename effect-routing arg to route/placement; TrackedResolver private, fine |
| scope | Effection lifetime container + storage tenancy fields | reserve for Effection; `scopeOwnerId` renames to tenancy/owner id |
| execution | epoch window + activeExecutionId + command namespace + placement side | keep epoch-window sense canonical; namespace fine; placement side renames; audit activeExecutionId |
| head | journal written tip (`journalHead*`) vs proposed strand-tip-with-slots | reserve for journal tips; adopt **leaf** for open strand tips |

## Rename map (phase one)

1. `Claim/Renew/ReleaseActivation*`, `ActivationLeaseState` → Lease family.
   Snapshot schema fields unchanged — zero migrations, one documented wart.
2. Host-role renames (table above).
3. Route grows `evaluatorKind`; delete three copies of `routeDriverKind` and
   six-plus `"workflow"`/`"program"` literals.
4. Scenario/shell drivers → harnesses.
5. Audience union type (closed set).
6. `WorkflowTreeHost.settle` → `onPark`.
7. Effect-routing `resolver` argument → `route`/`placement` naming.
8. Driver→Evaluator: blocked pending ADR supersession decision.
9. **Mandate landed:** bind-time CAS now issues the placement, capability,
   typed address, lease, fork context, and frontier proof behind relative live
   commands. ReplayItems carry none of these live rights.

Each rename is mechanical and gate-checkable. Structure work (Activation
contract lift, placement binding, settlement-observation seam) follows after
vocabulary lands, measured against responsibility-map baselines.

## Open questions

1. **session ↔ conversation cardinality** — enforced 1:1 or current practice?
   Gates the SessionRuntime naming. Fifteen minutes in yo-chat server wiring.
2. **Twin turns** — journal `turnId` vs `activeLogicalTurnId`: equal by
   construction? Say so enforceably, or rename.
3. **Driver→Evaluator** — worth an ADR supersession, or keep driver?
4. **activeExecutionId vs executionEpoch** — conversation-head identity:
   derived from task epochs or a third id? Audit before phase-one renames
   touch execution vocabulary.

## Stale-doc register

Updated by this cutover without doc reconciliation:

- **ADR-001** references `ProgramRuntime.run()` ×4 (deleted). Crank-turner
  principle survives in the drives; needs a superseding note or rewrite.
- **ADR-002** references `ProgramRuntime` ×2.
- **ADR-005** references `ProgramRuntime` ×2.
- **docs/domain-glossary.md** — Host defined as the demand-pulled crank owner
  (pre-cutover sense, dissolved into named roles); `ProgramRuntime` ×1;
  pre-pull interaction vocabulary throughout.

Rule going forward: deleting a symbol named in an Accepted ADR updates the
register in the same change.
