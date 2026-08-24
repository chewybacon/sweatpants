# Test Plan: Production Effection Workflow Runtime

## Status
Implemented — final cutover, deletion, placement, and pull-lifecycle gates passed.

## 1. Overview

Verifies the normative spec for promoting the Effection workflow vertical into
the production runtime: generalized boundary kinds, attachment topology,
port-composed attempt policy, parser-covered inputs, identity-matched replay,
consumer cutover, and phased deletion.

**Specification**: `.pi/specs/effection-workflow-runtime-spec.md`

## 2. Test Strategy

### 2.1 Approach — risk-weighted diamond

The center of gravity is replay/restore: the only major area with zero
empirical grounding. The outside-in layer spends its heaviest scenarios there.
Everything else extrapolates from proven code and needs pinning, not discovery.

**Layer 1 — Protocol rig scenarios (primary, Integration).** The proof rig,
generalized: real `JournalAuthorityPort` + `AuthorityJournalPort` drivers
installed in scope; workflows authored through public exports and driven via
the attachment handle through propose → authorize → settle → resume → terminal;
every scenario parameterized over `memory` | `stored` shells. Semantic state is
verified by strict fold comparison against `projectExecutionForest()`.

**Layer 2 — Targeted unit.** Parsers, adapter dispatch, error-code mapping,
settlement guards, fail-closed defaults, naming/export gates.

**Layer 3 — Minimal E2E smoke.** One durable tool through the
`tool-runtime-local` facade and one chat-handler turn after cutover. Phase-
gated; skipped until phase 3 opens.

**No client mocking anywhere.** The authority is an in-process library, not a
network service: tests use the real port facades end-to-end. The only simulator
is a protocol-compatible `ExecutionStore` wrapper (the proof's `conflictStore`
pattern) that arms control conflicts for CAS-reevaluation scenarios while the
real stored shell and commit loop stay in the request path. Host policy enters
through real `around()` installations, never fake facades.

**Semantic barriers under test**: authoring parsers; attachment handle;
coordination-port dispatch; authority port facade. Each barrier has dedicated
negative cases.

**Teardown checks**: scope disposal cancels held attempts (cleanup observed
exactly once via closure flags); tracked resolvers drain (no unresolved
exchanges survive disposal); command/event queues close; disposition defaults
hold.

### 2.2 Tools

Vitest 3.2.4 + Effection 4.1.0-alpha.9 `run`/`scoped`; in-memory and stored
shells from `journal-authority`; Foundation parsers; `@ts-expect-error`
compile-negative fixtures for typing rules; focused `oxlint`/`oxfmt` gates;
workspace validators (`validate:module-graph`, `validate:exports`) as deletion
gates. All synchronization is causal (`withResolvers` gates, abort signals);
sleeps, polling, and call-count synchronization are prohibited (NFR-001).
Request-shape observations (e.g., "restore issued zero raw segment reads") are
contract assertions on instrumented store wrappers, not synchronization.

### 2.3 Coverage Goals

100% of MUST requirements (REQ-001..023) have at least one case; SHOULD/NFR
items have explicit coverage. Many-to-many matrix below; restore scenarios
intentionally cover multiple requirements each.

## 3. Test Cases

### Layer 1 — Rig scenarios (parameterized: memory + stored unless noted)

#### TC-101: Effect kind live path
- **Requirement**: REQ-005, REQ-007, REQ-008, REQ-010
- **Type**: Integration · **Priority**: High
- **Preconditions**: Drivers installed; effect adapter registered; schemas registered.
- **Steps**:
  1. Author workflow yielding an `effect` boundary; open attachment.
  2. Drive start → authorize → settle ok value → resume.
  3. Fold journal; compare to `projectExecutionForest()`.
- **Expected Result**: Terminal completed with settled value; fold matches projection exactly.

#### TC-102: Record kind live path (re-pinned post-promotion)
- **Requirement**: REQ-004, REQ-005, REQ-008
- **Type**: Integration · **Priority**: High
- **Steps**: Vertical's canonical record scenario rerun against promoted exports.
- **Expected Result**: Identical outcomes and journal shapes to the proof.

#### TC-103: Elicit kind live path
- **Requirement**: REQ-005, REQ-006
- **Type**: Integration · **Priority**: High
- **Steps**: Elicit boundary resolved with validated response; then invalid response variant.
- **Expected Result**: Validated resolution completes; invalid rejects with elicitation validation error before settlement.

#### TC-104: Wait kind live path
- **Requirement**: REQ-005, REQ-006
- **Type**: Integration · **Priority**: Medium
- **Steps**: Wait boundary settles via causal release gate (no timers where avoidable; deterministic clock injection where the kind requires duration).
- **Expected Result**: Resume proceeds only after settle-before-resume commit.

#### TC-105: Invoke kind live path
- **Requirement**: REQ-005, REQ-006
- **Type**: Integration · **Priority**: High
- **Steps**: Invoke boundary with capability-scoped target; authorize with mismatched capability variant.
- **Expected Result**: Matched invoke completes; mismatch fences with existing capability error.

#### TC-106: Emission action path
- **Requirement**: REQ-005
- **Type**: Integration · **Priority**: High
- **Steps**: Emit during workflow; observe append; fold.
- **Expected Result**: Emission journaled without pull reservation; fold contains payload.

#### TC-107: Repeatable restore re-execution
- **Requirement**: REQ-006
- **Type**: Integration · **Priority**: High
- **Steps**: Complete program with repeatable boundary; restore; verify live work reruns only for non-durable portions.
- **Expected Result**: Accepted outcome replayed without second live execution of the fenced body; ordinary work re-ran.

#### TC-108: Unsafe lost settlement
- **Requirement**: REQ-006, REQ-013
- **Type**: Integration · **Priority**: High
- **Steps**: Max-middleware fault injection executes body then loses the result; resume claimed outcome.
- **Expected Result**: Authority records claimed error outcome; terminal failed with that code; body execution observed once.

#### TC-109: Idempotent deduplication
- **Requirement**: REQ-006, REQ-018
- **Type**: Integration · **Priority**: High
- **Steps**: Settle same idempotency key twice across live and restored runs.
- **Expected Result**: Second settlement journaled duplicate; value served from history.

#### TC-110: Parallel combinators fail closed
- **Requirement**: REQ-005 (negative)
- **Type**: Integration · **Priority**: High
- **Steps**: Feed `all`/`race`/`spawn`/`join` descriptors to the adapter table.
- **Expected Result**: `program_protocol_error` before any live execution or journal write; attachment closes cleanly.

#### TC-111: Concurrent exchange fencing
- **Requirement**: REQ-009
- **Type**: Integration · **Priority**: High
- **Steps**: Hold attempt open via causal gate; issue second exchange; release.
- **Expected Result**: Second exchange rejects `program_protocol_error`; held attempt cancels; cleanup flag set exactly once; repeated 10× without flakes.

#### TC-112: Local cancel vs disposal vs authority cancellation
- **Requirement**: REQ-008, REQ-013
- **Type**: Integration · **Priority**: High
- **Steps**: Three sections — cancel command; setDisposition then scope exit; authority-side cancellation request.
- **Expected Result**: Distinct terminal/error surfaces; no cross-contamination; journal reflects only authority-visible events.

#### TC-113: Observation middleware from ancestor scope
- **Requirement**: REQ-012
- **Type**: Integration · **Priority**: High
- **Steps**: Install observing `around()` at max in outer scope; open child-scoped attachment; run full record cycle.
- **Expected Result**: Observer sees context (actionIndex/pullId/attemptId/live signal) once; delegates; protocol unchanged.

#### TC-114: Fault-injection middleware loses settlement
- **Requirement**: REQ-012, REQ-013
- **Type**: Integration · **Priority**: High
- **Steps**: Max middleware executes then settles divergent error outcome; full resume flow.
- **Expected Result**: Claimed outcome flows attempt → resume → terminal failure untouched by the runtime.

#### TC-115: Cross-scope ordering conformance
- **Requirement**: REQ-012
- **Type**: Integration · **Priority**: High
- **Steps**: Host max layer + descendant-scope max layer + min driver; successful attempt.
- **Expected Result**: Order equals `["host", "descendant", "descendant-done", "host-done"]`.

#### TC-116: Supervisor owns cancellation mapping
- **Requirement**: REQ-013
- **Type**: Integration · **Priority**: High
- **Steps**: Two driver variants at min — throwing driver; aborting driver — behind max observer.
- **Expected Result**: Both produce `{ status: "cancelled" }` outcomes; observer cannot redefine cancellation.

#### TC-117: Kill-and-resume canonical scenario (record)
- **Requirement**: REQ-010, REQ-016, REQ-017, REQ-018
- **Type**: Integration · **Priority**: High
- **Preconditions**: Stored shell; instrumented store wrapper counting raw segment reads outside the decision pipeline.
- **Steps**:
  1. Run program past one accepted record settlement; capture fold F1.
  2. Drop the process scope without resume (simulated crash via scope halt).
  3. Restore via recovery queries; continue workflow to terminal.
  4. Compare folds and live-execution counters.
- **Expected Result**: Accepted boundary replays stored outcome with zero live executions; final fold equals continuation of F1; zero out-of-pipeline segment reads.

#### TC-118: Kill-and-resume sweep (effect, elicit, wait, invoke)
- **Requirement**: REQ-016, REQ-017
- **Type**: Integration · **Priority**: High
- **Steps**: TC-117 procedure parameterized over remaining sequential kinds.
- **Expected Result**: Same guarantees per kind; per-kind adapters feed stored outcomes correctly.

#### TC-119: Divergence fails fatal before side effects
- **Requirement**: REQ-017 (negative)
- **Type**: Integration · **Priority**: High
- **Steps**: Restore with edited workflow body that reorders/replaces an accepted boundary.
- **Expected Result**: Fatal divergence error raised; side-effect counter unchanged; no journal writes from the diverging run.

#### TC-120: Suppression parity pre/post kill
- **Requirement**: REQ-018
- **Type**: Integration · **Priority**: High
- **Steps**: Shared duplicate-suppression fixture executed live-only, then kill/resume variant.
- **Expected Result**: Identical suppression decisions and journal entries across variants.

#### TC-121: Parallel attachments install independent drivers
- **Requirement**: REQ-011
- **Type**: Integration · **Priority**: Medium
- **Steps**: Two attachments open concurrently in sibling scopes with distinct installed drivers.
- **Expected Result**: No collision; each dispatch hits its own driver; fail-closed core unreachable.

#### TC-122: Uninstalled port fails closed
- **Requirement**: REQ-011 (negative)
- **Type**: Unit · **Priority**: High
- **Steps**: Invoke coordination operation with no driver installed in scope chain.
- **Expected Result**: Rejects before executing any fenced work.

#### TC-123: Parity gate and retirement
- **Requirement**: REQ-019, REQ-020, REQ-021
- **Type**: Integration · **Priority**: High
- **Preconditions**: Named vectors cover the supported sequential kinds and public refusal/error semantics.
- **Steps**: Run both paths before cutover; after equality passes, delete the old path and comparison leg and rerun workflow/platform regressions.
- **Expected Result**: The gate passes before deletion; no dual-runtime harness or source survives afterward.

### Layer 2 — Unit

#### TC-201: Boundary parser matrix
- **Requirement**: REQ-014
- **Type**: Unit · **Priority**: High
- **Steps**: Positive + negative parses for authoring options, every command variant, receipts, every descriptor kind, dispositions.
- **Expected Result**: Closed unions accept exact shapes; unknown kinds, bad digests, malformed offsets reject.

#### TC-202: Error-code preservation at boundaries
- **Requirement**: REQ-015
- **Type**: Unit · **Priority**: High
- **Steps**: Re-run legacy invalid-input expectations against parser-backed paths; assert first-issue message embedding.
- **Expected Result**: Existing public codes unchanged; messages present when issues exist.

#### TC-203: Settlement guards
- **Requirement**: REQ-007
- **Type**: Unit · **Priority**: Medium
- **Steps**: Non-canonical values; oversized inline values; cause-chain inspection.
- **Expected Result**: Mapped codes (`*_value_invalid`, `*_value_too_large`) with causes attached.

#### TC-204: Handle surface boundedness
- **Requirement**: REQ-008
- **Type**: Unit · **Priority**: Medium
- **Steps**: `Reflect.ownKeys(handle)` on promoted attachment handle.
- **Expected Result**: Exactly the declared operation set; no resolvers or capabilities leak.

#### TC-205: Promotion naming gate
- **Requirement**: REQ-003
- **Type**: Unit · **Priority**: Low
- **Steps**: Scan promoted export names for `/Proof|Testing/iu`.
- **Expected Result**: Zero matches.

#### TC-206: Export/type snapshot stability
- **Requirement**: REQ-002
- **Type**: Unit · **Priority**: High
- **Steps**: Compile consumer-facing type snapshot against frozen current public types during phases 1–3.
- **Expected Result**: Snapshot compiles until phase-4 removal diff lands.

#### TC-207: Negative compile fixtures
- **Requirement**: REQ-004
- **Type**: Unit · **Priority**: High
- **Steps**: Checked `@ts-expect-error` fixtures: plain Operation as direct child; direct delegation without `ephemeral()`.
- **Expected Result**: Fixtures fail compilation without the directives; pass with them.

### Layer 3 — E2E smoke (phase-3 gated)

#### TC-301: Tool-runtime-local durable tool end-to-end
- **Requirement**: REQ-020, REQ-021
- **Type**: E2E · **Priority**: Medium
- **Steps**: Execute one authored durable tool (record + effect boundaries) through the local facade against the stored shell on the new runtime.
- **Expected Result**: Tool completes; journal and projection match parity expectations.

#### TC-302: Chat handler single turn post-flip
- **Requirement**: REQ-020
- **Type**: E2E · **Priority**: Low
- **Steps**: Flip chat-runtime section to new driver; run one durable turn.
- **Expected Result**: Turn completes; response stream and journal consistent.

### Gates

#### TC-401: Deletion import-closure scan
- **Requirement**: REQ-023
- **Type**: Static · **Priority**: High
- **Steps**: At deletion time, re-derive closure of candidate modules; delete; run `validate:module-graph`.
- **Expected Result**: Zero workspace imports of deleted modules; validators green.

#### TC-402: Retention integrity post-deletion
- **Requirement**: REQ-022
- **Type**: Static · **Priority**: High
- **Steps**: Compile and test retained modules (`checkpoint`, `program-identity`, `purity-scan`, `program-contract`, schema/store modules).
- **Expected Result**: All retained-module tests pass unchanged.

#### TC-403: Workspace validators per phase
- **Requirement**: REQ-001, REQ-003, NFR-002, NFR-003
- **Type**: Static · **Priority**: High
- **Steps**: After each phase: `check`, full package tests, build, `validate:module-graph`, `validate:exports`, `validate:product-surface`, focused lint gates including `no-nested-yield`.
- **Expected Result**: All green; phase diffs confined to declared paths (NFR-003 reviewed per phase).

#### TC-404: Zero-legacy physical scan
- **Requirement**: REQ-024
- **Type**: Static · **Priority**: Critical
- **Steps**: Search source, tests, barrels, and package declarations for every deleted symbol/module; verify deleted files are absent.
- **Expected Result**: Zero references and zero compatibility aliases.

#### TC-405: Generic pull and manifest-contract conformance
- **Requirement**: REQ-025
- **Type**: Integration · **Priority**: Critical
- **Steps**: Author sample, elicit, wait, invoke, and foreign interactions through `pull`; validate request and settlement against `manifest.pulls` and registered schemas.
- **Expected Result**: Typed pulls settle; malformed or undeclared contracts fail before journal acceptance.

#### TC-406: Workflow ProgramDriver placement matrix
- **Requirement**: REQ-026
- **Type**: E2E · **Priority**: Critical
- **Steps**: Run local workflow, real worker, detached Lambda-style evaluator, and fenced AgentCore-style restore paths through tree composition.
- **Expected Result**: Correct route selected, resources close, epochs fence stale work, and child topology remains Authority-owned.

#### TC-407: Verbatim descriptor and staging edge
- **Requirement**: REQ-027
- **Type**: Integration · **Priority**: Critical
- **Steps**: Stage embedded model context before reserve, inspect `PullRequested`, and compare authored wait/sample descriptors with journal values.
- **Expected Result**: Source recipe is present, embedded messages are absent, and Authority journals the proposed descriptor without enrichment.

#### TC-408: Pull-owned model lifecycle
- **Requirement**: REQ-028
- **Type**: E2E · **Priority**: Critical
- **Steps**: Exercise host/execution placement, accepted preparation, provider failure, live cancellation, partial handling, acknowledgement, worker replacement, and HTTP propagation.
- **Expected Result**: One durable outcome controls replay; cancellation aborts the provider; preparation/acknowledgement are owner-fenced.

## 4. Negative Test Cases

| Case | Requirement | Scenario | Expected |
|------|-------------|----------|----------|
| TC-110 | REQ-005 | Combinator descriptors | Protocol error, no journal write |
| TC-119 | REQ-017 | Replay divergence | Fatal before side effects |
| TC-122 | REQ-011 | Uninstalled coordination port | Reject before fenced work |
| TC-103 (variant) | REQ-005/006 | Invalid elicitation response | Validation error pre-settlement |
| TC-105 (variant) | REQ-005 | Capability mismatch on invoke | Existing fencing error |
| TC-111 | REQ-009 | Concurrent exchange | Second caller rejected; attempt cancelled |
| TC-201 (negatives) | REQ-014 | Malformed commands/receipts/descriptors/dispositions | Parser rejection at boundary |

## 5. Coverage Matrix

| Requirement | Test Cases | Priority |
|-------------|-----------|----------|
| REQ-001 | TC-403 | High |
| REQ-002 | TC-206 | High |
| REQ-003 | TC-205 | Low |
| REQ-004 | TC-102, TC-207 | High |
| REQ-005 | TC-101–106, TC-110 | High |
| REQ-006 | TC-103, TC-104, TC-105, TC-107–109 | High |
| REQ-007 | TC-101, TC-203 | Medium |
| REQ-008 | TC-008→TC-101/102, TC-112, TC-204 | High |
| REQ-009 | TC-111 | High |
| REQ-010 | TC-101, TC-117 | High |
| REQ-011 | TC-121, TC-122 | High |
| REQ-012 | TC-113–115 | High |
| REQ-013 | TC-108, TC-112, TC-116 | High |
| REQ-014 | TC-201 | High |
| REQ-015 | TC-202 | High |
| REQ-016 | TC-117, TC-118 | High |
| REQ-017 | TC-117–119 | High |
| REQ-018 | TC-109, TC-117, TC-120 | High |
| REQ-019 | TC-123 | High |
| REQ-020 | TC-123, TC-301, TC-302 | Medium |
| REQ-021 | TC-123, TC-301 | High |
| REQ-022 | TC-402 | High |
| REQ-023 | TC-401 | High |
| REQ-024 | TC-404 | Critical |
| REQ-025 | TC-405 | Critical |
| REQ-026 | TC-406 | Critical |
| REQ-027 | TC-407 | Critical |
| REQ-028 | TC-408 | Critical |
| NFR-001 | TC-111 (determinism repeats), all rig scenarios | High |
| NFR-002 | TC-403 | High |
| NFR-003 | Phase-review checklist (TC-403 scope step) | Medium |

*(TC-008 row reference denotes the shared rig topology checks embedded in TC-101/TC-102.)*

## 6. Test Data

Shared conformance vector set (named artifact, single source): per-kind happy
paths, per-public-error-code inputs, duplicate-suppression fixtures, kill/
resume transcripts, edited-body divergence bodies. Capability keyrings, schema
fixtures, manifests reused from the vertical's test kit. Instrumented
`ExecutionStore` wrapper (armed conflict + segment-read counter).

## 7. Environment Requirements

In-process only: no external services. Both shells run in one Vitest process
via installed port drivers. Deterministic clock injection for `wait` where
duration semantics require it. Phase gating enforced by review order, not
feature flags (per REQ-019).

## 8. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Restore flakiness masks real bugs | High | Causal gates only; TC-111 repeated 10×; no timing dependencies anywhere |
| Parity fixture drift between phases | High | Single named vector source consumed by both runtimes; changes require simultaneous updates |
| Effection alpha behavior shift breaks assumptions | Medium | Ordering/fail-closed conformance tests pin observed `createApi` semantics; version pinned in catalog |
| Hidden consumers break at deletion | Medium | TC-401 closure scan is authoritative at deletion time, not this document |
| Elicit/wait kinds hide timing coupling | Medium | Deterministic clock injection; causal release gates; no real sleeps |

## 9. Final Implementation Coverage

| Plan area | Actual coverage |
|-----------|----------------|
| Boundary kinds, raw descriptor journaling, fail-closed ports | `workflow/kinds.test.ts`, `workflow/emission.test.ts`, pull-kind tests |
| Restore, replay, duplicate suppression, cancellation | workflow and durable-runtime suites |
| Required generic pull and typed manifest contracts | agent-sdk durable-create tests, workflow host tests |
| Local/worker/AgentCore ProgramDriver lifecycle | workflow-program-driver, tool-runtime-local, tool-runtime-agentcore suites |
| Host/execution model placement, preparation, cancellation, acknowledgement | model-context preparation tests and platform model-placement/cancellation suites |
| Foreign adapter topology and ToolSession backchannels | tool-session, tool-runtime-local, interactive platform acceptance |
| Physical deletion and product closure | zero-reference scan, workspace checks, module graph, exports, product surface |

Final key counts: journal-authority 155; durable-chat-runtime 96; agent-sdk 160; tool-session 123 passing plus 7 existing todo; tool-runtime-local 56 plus 6 acceptance; tool-runtime-agentcore 51; platform acceptance 91; yo-chat 43; yo-studio 8. No cutover item remains open.
