# Design: Production Effection Workflow Runtime

## Status
Implemented — full production cutover and physical deletion complete. Migration-window notes in the historical addendum are superseded by the final as-built closure below.

## Overview

Promote the proven record vertical (`authority-backed-effection-workflow`) into
the production program runtime. Programs become Effection-native workflows:
authors write ordinary Operations, mark durable boundaries explicitly, and a
resource-owned attachment drives intent-before-execution against the journal
authority through port boundaries. Host policy composes as middleware; the Authority retains its capability/CAS model while adding typed pull contracts and pull-owned cancellation/preparation state.

This memo generalizes the proof past one effect kind, adds journal-driven
replay and restore, cuts consumers over to the new runtime, and deletes the
reducer-era paths it replaces.

Evidence base: `.pi/evidence/authority-backed-effection-workflow.md` (final verdict: production cutover passed). The proof remains as historical conformance support; production imports the promoted workflow runtime.

## Goals

- One production runtime where durable programs are Effection workflows authored per `.pi/specs/effection-native-durable-programs-design.md`.
- Every durable boundary keeps authority semantics: reserved pull, fenced attempt, committed settlement before resume.
- Attempt coordination is a `definePort` boundary: driver at `min`, host policy at `max` (proven by the vertical).
- Command, event, and descriptor boundaries use result-oriented Foundation parsers instead of manual assertions.
- Replay feeds accepted outcomes back into a resumed workflow without re-running live work.
- Consumers cut over to the new runtime; reducer-era paths are deleted in the same effort.
- Net source-line reduction despite new capability.

## Non-Goals

- No change to capability signing, CAS commit semantics, or append-only journal ownership (`journal-authority-kernel-design.md` remains binding). Pull contracts and `settling_pull` are additive cutover changes.
- No parallel workflow composition (`all`/`race` combinators) in this refactor; sequential `actionIndex` ordering only.
- No backward compatibility for pinned artifacts, journals, or snapshots beyond what the kernel already defines (pre-release cutover, matching `effection-native-durable-programs-design.md`).
- No new package; the runtime lives inside `@sweatpants/journal-authority`.
- No divergence-policy middleware API (mismatch stays fatal) until replay ships and a real second policy exists.

## Final As-Built Closure

- `driveActivation` owns local workflow attachments; `driveProgramDriverActivation` owns one process-independent evaluator attachment; `driveWorkflowTree` alone owns child topology.
- Program code exposes one interaction primitive, required `context.pull(descriptor)`. SDK sampling and elicitation are authoring sugar; model sampling, elicitation, wait, invoke, and foreign interactions journal through registered pull kinds.
- `DurableProgramManifest.pulls` pins input/output schema contracts for named pull kinds. Model contexts stage before Authority receives a sample descriptor; `PullRequested` stores the proposed descriptor verbatim.
- Local workflow, worker-thread, Lambda, and AgentCore evaluators all use `createWorkflowProgramDriver`; attachment resources have explicit close semantics and remote evaluators use detached ownership.
- Host/execution model placement, fenced activation leases, cancellation of live pulls, preparation ownership, acknowledgement, and worker replacement are proven by platform acceptance.
- Superseded runtime services, installers, local-driver orchestration, automatic foreign-child factories, migration flags, aliases, and parity legs were physically deleted. Import scans and package/module validators report zero surviving references.

## Requirements

### Packaging and export

- **DR-001 (Must):** The runtime MUST live under `packages/journal-authority/src/workflow/` and MUST export only through the package entry that production consumers import; the testing-only module MUST remain the proof artifact until cutover completes.
- **DR-002 (Must):** The public surface of `@sweatpants/journal-authority` MUST keep existing exports stable throughout phases 1–3; removal of superseded exports MAY happen only in phase 4 (deletion).
- **DR-003 (Must):** Workspace gates (`validate:module-graph`, `validate:exports`, `validate:product-surface`) MUST pass after every phase.

### Workflow authoring surface

- **DR-004 (Must):** Durable programs MUST author as constrained `Workflow<T>` generators where direct child effects are durable boundaries and ordinary Operations require explicit `ephemeral()`, matching the proof typing rules.
- **DR-005 (Must):** The runtime MUST support every pull descriptor kind the authority contract accepts, with one generalized boundary mechanism and a per-kind adapter table; the normative spec MUST enumerate the exact kind list from `authority-contract.ts`.
- **DR-006 (Must):** Each boundary kind MUST enforce its retry-safety semantics identical to current behavior: repeatable, unsafe (indeterminate), and idempotent mechanisms.
- **DR-007 (Should):** Authoring helpers SHOULD infer result types from closure returns and validate values through canonical-value and inline-size checks at settlement, as the proof does today.

### Attachment ownership topology

- **DR-008 (Must):** A running program MUST own exactly one attachment resource that owns the command supervisor, event queue, tracked resolvers, disposer, and attempt tasks; the public handle MUST stay bounded to `exchange()`, `setDisposition()`, and idempotent `close()`.
- **DR-009 (Must):** Concurrent `exchange()` calls MUST fail closed with `program_protocol_error` and cancel the resource-owned attempt, preserving proof-tested behavior.
- **DR-010 (Must):** Attachment state MUST derive semantic progress by folding accepted journal entries; private coordination state (capabilities, nonces, leases, live Effection values) MUST NOT enter messages or folds.

### Attempt coordination boundary

- **DR-011 (Must):** Live attempts MUST dispatch through a fail-closed `definePort` boundary whose ordinary-path driver installs at `min` per attachment scope.
- **DR-012 (Must):** Host observation, policy, and fault-injection middleware MUST compose at `max` and MUST surround the installed driver regardless of installation order; conformance tests MUST pin outer/inner/driver ordering across scopes.
- **DR-013 (Must):** Supervisor-owned cancellation mapping MUST stay outside the coordination boundary: abort or `DurableProgramCancellation` maps to a cancelled outcome after middleware returns or throws.

### Boundary validation

- **DR-014 (Must):** Every cross-boundary input (authoring options, commands, receipts, descriptors) MUST parse through Foundation `Parser<T>` schemas with closed unions; manual shape assertions MUST NOT remain on these paths.
- **DR-015 (Must):** Parser failures at throwing boundaries MUST preserve existing public error codes (`invalid_descriptor`, `program_protocol_error`, and peers).

### Replay and restore

- **DR-016 (Must):** Restoring a program MUST rebuild attachment state by folding the stored journal for its session/task, then run the workflow fresh while each boundary consults accepted history for a fencing-verified match before any live execution.
- **DR-017 (Must):** A boundary whose identity matches accepted history MUST receive the stored outcome without executing live work; a mismatch MUST fail fatal (divergence), never silently re-execute.
- **DR-018 (Must):** Restore MUST reuse authority queries and CAS semantics; it MUST NOT read journal segments around the decision pipeline.
- **DR-019 (Should):** Restore SHOULD suppress duplicate settlements exactly as live replay suppression does, verified by fold comparison against `projectExecutionForest()`.

### Consumer cutover

- **DR-020 (Must):** During the migration window the old and new runtimes MUST both install as drivers behind their ports so consumers flip by scope composition, not by code edits in library internals.
- **DR-021 (Must):** `durable-chat-runtime` handlers and `tool-runtime-local`/`tool-runtime-agentcore` facades MUST consume the new runtime through port facades; no consumer MAY import runtime internals.
- **DR-022 (Must):** Cutover MUST complete with parity evidence: identical public error codes, journal shapes, and forest projections for a shared conformance fixture set.

### Deletion

- **DR-023 (Must):** Phase 4 MUST delete `journal-program-runtime.ts` and reducer-era `durable-execution` paths made dead by cutover; retained modules (identity, purity scan, contracts) MUST be listed in the spec.
- **DR-024 (Must):** Deletion MUST leave zero imports of deleted modules anywhere in the workspace, verified by module-graph validation.

## Design Decisions

### Decision 1 — Runtime home

- **Context**: The proof needs Effection plus authority internals; consumers import both `journal-authority` and `durable-execution`.
- **Options considered**:
  1. New package `@sweatpants/effection-runtime` — clean layering, but new packaging, exports, and graph plumbing now.
  2. `journal-authority/src/workflow/` — same-package access to canonical helpers and shells; package already owns program-runtime bridging.
  3. Rebuild inside `durable-execution` — wrong direction; it would depend on the authority.
- **Choice**: Option 2.
- **Rationale**: Smallest diff, matches the kernel's "no new package" precedent, and extraction remains possible later once the surface settles.

### Decision 2 — Replay mechanism

- **Context**: Effection cannot resume a suspended generator; restore must answer "which boundary sees which stored outcome."
- **Options considered**:
  1. Position-based replay index (durable-streams model) — fast, but positions are engine-private; our history is authority-owned.
  2. Identity-matched replay: each fresh boundary queries accepted history by fenced descriptor identity; match feeds stored outcome, mismatch is fatal.
- **Choice**: Option 2.
- **Rationale**: Descriptor identity is already enforced by authority fencing, so replay inherits CAS guarantees instead of rebuilding an index; divergence staying fatal matches kernel fail-closed posture. Cost is one indexed query per boundary during restore, acceptable at current scale.

### Decision 3 — Middleware discipline

- **Context**: Kernel revision R1 separated static internal pipelines (plain functions) from caller-composed boundary policy (createApi/definePort).
- **Choice**: Attempt coordination is a port (driver `min`, host policy `max`); the command supervisor remains a fixed generator loop with parsers at edges; no divergence middleware.
- **Rationale**: Exactly the line R1 drew. The vertical proved the port side end-to-end, including ordering conformance.

### Decision 4 — Cutover mechanics

- **Context**: Six-plus consumer files need flipping without a big-bang edit.
- **Options considered**:
  1. Environment flag — hidden global state, two configs to test.
  2. Side-by-side drivers behind existing ports, flipped per consumer by scope composition.
- **Choice**: Option 2, refined by the vertical: the flip point is an explicit `runtime?: "workflow" | "local"` option on the `tool-runtime-local` facade (default `"local"`). Library internals never branch on it — only the consumer-facing facade does, which keeps the seam at the one place that must already know how to drive sessions.
- **Rationale**: Ports already scope installs per test/process section; parity fixtures can run both drivers against one fixture set. A facade-level option is more explicit than scope-composition flipping while still avoiding hidden global state.

### Decision 5 — Concurrency deferral

- **Context**: `program-contract.ts` carries `all`/`race` discriminants; parallel authorization fan-out is unsolved (each branch needs its own intent-before-execution).
- **Choice**: Sequential execution only; combinators are a Non-Goal with their own future design.
- **Rationale**: The vertical proved nothing about parallel fences; shipping them unproven repeats the mistake this refactor exists to avoid.

## Constraints

- Effection pinned `4.1.0-alpha.9` (workspace catalog); `effection/experimental` is accepted-with-conformance-tests precedent via Foundation `port.ts`.
- TypeScript `5.9.3`, Vitest `3.2.4`; repo lint rules (`sweatpants/no-nested-yield`) apply to all new code.
- Authority protocol DRs from `journal-authority-kernel-design.md` bind unchanged.
- Quarantine rule: nothing outside `src/testing/` changes before phase-1 review passes; consumer-facing edits get called out per file.

## Dependencies

| Dependency | Risk | Mitigation |
| --- | --- | --- |
| `effection/experimental` (`createApi`) stability | Medium — unstable upstream surface | Foundation pins semantics with conformance tests; isolated import path (`port.ts`) |
| Replay-by-identity query cost | Low–Medium — unproven at scale | Indexed lookup per boundary; benchmark in phase 2 vertical |
| Consumer coordination (chat-runtime, tool-runtimes) | Medium — six-plus files owned elsewhere | Phase-gated flips with parity fixtures; no library-internal edits |
| `effection-native-durable-programs` authoring model | Low — complementary doc | Runtime implements its boundary vocabulary; conflicts resolve toward that doc for authoring, this doc for execution |

## Open Questions

None. Placement, replay mechanism, middleware discipline, cutover mechanics,
concurrency scope, deletion targets, and export stability are decided above.
Remaining unknowns (exact restore query shapes, per-kind adapter details) are
normative-spec material, not design forks.

## Vertical Refinements (addendum, post-implementation)

The vertical surfaced six refinements. None contradict the decisions above;
all are recorded so the docs match the shipped code:

1. **`Durable<T>` envelope** — authoring surface wraps settled values in a
   typed envelope so call sites infer results without casts. DR-004's
   constrained-Workflow approach kept; this extends it.
2. **`InstalledEffectPort`** — the effect-handler injection gap item resolved
   as a second fail-closed `definePort`: handlers install once per attempt,
   missing handler throws `effect_handler_missing` (same discipline as the
   authority port).
3. **`createWorkflowProgramDriver`** — implements the full `ProgramDriver`
   contract, making the new runtime a drop-in replacement wherever a driver
   is accepted (this is the concrete form of DR-019/DR-020's side-by-side
   window).
4. **Facade `runtime` option** — replaces scope-composition flipping as the
   cutover mechanism (see revised Decision 4). Foreign tools stay on the
   legacy path (Option B deferral); the workflow tool-adapter rejects them
   eagerly.
5. **`host-drive.ts` / `driveActivation`** — shared activation loop extracted
   during parity work: both runtimes park, resume, and settle through one
   code path, returning `ActivationResult` (`completed` / `pending` with
   pull + resolution capability) instead of throwing parked sentinels.
6. **foreignTool deferral (Option B)** — initial runtime flip scopes to
   non-foreign tools only. Rationale: deferring may reveal a better
   abstraction for foreign tools inside the new runtime; forcing them through
   now would repeat the premature-commitment mistake this refactor exists to
   avoid.
7. **Policy/mechanism split refines the deletion scope** — "legacy" is the
   activation *mechanism* (`journal-program-runtime.ts` drive loop,
   `local-program-driver`), not the dispatch *policy* it happened to live
   next to. Route derivation must be single-sourced: child routes are
   journaled in `TaskOpened` payloads, so both runtimes MUST resolve them
   through the same `ProgramRouteResolver` or invoke parity is vacuous.
   Retention list (DR-022) therefore keeps `program-driver-contract.ts`,
   `program-runtime-context.ts` (driver registry), and the route resolver;
   phase-4 deletion shrinks to the genuine corpses. The facade `runtime`
   option consequently means "one substrate, two driving strategies" — the
   shape the foreign-tool follow-up likely wants (foreign tools as a
   route/driver concern, not a runtime branch).
8. **Error-channel normalization (normative kernel rule)** — *authority
   commands return protocol outcomes as data; exceptions are reserved for
   invariant violations.* The decision core previously drew this line
   inconsistently (`resolve-pull` returned rejections as data while
   `complete-task` threw `schema_validation_failed`). Normalized:
   value-level refusals on completion (`schema_validation_failed`,
   `payload_too_large`) return `{status:"rejected"}` data; all three drive
   loops (legacy wrapper, flowmode-runtime runner, host-drive) respond by
   closing through the standard error envelope so journals record
   `TaskClosed{error}` exactly like thrown bodies — collapsing channel-B
   ambiguity for program-authored badness. True invariants
   (`nondeterminism_detected`, `history_not_exhausted`, capability/proof
   failures) remain throws; legacy force-orphan catch logic is therefore
   untouched. Classification lives in one place:
   `journal-authority/src/error-taxonomy.ts` (`PUBLIC_ERROR_CODES`,
   `classifyError`) — consumers never string-match codes again.

Known open items at time of writing: parity vectors cover
record/effect/emission/elicit-park; invoke and wait vectors still needed for
full REQ-021 coverage. Both-drivers-one-process coexistence is exercised by
parity tests across separate authority instances, not yet against one shared
session.

## Research Notes

- Proof evidence: `.pi/evidence/authority-backed-effection-workflow.md` — pass verdict, 127 tests, module/export/product-surface validation green; Effection `4.1.0-alpha.9` resolved.
- Vertical sources: `.pi/specs/authority-backed-effection-workflow-{design,spec,test-plan}.md` (49 requirements, 32 cases approved).
- Measured baseline (this session, `wc -l`): proof impl ~1,370 + tests 1,192; `journal-program-runtime.ts` 826; `durable-execution` src ~3,635; consumer stack ~2,200 relevant lines.
- Estimated full-refactor diff: +1,900–2,500 / −1,400–1,700 implementation lines over ~18–22 files; tests +1,700–2,200 at the proven ratio. Deletion totals trustworthy only after phase 2 (replay) lands.
- Middleware lineage: `sweatpants/packages/foundation/src/port.ts` builds `definePort` on `createApi` from `effection/experimental`; `api-internal.js` shows max-over-min cross-scope composition, pinned by vertical ordering test.
- Kernel revision R1 (`.pi/specs/journal-authority-kernel-revision-memo.md`): createApi rejected for the static decision core, kept for boundary ports — the discipline this design adopts wholesale.
