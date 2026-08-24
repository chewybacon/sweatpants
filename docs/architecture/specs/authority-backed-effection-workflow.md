# Authority-Backed Effection Workflow Evidence

## Verdict

**Final production verdict: pass — full cutover complete.**

The authority-backed Effection workflow is the sole production durable runtime. Local workflows, real worker threads, Lambda-style evaluators, and fenced AgentCore transports run through the workflow attachment and explicit ProgramDriver/tree coordinators. Typed pulls, model preparation, host/execution placement, foreign adapter topology, cancellation, replay, and host replacement pass outside-in acceptance.

The migration window is closed. Superseded runtime services, installers, local-driver orchestration, runtime flags, automatic foreign-child factories, deprecated aliases, and comparison legs were physically deleted. The proof material below is retained as chronological evidence; statements that production was deferred are superseded by this verdict.

## Verification Results

All commands ran from `sweatpants/`.

| Command | Result |
| --- | --- |
| `pnpm --filter @sweatpants/journal-authority check` | Pass |
| `pnpm --filter @sweatpants/journal-authority test` | Pass: 23 files, 155 tests |
| `pnpm --filter @sweatpants/journal-authority build` | Pass: ESM and declaration builds |
| `pnpm --filter @sweatpants/durable-chat-runtime test` | Pass: 19 files, 96 tests |
| `pnpm --filter @sweatpants/platform-acceptance test` | Pass: 25 files, 91 tests |
| `pnpm --filter yo-chat test` / `pnpm --filter yo-studio test` | Pass: 43 / 8 tests |
| Workspace recursive checks | Pass: 42 projects |
| Zero-legacy symbol/file scan | Pass: 0 references for deletion manifest |
| `pnpm lint` | Pass: 0 errors |
| Focused type-aware lint on new runtime files | Pass: 0 warnings, 0 errors |
| `git diff --check` and changed-file formatting | Pass |
| `pnpm validate:module-graph` | Pass: 31 packages, no package cycles or architecture violations |
| `pnpm validate:exports` | Pass: 31 package exports validated |
| `pnpm validate:product-surface` | Pass |

The workspace resolves Effection `4.1.0-alpha.9`, TypeScript `5.9.3`, and
Vitest `3.2.4`. The workspace catalog declares Vitest `^3.0.5`.

## Final Implementation

- `workflow/runtime.ts` owns constrained workflows and resource-owned attachment protocol.
- `workflow/host-drive.ts` drives local attachments; `workflow/driver-drive.ts` drives one process-independent evaluator; `workflow/tree-drive.ts` alone owns child topology; `workflow/pull-settlement.ts` owns resolver settlement.
- `createWorkflowProgramDriver` is the evaluator used by worker, Lambda, and AgentCore transports. Explicit `close()` and detached ownership prevent leaked remote attachments.
- `DurableProgramContext.pull` is required. `DurableProgramManifest.pulls` carries named pull schema contracts. SDK sampling/elicitation and the foreign adapter lower onto pulls.
- Model contexts stage before reserve. Pull preparation uses an attachment-epoch owner fence; live pull cancellation aborts provider work; acknowledgement follows accepted settlement.
- The decision core journals the proposed descriptor while retaining accepted policy state privately. Relative waits and sample source recipes therefore remain verbatim in `PullRequested`.
- Deleted files include the superseded runtime/installer, local driver/host, proposal-bridge context, runtime context, automatic foreign-child driver, model-sample effect authoring helpers, and old parity suites. Retained contracts and execution identity have live consumers.

## Gate Results

| Gate | Result | Evidence |
| --- | --- | --- |
| Workflow yield restriction | Pass | Positive fixtures compile; checked negative fixtures reject direct ordinary Operations. |
| Effect compatibility | Pass | Proof effects assign to the pinned Effection `Effect<T>` and run through the stock reducer. |
| Ephemeral rerun boundary | Pass | Focused scenarios rerun ephemeral Operations without proposals or journal entries. |
| Attachment resource ownership | Pass | `resource()` provides a bounded exchange/disposition/close handle while resource-owned Workflow, supervisor, disposer, and attempt Tasks remain active. |
| Context direction | Pass | Resource descendants resolve the runtime; the host caller does not. No `CoroutineView` exists. |
| Buffered typed protocol | Pass | Immediate proposal, distinct proposal/attempt/terminal events, one-shot resolvers, invalid command, and concurrent exchange scenarios pass. |
| Intent before execution | Pass | Both shell modes expose `PullRequested` and `AttemptStarted` before closure entry. |
| Commit before resume | Pass | Both shell modes commit and confirm `PullResolved` before post-record Workflow code. |
| Settled replay suppression | Pass | Fresh attachments replay success without closure execution in memory and stored modes. |
| Error and cancellation outcomes | Pass | Both shells accept record errors; stored mode accepts a canonical cancellation and closes the task as cancelled. |
| Stored CAS reevaluation | Pass | A server-compatible `ExecutionStore` binding forces reservation and resolution conflicts. The real stored shell reevaluates and commits one frontier. |
| Unsafe ambiguity | Pass | Memory and stored modes discard the produced local value and replay only `effect_outcome_indeterminate`. |
| Semantic fold | Pass | Real accepted histories fold; malformed offset history fails; folded state matches the existing forest and public pull/recovery queries. |
| Secret isolation | Pass | Capabilities remain in the host coordinator. Attachment types, events, closure arguments, records, and folded state contain no capability field or live runtime object. |
| Cleanup | Pass | Scope disposal, local cancel, protocol failure, concurrent exchange, replay replacement, and unsafe loss scenarios terminate without pending test work. |
| Production isolation | Pass | Export, product-surface, and module-graph validation pass. Production entry points do not import the proof. |

## Rejection Conditions

| Condition | Present? | Evidence |
| --- | ---: | --- |
| Raw authority driver in Workflow scope | No | Only `runProofRecordWorkflow()` calls the scoped public port facade. |
| Capability material in semantic records or fold | No | Protocol and fold types have no capability field; unsafe sentinel checks pass. |
| Foreign captured Scope exposed to host | No | The handle exposes only `exchange()`, `setDisposition()`, and `close()`; work returns through resource-owned queues. |
| Second production command stack | No | Proof source is imported only by `src/testing.ts`. |
| Production feature selector | No | No flag, route, descriptor, or registry selects the proof. |
| Special Effection reducer behavior | No | The proof uses the pinned `Effect`, `Scope.run()`, `resource()`, Queue, Task, Context, and `withResolvers()` APIs. |

No rejection condition is present.

## Migration Map

The map describes a possible later atomic migration. It is not an approved
implementation plan.

### `packages/durable-execution/src/program-authoring.ts`

| Responsibility | Disposition | Reason |
| --- | --- | --- |
| `DurableProgramFactory` as unrestricted `Operation<T>` | Replace | A cutover would use constrained `Workflow<T>`. |
| Record options, closure, attempt context, and descriptor contracts | Retain | The proof reuses their current identity and retry semantics. |
| Direct ordinary Operation composition | Replace | Ordinary work would require `ephemeral()` or a Workflow-aware extension wrapper. |
| Non-record durable authoring methods | Move later | Every durable method needs an equivalent durable effect before cutover. |

### `packages/durable-execution/src/program-context.ts`

| Responsibility | Disposition | Reason |
| --- | --- | --- |
| `DurableProposalExecutor` suspension bridge | Delete after full cutover | Durable effects enter the scoped attachment runtime directly. |
| `createDurableProgramContext()` proposal wrappers | Replace after full cutover | Workflow authoring functions would create typed effects. |
| Canonical value, inline-size, error serialization, and cancellation helpers | Retain | The proof uses the current validation and public error semantics. |
| Nested durable-operation guard | Move | Keep the rule in attempt-owned Context. |

### `packages/durable-execution/src/local-program-driver.ts`

| Responsibility | Disposition | Reason |
| --- | --- | --- |
| Manual attachment Scope creation and shutdown | Replace | The attachment becomes an Effection resource owned by its caller. |
| Buffered proposal Queue and boundary resolvers | Retain and simplify | The resource still needs buffered one-consumer traffic and one-shot resume. |
| Record attempt execution | Move | A resource-owned command supervisor spawns one attempt Task. |
| `authorizedOutcome?` phase mutation | Delete | Distinct `record-proposed` and `record-attempt-completed` events encode phases. |
| Registry lookup, execution setup, and canonical outcome validation | Retain | These remain execution-side responsibilities. |
| Replay restoration | Move later | The record proof covers reconstruction, not production restore transport. |

### `packages/durable-execution/src/program-driver-contract.ts`

| Responsibility | Disposition | Reason |
| --- | --- | --- |
| `AttachProgramRequest`, descriptor identity, receipts, and shutdown reasons | Retain | The proof uses these contracts unchanged. |
| `attach/step/shutdown` attachment lifecycle | Replace after all drivers migrate | A resource-shaped `open()` would own acquisition and cleanup. |
| Optional `authorizedOutcome` on `ProgramStep` | Replace | Use phase-specific messages. |
| Restore and replay evidence contracts | Retain, then adapt | Remote and recovery work still needs exact replay evidence. |

### `packages/durable-execution/src/program-runtime.ts`

| Responsibility | Disposition | Reason |
| --- | --- | --- |
| Scoped driver registry and route dispatch | Retain | Resource-shaped drivers still require scoped selection. |
| `ProgramPeer` bounded API | Replace or narrow | It should acquire a resource handle instead of exposing manual shutdown. |
| Driver capability and manifest dispatch | Retain | The proof does not replace artifact lookup or restore capability discovery. |

### `packages/journal-authority/src/journal-program-runtime.ts`

| Responsibility | Disposition | Reason |
| --- | --- | --- |
| Reserve, authorize, resolve, confirm, and resume order | Retain | This is the authority guarantee proved by the vertical path. |
| Calls to `ProgramPeer.step()` | Replace | A future host would exchange phase-specific messages with the resource handle. |
| Record-only optional-outcome checks | Delete | Attempt completion has a distinct event. |
| Effect, child, emission, cancellation, and restore branches | Move later as one reviewed cutover | The proof does not authorize a mixed production runtime. |

### Remote driver follow-up

- `packages/tool-runtime-local/src/local-worker-durable-driver.ts` must map worker
  lifetime to a resource-owned attachment without exposing a worker Scope.
- `packages/tool-runtime-agentcore/src/durable-driver.ts` must preserve transport
  loss, attachment fencing, and restore evidence through the resource handle.
- Remote command/event transports must carry only the serializable phase types.
  Runtime closures remain local to the execution attachment.

## Simplicity and Negative Evidence

The proof identifies real deletion candidates: manual attachment Scope
management, explicit shutdown on every host path, `DurableProposalExecutor`,
and the optional `authorizedOutcome` phase. Resource ownership also makes the
lifetime tree explicit.

The proof does not yet show that a complete production runtime is smaller. A
full cutover must add every non-record durable operation, remote transport,
cancellation unwind, and restore. `Workflow<T>` also imposes explicit
`ephemeral()` authoring and uses Effection's low-level Effect contract. These
costs are negative evidence against an immediate migration.

The correct next decision is to keep the proof quarantined and compare one or
more representative real programs before proposing a production design.

## Unmet Requirements

None for the record vertical proof verdict. The proof does not claim conformance
for the non-goals in the approved design, including remote drivers, production
recovery, or non-record durable operations.

## Phase 2 Promotion Status

The promoted production runtime lives at
`packages/journal-authority/src/workflow/runtime.ts`, exported through the
package entry; this file remains as a compatibility shim.

Landed:

- All sequential pull kinds execute end-to-end against memory and stored
  shells: record, effect (manifest-declared, inline executor), wait
  (authority-clock settled, `wait_not_due` proven), elicit (participant
  envelope validation), invoke (child composition with auto-settlement).
- Emission executes through append + host acknowledgement.
- Parallel combinators fail closed at the command boundary before any
  reservation, execution, or journal write.
- Kill-and-resume restore replays accepted settlements without live
  re-execution; divergence fails closed; suppression parity holds.
- Attempt coordination is a fail-closed `definePort` boundary (driver at
  `min`, host policy at `max`), with cross-scope ordering conformance.
- Authoring envelope: helpers return `Durable<T>` so `yield*` infers each
  boundary's settled type; one documented structural assertion lives in the
  envelope factory instead of every call site.

Gates at close: 20 files / 144 tests passing, tsc clean, focused lint clean,
build and declarations green, module-graph and export validators green.

Deferred to phase 3 planning: routed effect placement (`DurableEffectRouting`),
parked elicitation states, and consumer cutover parity vectors - the current
runtime settles all boundaries within one activation, while the legacy runtime
parks tasks awaiting external participants.

## Phase 3 Cutover Requirements (discovered)

`tool-runtime-local/src/durable-tool-session-facade.ts` is the first external
consumer. Its integration surface:

1. Per activation it installs execution store + stored journal authority +
   `installJournalProgramRuntime()`, then drives programs through
   `ProgramRuntime.operations.run({ attach, executeHostEffects: true })`.
2. Restore between activations is **snapshot-based**
   (`AuthoritySnapshotPort.exportSnapshot` -> state store ->
   `initialSnapshot` on the next activation).
3. Its activation loop supports exactly one park reason: elicit. The pending
   pull is read from the journal, settled through
   `pull.resolution-capability` + `user:${key}` audience resolution, and the
   loop re-activates. Any other reason raises `unsupported_park`.
4. Installed effects come from an `options.effectHandlers` map compiled into
   a `createDurableEffectRegistry`.

Cutover therefore requires, before any flip:

- A DurableTool -> Workflow adapter mapping context operations
  (`record`, `elicit`, `effect`, clock `waitUntil`, `invoke`, `emit`) onto the
  new authoring helpers.
- An effect-handler injection point on the new runtime equivalent to the
  effect-handler map (the `RecordAttemptPort` seam generalised, or a sibling
  boundary), since installed effects are not authored closures.
- A parked-activation drive loop in the facade that ends activations on
  pending pulls and relies on snapshot restore + replayed reservation - the
  cross-activation pattern already proven in
  `src/__tests__/workflow-parity.test.ts` and `kinds.test.ts`.
- Parity vectors extended with effect and parked-elicit scenarios (harness at
  `src/__tests__/workflow-parity.test.ts` currently covers record, effect,
  emission, and parked elicit).

No flip work starts until these land behind their own tests.

## Phase 3 addition: foreignTool requirement

`foreign-tool-session.integration.test.ts` drives foreign-tool invocations
through the facade (`foreignToolAdapter` + `foreignToolAdapterChild`). The
workflow adapter currently rejects `ctx.foreignTool` eagerly, so the facade
rewrite must either thread a foreign-child handler through
`createWorkflowProgramDriver` options (mirroring `foreignToolAdapterChild`)
or scope the initial flip to non-foreign tools and land foreign support as a
follow-up with its own integration test.

## Phase 3 status (facade cutover prep)

- `createWorkflowProgramDriver` implements the full `ProgramDriver` contract;
  conformance-tested in `__tests__/workflow-program-driver.test.ts`.
- Shared drive loop extracted to `journal-authority/src/workflow/host-drive.ts`
  (`driveActivation`): both runtimes park/resume/settle through one path,
  returning `ActivationResult` (`completed | pending`) instead of throwing
  parked sentinels.
- `tool-runtime-local` facade gained `runtime?: "workflow" | "local"` (default
  `"local"`); workflow branch consumes only the journal-authority root surface
  (`durableToolWorkflow`, `driveActivation`, `InstalledEffectPort`,
  `openProgramAttachment`). Foreign tools stay legacy per Option B deferral.
- Parity vectors green: record/effect/emission inline + elicit-park
  cross-activation. Open: invoke/wait vectors, error-code sweep,
  shared-session coexistence proof.
- Counts at this checkpoint: journal-authority 151, tool-runtime-local 56,
  acceptance 6 — all green; workspace validators clean.

## Phase 3 addition: invoke/wait parity vectors

- **wait vector**: both runtimes park (`reason: "wait"`), reject early
  resolution with public `wait_not_due`, settle after clock advance, and
  complete on restore. Legacy restores via a second `ProgramRuntime.run`;
  new runtime binds + replays the resolved reservation. Journals, forests,
  and settled values identical.
- **invoke vector**: legacy composes children inline; new runtime drives the
  same protocol — propose/reserve/park, child route derived through the
  shared `ProgramRouteResolver` port (policy single-sourced per the
  design-addendum policy/mechanism split), ensure-child, run child workflow,
  complete child (authority auto-settles parent pull), parent restore
  replays. Child routes are journaled in `TaskOpened`; equality proves both
  sides derive identical routes.
- Retention consequence: `program-driver-contract.ts`,
  `program-runtime-context.ts`, and the route resolver survive phase 4;
  deletion scope shrinks to drive loops + authoring shims.
- Counts: journal-authority 153 tests / 22 files green; exports, module
  graph, product-surface validators clean.

## Error-channel normalization (decision core)

- Normative rule adopted: command outcomes are data; exceptions reserved for
  invariant violations. `complete-task` now returns `CompleteTaskResult`
  (`accepted | duplicate | rejected{code,message}`) — matching the
  `resolve-pull` / `validate-elicit-response` house pattern.
- Value-level refusals (`schema_validation_failed`, `payload_too_large`) are
  rejection data; all three drive loops close via the error envelope so
  journals record `TaskClosed{error}` uniformly with thrown bodies.
- Invariants unchanged as throws (`nondeterminism_detected`,
  `history_not_exhausted`, capability/proof failures); legacy force-orphan
  catch logic untouched.
- `error-taxonomy.ts` added: `PUBLIC_ERROR_CODES` + `classifyError` —
  single classification source (channel × recovery), exported from package
  root; conformance suite updated to pinned union shape.
- Gates: journal-authority 153, tool-runtime-local 56 + acceptance 6, tsc
  clean both packages, exports/module-graph validators clean.

## Error-code sweep (value-refusal channel)

- Parameterized parity scenarios: thrown plain errors (`program_error`),
  output-schema violations (`schema_validation_failed`), oversized terminal
  values (`payload_too_large`). Both runtimes must fail identically:
  same code, same journal types, identical forest projections, TaskClosed
  carrying the error outcome.
- Sweep caught a real legacy divergence on its first run: after decision-core
  normalization, the legacy loop's completion wrapper retried transparently,
  so the loop still mapped a refused ok-value to `{state:"completed"}` while
  journaling TaskClosed{error}. Fixed: `completeCommand` now returns
  `{receipt, effectiveOutcome}` and the loop reports
  `{state:"failed", error}` from it. Result mapping and journals now agree
  across runtimes for all three refusals.
- Counts: journal-authority 156 tests / 22 files; tool-runtime-local 56;
  acceptance 6 — all green. Exports + module graph clean.

## Stretch 1: foreign tools on the workflow runtime

- `durableToolWorkflow.context.foreignTool` now lowers onto an invoke of the
  host-configured foreign adapter child (dependency direction preserved: the
  factory is injected via driver/facade options; kernel stays session-agnostic).
  Without a factory it fails closed, matching legacy.
- Facade workflow branch composes parked child invocations host-side:
  resolve route (shared ProgramRouteResolver) -> ensure-child -> bind ->
  nested driveActivation (closes itself) -> parent restore replays the
  settled invocation. New facade options: `foreignToolChild`, `children`.
- Kernel bridge `installEffectRegistrations` added: legacy
  DurableEffectRegistration handlers (OperationOutcome envelopes) install
  onto InstalledEffectPort with envelope unwrapping — legacy registries
  migrate verbatim. Found via a contract mismatch while wiring the foreign
  executor; root-caused with an in-kernel probe.
- Proofs landed:
  - runtime-level: foreign adapter child composed + executed end-to-end on
    driveActivation (workflow-mode variant of automatic-foreign-child).
  - facade-level: authored parent -> authored child through the facade with
    `runtime:"workflow"` while the outer adapter stays legacy local-driver —
    mixed drivers sharing one process and one decision core (this doubles as
    the migration-window coexistence evidence for REQ-019).
- runRecordWorkflow folded into driveActivation; vertical harness migrated;
  cancellation now reports {state:"cancelled"} through driveActivation.
- Worker verdict: vestigial — optional config, zero production spawns.
  Durable-worker parts die at phase 3 unported.
- Gates: journal-authority 156, tool-runtime-local 58 + acceptance 6, tsc
  clean both packages, exports/module-graph validators clean.

## Stretch 2: facade flip + cutover state

- FACADE FLIPPED: `runtime` option deleted; legacy branch and
  `installJournalProgramRuntime` removed from durable-tool-session-facade.
  The facade is single-path workflow runtime.
- Consumer scoping completed with exact migration shapes:
  - chat-engine (1903 ln) + local-program-host (614 ln): reimplement
    `runLocalProgramActivation` environment onto driveActivation +
    InstalledEffectPort (effects/preparer/acknowledger wrap as handlers);
    fencing preserved at host layer. Largest remaining item.
  - agentcore evaluator (270 ln): PURE sandbox evaluator over
    local-program-driver — surfaces a RETENTION DECISION: keep
    local-program-driver for sandbox evaluation, or port evaluator to
    attachment-stepping protocol.
  - native-tools (77 ln): blocked on worker/sampling semantics only.
- Known gap (documented, skipped test): workflow-runtime sampling parks are
  not wired to the session ask channel; model.sample requires host-installed
  handlers or the sampling-park semantic decision.
- model.sample wire-shape fix landed in facade bridge (message+output envelope).
- Gates: journal-authority 156, tool-runtime-local 57 pass + 1 documented
  skip + acceptance 6; tsc clean; validators clean.

## Foreign boundary rework (reviewer-directed design correction)

- Model corrected per review: foreign tools are session-bound LIVE calls
  (createTool surface, sample/elicit via tool context, execution never
  shutdown/replayed; death = error). The adapter-child + durable-continuation
  machinery was legacy resumable-mode complexity, not the primary path.
- Kernel: new `foreign` pull kind — descriptor {driver,tool,input,
  durability}, parser, authoring helper `foreignTool(...)` (park-style like
  elicit), pendingReason "foreign", resolution authority "participant",
  audience `foreign:<driver>`, result validated as ANY_JSON (no manifest
  declaration). Non-ephemeral durabilities fail closed at reserve.
- Adapter: `context.foreignTool` lowers onto the foreign boundary directly.
  `foreignToolChild` factory deleted from driver + facade options.
- Facade: authored-child compose extracted into named operation
  (`composeAuthoredChild`, withAuthority threaded) per pattern-fit review.
- Proofs (workflow-foreign.test.ts): park→session-resolve→replay→complete;
  lost-reference journaled as error → program failure; non-ephemeral
  rejected; canonical journal record. Adapter-mechanism workflow test
  removed (pinned superseded design).
- Host-side executor (live createTool invocation against session-backed
  context, agentcore-proven callable pattern) lands with chat-engine
  migration.
- Gates: journal-authority 160/160 (23 files); tool-runtime-local 56+1 skip;
  acceptance 6; tsc clean; validators clean.

## Stretch 2 close-out: consumer scoping final

- chat-engine: activation environment mapped in full. Legacy pipeline =
  prepare-input-before-reserve (journaled prepared), attempt via execution
  registry, acknowledge after resolve, route resolver, sampling service,
  delivery writer. Workflow equivalent designed: same hooks wrap an
  InstalledEffectPort handler; route resolver ports directly; acknowledger
  wraps post-resolve. ONE open placement decision (see below).
- native-tools.ts: pure composition context (bindings/drivers/effects) —
  no migration needed; apps swap registered driver implementations.
- agentcore evaluator: pure sandbox evaluator over local-program-driver.
- Parity suite dissolves at deletion time by design.

## Stretch 3: chat-engine migration + inference params

- chat-engine flipped: non-fenced activations drive through
  `runWorkflowProgramActivation` + `driveActivation` (open/bind by snapshot
  presence, raw-input effect handlers via installed registrations,
  route-resolver port, acknowledger surfaced through new kernel hook
  `DriveActivationRequest.onEffectResolved` carrying pullId/attemptId/
  outcomeDigest). Fenced native bindings keep the legacy activation loop
  until their remote substrate migrates (documented exception).
- Decision 1 executed: no input-preparation layer anywhere on the workflow
  path; journals carry exact authored inputs.
- Inference params exposed to authors: temperature/topP/topK/thinking added
  to SamplingRequestBase and threaded into model-sample wire options.
- Retention decision executed: local-program-driver retained for the pure
  agentcore sandbox evaluator.
- Gates: journal-authority 160, tool-runtime-local 56+6 (+1 skip),
  durable-chat-runtime 91, agent-sdk 159; tsc clean; validators clean.

## Review round: session-side foreign executor + relay contract

- Extracted `executeForeignToolCall` into foreign-tool-session: standalone
  executor for parked foreign pulls over the invocation host (start →
  ask-relay loop → terminal), reusing the worker-boundary machinery so even
  local createTool executions carry external-process semantics (reviewer
  direction; supersedes the vestigial verdict on the worker substrate).
- Relay contract typed against ToolInvocationResume/ElicitExchangeCompletion:
  requestId-correlated resumes, pure-callback relays only (a parent task
  holding an unresolved foreign pull cannot propose new pulls).
- Facade `foreign` option reshaped to {tools, asks}; elicit no longer defaults
  through outerContext — unanswered kinds fail closed.
- Known issue discovered + documented: invocation-host crank semantics
  re-raise the sampling ask once post-resume (two distinct requestIds per
  authored ctx.sample). Tied to the deferred sampling-park decision;
  facade-level foreign test skipped with this reason until resolved.
  Kernel-level foreign proofs remain green (park/resolve/replay/error/
  durability-gate/journal-record).

## Sampling park semantics (Decision 3 executed)

- New kernel pull kind `sample`: descriptor {input = canonical wire request},
  parser, authoring helper `modelSample(input)`, pendingReason "sample",
  resolution authority "participant", audience "model-runtime", result
  validated as ANY_JSON. Journals the canonical request verbatim (Decision 1
  raw-input semantics).
- Adapter `ctx.sample` prefers `context.sampleModelPull(input)` when present
  (workflow runtime → parks the program); falls back to legacy effect
  proposal otherwise. Optional member added to DurableProgramContext.
- Facade: parked reason "sample" surfaces the RAW journaled input through
  `FacadeOuterContext.sample` (restored as optional passthrough — facade
  itself carries no model-sampling protocol), resolves with the response,
  and continues. No outer sampler configured → unsupported_park.
- Inference params exposed to authors: temperature/topP/topK/thinking on
  SamplingRequestBase, threaded into wire options.
- Gates: journal-authority 160, agent-sdk 159, durable-chat-runtime 91,
  tool-runtime-local 56+6 (+2 documented skips); tsc clean across packages.

## Cycle break: durable-facade identity markers

- Module-graph validator caught a facade ↔ foreign-tool-session import cycle
  (annotation + predicate). Extracted to leaf module
  `durable-tool-facade-marker.ts` (DURABLE_TOOL_FACADE_ANNOTATION +
  isDurableToolSessionFacade); both consumers import the leaf. Facade root
  re-exports preserved for API stability.
- Final gates: journal-authority 160, tool-runtime-local 56+6 (+2 documented
  skips), durable-chat-runtime 91, agent-sdk 159; tsc clean ×5; exports +
  module-graph validators clean.

## Handoff note: chat-engine sample-interrupt surfacing (next sitting)

Current behavior: a program parking with reason "sample" reaches
program-driver-chat-engine's parked branch, misses the pendingElicit lookup
(elicit-kind only), and projects RUN_ERROR/PROGRAM_PARKED to the UI.
Implementation goes in that branch, mirroring the elicit interrupt path:

1. Detect reason "sample" → findSamplePull-equivalent read from journal
   (pull descriptor.input = canonical wire request).
2. Project the ask as an interrupt (same machinery as elicit interrupts;
   payload carries the wire request for the host to answer via its
   modelSamplingService).
3. Resolution: host calls authority.resolve(pullId,
   audience:"model-runtime", ok(response)) directly — no
   validateElicitResponse schema gate for sample pulls (result is ANY_JSON).
4. Next activation replays the settled sample; program continues.

Guard: fenced branch unchanged until remote-substrate design lands.
Everything else in the zero-legacy campaign is complete per prior entries;
physical deletion remains gated on fenced + this item.

## Pull Resolver Registry (CP3 stretch 1 — design/spec/test-plan approved, executed)

- New leaf modules journal-authority/src/pull-kinds/{registry,wire,elicit,wait,
  children,sample,foreign,index,kinds}.ts: PullResolver + registry builder,
  PullKindPolicy per kind (descriptor schema shared with snapshot codec,
  resolutionAuthority, optional pendingReason/resolutionTarget), canonical
  kind-name constants for hosts.
- authority-decisions.pendingResolutionAuthority and
  authority-support.{operationPolicy sample/foreign arms, pendingReason} now
  consume policies generically; zero literal kind comparisons remain (REQ-004
  scan clean).
- durable-authority-snapshot-schema derives elicit/sample/foreign/invoke/spawn
  variants from the registry; wait keeps its exactly-one-deadline refinement;
  record/effect/all/race/join static (REQ-005).
- Facade: three find→perform→resolve branches collapsed into one generic
  dispatch (findPull + facadePullResolvers over PULL_KIND_* constants);
  child composition branch retained by design; fail-closed envelope unchanged.
- Chat-engine: sample-specific loop replaced by resolver registration; engine
  source contains zero "sample" literals (constant import only) — REQ-007 met.
- Known issue carried: invocation-host crank re-emits the sample ask post-resume
  (two requestIds, one semantic ask); facade-foreign test documents it with a
  dedupe set + relaxed assertion, unskipped. Crank fix tracked separately.
- Ordinary-harness unskip completed earlier this stretch: inner sampling now
  authors through context.sampleModelPull; workflow replay counts updated to
  per-park activations (5).
- Gates: JA 160 · TRL 58+6 zero skips · DCR 91 · SDK 159; tsc clean ×5;
  exports + module-graph validators clean. Net code reduction in facade/engine/
  decisions per NFR-003.

## REQ-009 closure: single adapter pull boundary

- runtime.ts gains exported `pullOperation(descriptor)`: parses any registered
  interaction descriptor via the sequential union, journals verbatim, parks;
  journal labels come from kind policy (`journalLabel` on PullKindPolicy:
  sample→"model.sample", foreign→"foreign(${tool})") so journal bytes are
  unchanged (NFR-001 parity holds).
- modelSample/foreignTool helpers are now 1–3 line delegates onto
  pullOperation; foreign durability gate fires once at reserve via the kind
  policy's resolutionTarget (authoring-time early throw removed after it
  changed reserve-path error semantics — workflow-foreign.test.ts guards this).
- Adapter context exposes generic `pull(descriptor)`; sampleModelPull and
  foreignTool remain as thin sugar wrappers over it. DurableProgramContext
  type extended with the optional pull member.
- Gates re-verified: JA 160 · TRL 58+6 · DCR 91 · SDK 159 · tsc ×5 ·
  module-graph clean.

## Session close: REQ-009 final form + incident record

- Adapter end-state ratified: DurableProgramContext carries exactly ONE
  interaction member, pull(descriptor); sampleModelPull/foreignTool removed
  from interface; SDK sugar routes through it; legacy-driver tests keep
  context.foreignTool deliberately until deletion phase.
- Boundaries reference written: .pi/specs/boundaries-and-logs.md (three-case
  taxonomy; peers = future separate primitive). Design addendum appended.
- INCIDENT: failed edit script truncated durable-tool-session-facade.ts to 0
  bytes; recovered fully from git index snapshot (registry-dispatch vintage);
  verified tsc clean + 58/58. Facade foreign-option-bag -> resolver-swap
  remains QUEUED (not lost). Recommend committing current tree promptly.

## Manifest item 2 executed: facade option-bag swap

- Options.foreign {tools,asks} replaced by options.pullResolvers (readonly
  PullResolver[]); new exported createForeignPullResolver({tools,asks}) stock
  builder; barrel export added; internal registry = static resolvers +
  outer-channel sample/elicit resolvers. No kind-shaped option bags remain
  (REQ-009 fully closed). Test migrated; TRL 58/58 tsc clean.

## Manifest item 3 RESOLVED: "crank double-fire" was a test misdiagnosis

- Systematic host-side probing (drain events, drain-return kinds, executor
  ask-kind routing, exec-call counter) proved: ONE foreign execution, ONE
  sample_request (req:1), correct elicit routing (req:2), zero re-emission.
- Root cause of the phantom: the facade-foreign test incremented
  sampledPrompts from TWO sites sharing one variable — the weather tool body
  AND the relay closure. The dedupe Set masked the double-count; the relaxed
  assertion hid it.
- Fix: removed the tool-body increment; relay-side counter now authoritative;
  assertion tightened to toBe(1); dedupe Set deleted.
- Also removed pre-existing PARAMS FAIL console cruft in invocation-runtime.
- All probes stripped from tool-session + tool-runtime-local sources.
- Full matrix: JA 160 · DE 25 · SDK 159 · TRL 58+6 · DCR 91 · tsc ×6 ·
  module-graph + exports validators clean. Zero skips anywhere.
- Items 2 and 3 of the deletion manifest are CLOSED. Next: fenced-substrate
  design sitting → test-fleet conversion → physical deletion.

## Manifest item 4 EXECUTED: fenced bindings on the workflow runtime

- Discovery: lease coordinator (claim/renew/release + epoch) is runtime-
  agnostic; kernel already provides epoch-gated bind (stale_program_capability)
  and session activationLease state. No kernel change required.
- Engine: shared activateWorkflow(epoch, allowOpenedCapability) closure used by
  BOTH paths; fenced branch = journal.withAuthority → runFencedActivation →
  activateWorkflow(claimedEpoch, always-bind), resolver loop included.
- Legacy cluster deleted from engine: runLocalProgramActivation usage,
  ProgramRuntime.operations.run, effects/drivers registries,
  foreignToolChild adapter-child wiring, effectInputPreparer +
  prepareModelSampleEffectInput consumption.
- invokeCatalogTool foreign calls now use context.pull({kind:"foreign"...});
  legacy route field dropped from descriptor (raw-input model).
- Gates: JA 160 · DE 25 · SDK 159 · TRL 58+6 · DCR 91 · module-graph clean.
- runLocalProgramActivation now has NO production consumers (barrel export
  only) → promoted to deletion-manifest head of list.

## State after fenced migration (commits 7634af7a, d10d8284)

Zero-legacy manifest position:
1. ✅ commit tree
2. ✅ facade resolver swap
3. ✅ crank "double-fire" resolved (misdiagnosis; test counter fixed)
4. ✅ fenced bindings on workflow runtime
5. ⬜ test fleet: durable-runtime.test.ts = 1738 lines, 26 its,
   10× ProgramRuntime.operations.run sites inside withAuthorityTestScope
   (installs JournalAuthorityPort + installJournalProgramRuntime).
   Conversion notes: tests asserting legacy effect-routing semantics either
   rewrite onto installed-handler equivalents or delete with the legacy
   surface; decision-core assertions carry over verbatim.
6. ⬜ physical deletion — head of list now includes
   journal-program-runtime.ts itself (withAuthorityTestScope moves to a
   workflow test harness), local-program-host.ts runLocalProgramActivation
   (no production consumers remain), legacy context members
   (foreignTool/foreignToolChild), foreign-adapter.ts continuation encoding,
   dead worker-durable paths, prepareModelSampleEffectInput.
7. ⬜ docs closure (spec REQs, retention line-by-line).
Next sitting: execute 5→6→7 strictly in order; do not interleave.
