# Test Plan: Pull Resolver Registry

## Status
Draft — awaiting review

## 1. Overview
Tests for the PullResolver registry unification as defined in the normative
specification: generic parked-pull dispatch in facade and chat-engine,
kind-owned policy modules, registry-derived snapshot codec, fail-closed
envelopes, and parity preservation.

**Specification**: [.pi/specs/pull-resolver-registry-spec.md](.pi/specs/pull-resolver-registry-spec.md)

## 2. Test Strategy

### 2.1 Approach

Behavior-focused diamond. The integration layer dominates: deterministic
outside-in scenarios drive the *real* kernel, authority, snapshot codec,
facade, and invocation-host machinery end-to-end inside a single process —
no client-library method is ever stubbed. Unit tests cover pure logic only
(policy derivations, registry construction). One E2E smoke path proves the
chat-engine's routed sampling flow against the real engine.

| Layer | Distribution | Primary target |
| :--- | :--- | :--- |
| **Unit tests** | Thin | Policy-table derivations (REQ-003/004), registry build (REQ-002), canonicalization helper |
| **Integration tests** | Widest | Facade loop collapse (REQ-006), engine routing (REQ-007), codec derivation (REQ-005), fail-closed envelopes (REQ-008), adapter boundary (REQ-009) — all through real kernel + authority + invocation host |
| **E2E tests** | Thin | Chat-engine multi-turn sample+elicit program with real modelSamplingService fixture |

### 2.2 System boundary and dependencies

- **System under test**: journal-authority kernel + kind policy modules +
  tool-runtime-local facade + durable-chat-runtime engine.
- **Real components kept in the request path**: JournalAuthorityContract via
  scenario driver / stored shell; `executeForeignToolCall` executor over the
  real ToolInvocationHostPort; `createToolInvocationExecution` local inline
  session; `durableToolWorkflow` adapter; `executeModelSamplePull` pipeline.
- **Simulated dependencies**: the model provider sits behind the existing
  `ModelSamplingService` configuration seam (fixture handlers return canned
  dispositions) — the service interface is real, only the provider call is
  canned; foreign ask relays are host-supplied closures by contract, so test
  relays are the production shape, not mocks.
- **Semantic barriers**: no wall-clock sleeps or polling anywhere; scenarios
  advance through named operations (`runProgram`, `acceptPending`,
  `turnOnce`, `driveActivation`, `invoke`) whose completion implies state.
- **Teardown checks**: every integration scenario asserts terminal journal
  state (TaskClosed outcome) and clean resource drain (`drain()` on
  invocation runtime where started).

## 3. Test Cases

### TC-001: Resolver interface surface
- **Requirements**: REQ-001, REQ-002
- **Type**: Unit
- **Preconditions**: none
- **Steps**:
  1. Import `PullResolver`, `PullResolutionContext`, `PullResolverRegistry`
     from `@sweatpants/journal-authority` root.
  2. Build a registry containing one fixture resolver; attempt duplicate-kind
     registration via the exported builder.
  3. Look up a registered and an unregistered kind.
- **Expected Result**: Types expose exactly the spec'd members (typecheck
  file asserts); builder throws on duplicates; lookup hit returns the
  resolver; miss returns `undefined` without throwing.

### TC-002: Kind policy self-description completeness
- **Requirements**: REQ-003
- **Type**: Unit
- **Preconditions**: none
- **Steps**:
  1. For each of elicit/sample/foreign: import its kind module.
  2. Assert exports: descriptor parser, `PullKindPolicy` with audience
     derivation and result validation, reserve gates where ratified.
  3. Evaluate audiences: elicit → `participant`; sample → `model-runtime`;
     foreign → `` `foreign:${driver}` ``.
- **Expected Result**: All three kinds fully self-describe; no other module
  contains literal audience strings for these kinds (source scan assertion).

### TC-003: Foreign durability gate lives at declaration
- **Requirements**: REQ-003, REQ-004
- **Type**: Unit
- **Preconditions**: none
- **Steps**:
  1. Invoke the foreign policy's `reserveGate` with
     `{durability:"resumable_handle"}` then with `"ephemeral_handle"`.
- **Expected Result**: Non-ephemeral throws `invalid_descriptor`
  ("Only ephemeral foreign calls are supported…"); ephemeral passes.

### TC-004: Decision pipeline consumes policy generically
- **Requirements**: REQ-004
- **Type**: Integration
- **Preconditions**: authority scenario driver with schema registry
- **Steps**:
  1. Propose pulls of each kind through a driven program (elicit, sample,
     foreign via adapter sugar).
  2. Inspect reserve decisions recorded in the decision pipeline trace.
  3. Source-scan `authority-decisions.ts` for literal `descriptor.kind === "sample"` /
     `"foreign"` comparisons outside registry plumbing.
- **Expected Result**: Reserve outcomes identical to pre-refactor golden
  decisions (participant modes, correct audiences); source scan finds zero
  per-kind literals.

### TC-005: Support helpers derive from policy
- **Requirements**: REQ-004
- **Type**: Unit
- **Preconditions**: none
- **Steps**:
  1. Call the support derivation (installedOrRecordedDescriptor successor)
     with each kind's descriptor.
  2. Source-scan `authority-support.ts` for per-kind switches.
- **Expected Result**: Result descriptor + audience match goldens
  (ANY_JSON for sample/foreign, manifest projection for elicit); scan clean.

### TC-006: Snapshot codec derives union from registry
- **Requirements**: REQ-005
- **Type**: Integration
- **Preconditions**: authority scope exporting snapshots after each pull kind
  has been proposed
- **Steps**:
  1. Run a program proposing elicit + sample + foreign pulls; export a
     snapshot after each park.
  2. Re-import each snapshot through `parseDurableAuthoritySnapshot`.
  3. Register a fixture fourth kind ("approval") in a scratch registry;
     rebuild the codec union; round-trip its descriptor.
- **Expected Result**: Every descriptor survives export/import byte-exactly;
  fourth-kind round-trip succeeds with zero edits to the codec file itself.

### TC-007: Facade parked-pull single dispatch path
- **Requirements**: REQ-006, NFR-001
- **Type**: Integration
- **Preconditions**: facade over a pinned parent program that samples once,
  then elicits once, then completes (mirrors ordinary-harness scenario);
  outer context provides RuntimeTool sample/elicit channels
- **Steps**:
  1. Drive turn 1 → expect parked on sample ask (facade surfaces raw input).
  2. Answer via outer channel; drive turn 2 → expect parked on elicit.
  3. Accept elicit (continue=false); drive turn 3 → completed.
  4. Read inner journal: count kernel `sample` pulls = 1, `elicit` pulls = 1;
     last record TaskClosed ok.
  5. Source-scan facade for branches naming sample/foreign.
- **Expected Result**: Full flow through ONE dispatch path; journals
  identical to pre-refactor golden (NFR-001); scan finds no per-kind branch.

### TC-008: Canonical settlement of rich tool results
- **Requirements**: REQ-006
- **Type**: Integration
- **Preconditions**: resolver whose `perform` returns an object containing
  `undefined` optional members (e.g. `{text, exchange:{parsed: undefined}}`)
- **Steps**:
  1. Park a pull; resolve through the generic dispatch.
  2. Read the settled `PullResolved` record from the journal.
- **Expected Result**: Settled value is canonical JSON with undefined members
  stripped; no CanonicalJsonError surfaces.

### TC-009: Foreign transport rides the registry unchanged
- **Requirements**: REQ-006, REQ-008, NFR-001
- **Type**: Integration
- **Preconditions**: facade with `foreign.tools` map + ask relays (production
  shape); parent program performs one `context.foreignTool` call; weather-style
  plain createTool samples + elicits internally
- **Steps**:
  1. Drive the facade callable surface to completion.
  2. Assert report content, relay hit counts, outer-channel rejection guards
     never fired.
  3. Read outer journal: `foreign.tool.start`=1, `foreign.tool.continue`=4,
     outer `model.sample`=2, elicit=2.
- **Expected Result**: Identical to existing facade-foreign golden; relays are
  the only ask path (outer sample/elicit closures throw if reached).

### TC-010: Fail-closed envelopes preserved
- **Requirements**: REQ-008
- **Type**: Integration
- **Preconditions**: two rigs — (a) facade without a resolver for a parked
  reason; (b) executor with missing relay slot
- **Steps**:
  1. Rig (a): park on an unknown kind; observe thrown envelope.
  2. Rig (b): trigger a sample ask with `asks.sample` absent; observe
     disposition failure code.
- **Expected Result**: (a) `unsupported_park` naming the kind; (b)
  `foreign_ask_unanswered` / "No sample relay configured". Byte-compatible
  with current negative tests.

### TC-011: Engine routes sampling through registration
- **Requirements**: REQ-007, NFR-001
- **Type**: E2E
- **Preconditions**: real chat-engine resource with `modelSamplingService`
  fixture; conversation journal; non-fenced program authored to sample twice
  then emit
- **Steps**:
  1. Drive one engine run to completion through AG-UI stream events.
  2. Assert emitted events show both sample rounds answered inline-equivalently
     (parked → resolved → continued) and final assistant text present.
  3. Source-scan engine file for functional references to sample specifics.
- **Expected Result**: Completion matches pre-refactor durable-chat-runtime
  golden behavior (91-suite semantics); engine scan clean; re-run guard still
  bounded.

### TC-012: Engine unregistered-park fallback chain intact
- **Requirements**: REQ-007, REQ-008
- **Type**: Integration
- **Preconditions**: engine with sampling resolver registered but program
  parking on an unregistered interaction kind
- **Steps**:
  1. Drive the run; observe projected RUN_ERROR `PROGRAM_PARKED` event after
    registry miss and pendingElicit miss.
- **Expected Result**: Existing fallback order preserved: registry miss →
  elicit interrupt projection → RUN_ERROR.

### TC-013: Single adapter pull boundary with sugar delegation
- **Requirements**: REQ-009, NFR-001
- **Type**: Integration
- **Preconditions**: programs authored via durable-create using ctx.sample and
  ctx.foreignTool sugar
- **Steps**:
  1. Execute each sugar path through the workflow runtime.
  2. Verify call graph: sugar delegates onto the generic `pull` boundary
     (type-level export check + runtime spy on boundary op is forbidden — use
     journal evidence instead: descriptors produced are identical).
  3. Diff produced journals against parity goldens.
- **Expected Result**: Journals byte-identical across all seven parity
  vectors; sugar produces the same descriptors as direct boundary calls.

## 4. Coverage Matrix

| Requirement | TC-001 | TC-002 | TC-003 | TC-004 | TC-005 | TC-006 | TC-007 | TC-008 | TC-009 | TC-010 | TC-011 | TC-012 | TC-013 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-001 | X | | | | | | | | | | | | |
| REQ-002 | X | | | | | | | | | | | | |
| REQ-003 | | X | X | | | | | | | | | | |
| REQ-004 | | | X | X | X | | | | | | | | |
| REQ-005 | | | | | | X | | | | | | | |
| REQ-006 | | | | | | | X | X | X | | | | |
| REQ-007 | | | | | | | | | | | X | X | |
| REQ-008 | | | | | | | | | X | X | | X | |
| REQ-009 | | | | | | | | | | | | | X |
| NFR-001 | | | | X | | X | X | | X | | X | | X |
| NFR-002 | X | X | | X | X | X | X | | | | X | | X |
| NFR-003 | | | | | | | X | | X | | X | | |

Every MUST requirement (REQ-001..008) has ≥2 covering cases except REQ-001/002
(interface-only, covered precisely by TC-001); SHOULD REQ-009 covered by
TC-013. Negative coverage: TC-010 (both envelopes), TC-012 (fallback chain),
TC-003 (gate rejection).

## 5. Exit Criteria

- All cases green across packages: journal-authority, tool-runtime-local,
  agent-sdk, durable-chat-runtime.
- tsc clean ×5 packages; exports + module-graph validators clean.
- Zero skips in tool-runtime-local suites (double-fire dedupe scaffolding
  removed when crank fix lands; until then facade-foreign retains its
  documented skip with dedupe — tracked separately from this plan).
- Parity diff harness reports zero divergence vs. pre-refactor goldens.
- Evidence log entry appended with gate outputs.
