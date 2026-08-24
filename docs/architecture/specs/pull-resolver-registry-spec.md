# Normative Specification: Pull Resolver Registry

## Status
Draft — awaiting review

## Abstract
Defines the PullResolver registry: the normative contract by which parked kernel pulls (elicit, sample, foreign) are dispatched to kind-owned resolvers in host layers. Specifies the resolver interface, kind self-description policy (descriptor schema, audience derivation, result validation, durability gates), generic consumption by the decision pipeline and snapshot codec, facade and chat-engine dispatch rules, fail-closed behavior for unregistered kinds, and canonical-JSON settlement requirements. Replaces all per-kind control-flow branching above the kernel.

## 1. Introduction

### 1.1 Purpose
The effection-workflow-runtime cutover introduced named pull kinds (elicit,
sample, foreign, invoke) whose handling is re-enumerated as control flow in
every host layer: the facade runs three parallel find→perform→resolve→continue
sequences, the chat-engine hardcodes sample auto-resolution, the decision
pipeline switches on kind, and the snapshot schema hand-enumerates descriptor
shapes. Each layer duplicates policy that belongs to exactly one place. This
specification defines a single registry contract that inverts the dependency:
kinds declare themselves; hosts dispatch generically.

### 1.2 Scope
**Covers**: the PullResolver interface and registry; kind-module
self-description (descriptor parser, resolution audience, result validation,
reserve gates); generic consumption by authority decisions, support helpers,
and the snapshot codec; parked-pull dispatch rules for
durable-tool-session-facade and program-driver-chat-engine; fail-closed
semantics; canonical-JSON settlement of resolver results; authoring-sugar
delegation from agent-sdk durable-create onto the adapter boundary.

**Does not cover**: kernel pull ledger semantics (`PullRequested`,
`resolve-pull`, capability model — see journal-authority-kernel-spec); child
composition protocol (invoke/spawn keep their facade branch); foreign transport
internals beyond its registration contract (session-bound live calls,
worker boundary, death = `foreign_reference_lost` — ratified CP2); fenced
native-binding substrate (deferred); sampling service internals
(`executeModelSamplePull` reused verbatim).

### 1.3 Terminology
- **MUST**: Absolute requirement (RFC 2119)
- **MUST NOT**: Absolute prohibition (RFC 2119)
- **SHOULD**: Recommended but not required (RFC 2119)
- **SHOULD NOT**: Not recommended but not prohibited (RFC 2119)
- **MAY**: Optional (RFC 2119)
- **Kind**: A named class of parked external interaction (`elicit`, `sample`,
  `foreign`), identified by `descriptor.kind`.
- **Resolver**: Host-registered implementation of §4.1 that performs one
  kind's external interaction and returns the settlement value.
- **Registry**: An immutable map from kind to resolver supplied by a host.
- **Policy**: A kind's self-declared metadata consumed generically by kernel
  layers: descriptor parser, audience derivation, result validation,
  reserve-time gates.
- **Fail closed**: Parking on a kind with no registered resolver produces a
  typed error; execution never guesses or defaults.

## 2. Functional Requirements

### 2.1 Resolver interface and registry

#### REQ-001: PullResolver interface shape
journal-authority MUST export a `PullResolver` interface with exactly:
`kind: string`; `audience(descriptor: Json): string`;
`validateResult(descriptor: Json, value: Json): ParseResult<Json>`;
`perform(ctx: PullResolutionContext, descriptor: Json): Operation<Json>`.
`PullResolutionContext` MUST carry `{ sessionId, taskId, pullId }`.

**Source**: DR-001, Decision 1

**Rationale**: A single structural contract lets hosts dispatch without
importing any concrete kind.

**Acceptance Criteria**:
- [ ] Interface exported from journal-authority root index
- [ ] Type-level test asserts the exact member set
- [ ] No concrete kind import required to consume the interface

#### REQ-002: Registry construction and lookup
Hosts MUST compose registries as immutable maps keyed by kind string. Lookup
on an unregistered kind MUST return `undefined` rather than throw; callers own
the fail-closed behavior per REQ-008.

**Source**: DR-001

**Rationale**: Separating lookup from error policy lets the facade and engine
apply their own failure envelopes.

**Acceptance Criteria**:
- [ ] Registry type exported; duplicate-kind registration rejected at build time
- [ ] Miss returns undefined (unit-testable)

### 2.2 Kind self-description

#### REQ-003: Kind modules declare complete policy
Each pull kind MUST be defined in its own module exporting: the descriptor
parser/schema, a `PullKindPolicy` object carrying the resolution-audience
derivation and result-validation rule, and any reserve-time durability gates.
For the ratified set: `elicit` (audience `participant`, manifest-projected
result validation), `sample` (audience `model-runtime`, ANY_JSON result),
`foreign` (audience `` `foreign:${descriptor.driver}` ``, ANY_JSON result,
`ephemeral_handle`-only reserve gate).

**Source**: DR-004

**Rationale**: Policy declared once, where the kind is born, ends the
duplication across decisions, support, adapter, and facade.

**Acceptance Criteria**:
- [ ] elicit/sample/foreign modules each export schema + policy + gates
- [ ] No other module contains kind-specific audience or validation logic

#### REQ-004: Generic consumption by decision pipeline and support helpers
authority-decisions.ts MUST derive reserve/resolve behavior via the kind's
policy object; authority-support.ts MUST derive result descriptor and audience
via policy. Neither file MAY contain a switch or conditional enumerating
descriptor kinds after this specification lands.

**Source**: DR-004

**Rationale**: The duplicated arms at authority-decisions.ts:1918-1932 and
authority-support.ts:158-175 are the defect this spec removes.

**Acceptance Criteria**:
- [ ] grep for `descriptor.kind ===` in both files returns only generic
      registry plumbing (if any), never literal kind names
- [ ] Existing decision tests pass unchanged

#### REQ-005: Snapshot codec derives from the kind registry
durable-authority-snapshot-schema.ts MUST construct its pull-descriptor union
by iterating registered kind parsers instead of hand-enumerating variants.
Adding a kind MUST NOT require editing the codec.

**Source**: DR-005

**Rationale**: The hand-enumerated union omitted `sample` and broke second
activations with `Invalid durable authority snapshot`; deriving from one
source eliminates the failure class.

**Acceptance Criteria**:
- [ ] Codec builds union from registry
- [ ] Round-trip test: every kind's descriptor survives export/import
- [ ] Adding a fixture fourth kind requires no codec edit (test asserts)

### 2.3 Host dispatch

#### REQ-006: Facade parked-pull loop collapses to registry dispatch
durable-tool-session-facade.ts MUST handle parked pulls through one sequence:
registry lookup → miss fails closed (REQ-008) → hit performs
`resolver.perform(ctx, descriptor)` → canonicalize the result (strip
undefined members via JSON round-trip) → `validateResult` → command
`execution.resolve-pull` with `resolver.audience(descriptor)` and
`{status:"ok", value}` → rejected resolution throws `resolution_rejected` →
loop continues. Per-kind finder functions (`findSamplePull`,
`findForeignPull`) MUST dissolve into generic journal reads feeding the
dispatch.

**Source**: DR-001, Decision 3

**Rationale**: Three duplicated find→perform→resolve sequences become one;
canonicalization becomes universal rather than sample-specific.

**Acceptance Criteria**:
- [ ] Single parked-handling path; no branch mentions "sample"/"foreign"
- [ ] Rich tool results with undefined members settle successfully
- [ ] Rejected resolution surfaces `resolution_rejected`

#### REQ-007: Engine routes parked reasons through resolvers
program-driver-chat-engine.ts MUST replace the sample-specific auto-resolution
loop with registry dispatch: hit → perform + resolve + bounded re-run; miss →
existing pendingElicit/interrupt projection, else RUN_ERROR `PROGRAM_PARKED`.
After this specification lands the engine source MUST NOT contain the string
"sample" outside comments referencing this requirement.

**Source**: DR-002

**Rationale**: A chat driver must not know what sampling is; it routes
interactions.

**Acceptance Criteria**:
- [ ] Engine registers the model-sampling resolver via `modelSamplingService`
- [ ] Source scan shows no functional reference to sample specifics
- [ ] Multi-turn sampling scenarios pass through the routed path

#### REQ-008: Fail-closed for unregistered kinds
A host parking on an unregistered kind MUST produce the established error
envelope: facade throws `unsupported_park` naming the kind; executor relays
return `foreign_ask_unanswered` when a relay slot is absent. Behavior MUST be
byte-compatible with current failures so existing negative tests pass
unchanged.

**Source**: DR-003

**Rationale**: Dispatch generality must not weaken the ratified no-defaults
posture.

**Acceptance Criteria**:
- [ ] Facade test: unknown park reason → `unsupported_park`
- [ ] Executor test: missing relay slot → `foreign_ask_unanswered`

### 2.4 Authoring surface

#### REQ-009: Adapter exposes one generic pull boundary
The workflow tool-adapter SHOULD expose a single generic
`pull(descriptor): Operation<Json>` context member; existing authoring sugar
(`ctx.sample` via durable-create, `ctx.foreignTool`) SHOULD delegate to it.
Kernel/runtime layers MUST NOT gain additional per-kind context members when
new interaction kinds are introduced.

**Source**: DR-006

**Rationale**: Authors keep ergonomic names; the runtime keeps one mechanism.

**Acceptance Criteria**:
- [ ] Sugar methods delegate to the shared boundary (call-graph verified)
- [ ] All parity vectors produce byte-identical journals post-refactor

## 3. Non-Functional Requirements

### NFR-001: Parity preservation
All seven parity vectors MUST yield identical journals, execution forests, and
results before and after the refactor. Any divergence halts the stretch.

**Rationale**: The refactor changes control flow only; observable durable
behavior is frozen by the campaign contract.

### NFR-002: Module hygiene
No new import cycles (module-graph validator clean); kind modules MUST NOT
import facade or engine code; static imports only (no dynamic imports).
exactOptionalPropertyTypes strict typing throughout.

### NFR-003: Net reduction
The change MUST delete more production lines than it adds across the seven
flagged sites (facade branches, engine loop, decisions/support switches,
snapshot enumeration, adapter duplication).

## 4. Interfaces

### 4.1 PullResolver (TypeScript, exported from @sweatpants/journal-authority)

```ts
interface PullResolutionContext {
  readonly sessionId: string;
  readonly taskId: string;
  readonly pullId: string;
}

interface PullResolver {
  readonly kind: string;
  audience(descriptor: Json): string;
  validateResult(descriptor: Json, value: Json): ParseResult<Json>;
  perform(ctx: PullResolutionContext, descriptor: Json): Operation<Json>;
}

type PullResolverRegistry = ReadonlyMap<string, PullResolver>;
```

### 4.2 PullKindPolicy (declared per kind module)

```ts
interface PullKindPolicy {
  readonly descriptorParser: Parser<Json, Json>;        // shared with snapshot codec
  audience(descriptor: Json): string;
  validateResult(descriptor: Json, value: Json): ParseResult<Json>;
  reserveGate?(descriptor: Json): void;                 // throws CrankError on violation
}
```

### 4.3 Data flow (parked pull)

```
driveActivation returns { state:"parked", pullId, reason }
  → host reads PullRequested record (generic journal read)
  → registry.get(reason)
      ├── undefined → fail closed (REQ-008)
      └── resolver.perform(ctx, descriptor)
            → JSON canonicalize (strip undefined)
            → validateResult
            → authority.query(pull.resolution-capability)
            → authority.command(execution.resolve-pull, {capability,
               audience: resolver.audience(desc), outcome:{status:"ok",value}})
                  └── rejected → throw resolution_rejected
  → next activation replays settled pull
```

## References
- Design Document: [.pi/specs/pull-resolver-registry-design.md](.pi/specs/pull-resolver-registry-design.md)
- Related Specifications: effection-workflow-runtime-spec.md (REQ-019/020/021),
  journal-authority-kernel-spec.md (pull ledger semantics)
- Evidence: .pi/evidence/authority-backed-effection-workflow.md
