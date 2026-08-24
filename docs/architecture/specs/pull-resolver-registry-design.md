# Design: Pull Resolver Registry: Unifying External Interaction Kinds

## Status
Draft — awaiting review

## Overview
Unifies elicit, sample, foreign, and child interaction handling behind a single
PullResolver registry so that adding a new interaction kind touches one module
instead of seven files. Replaces per-kind control-flow branches in the facade
and chat-engine with generic parked-pull dispatch driven by resolver
registrations declared alongside each kind's definition. This is the first
stretch of Checkpoint 3 in the effection-workflow-runtime cutover campaign; it
must land before fenced-substrate migration and physical deletion so those
phases convert each site once, against the final shape.

## Goals
- One generic parked-pull dispatch path in every host layer (facade,
  chat-engine); zero per-kind `if (descriptor.kind === …)` control flow above
  the kernel.
- Each interaction kind declares its own policy (resolution audience,
  durability gate, result validation) and transport (resolver) in its own
  module; the kernel keeps named, schema-validated descriptors as data.
- Adding a fifth interaction kind requires exactly one new module plus one
  registration, and zero edits to kernel, facade, engine, or snapshot codec.
- Net code reduction: facade loses two branches, chat-engine loses the
  sample-specific loop, decisions/support deduplicate.

## Non-Goals
- Renaming or generalizing kernel pull kinds into a single opaque kind —
  named descriptors with schema validation are correct data modeling and stay.
- Unifying child composition (`invoke`/`spawn`) into the resolver transport —
  children close themselves and restore parents via snapshots; they share the
  pull shape but not the resolution protocol. Their facade branch stays but
  shrinks to a registry lookup.
- Changing the worker-boundary foreign execution model (session-bound live
  calls, ephemeral_handle-only, death = error) ratified in CP2.
- Touching the agentcore sandbox evaluator or local-program-driver retention.

## Requirements

### Dispatch uniformity
- **DR-001 (Must):** The facade's parked-pull handling MUST dispatch through a
  resolver registry keyed by descriptor kind; no per-kind branches remain for
  elicit, sample, or foreign. Child composition MAY remain a distinct branch
  (see Non-Goals).
- **DR-002 (Must):** The chat-engine's sample auto-resolution loop MUST be
  replaced by a sample resolver registration; the engine source MUST NOT
  reference the string "sample" after this design lands.
- **DR-003 (Must):** A host that parks on a kind with no registered resolver
  MUST fail closed with the existing error semantics (`unsupported_park`,
  `foreign_ask_unanswered`), unchanged from current behavior.

### Kind self-description
- **DR-004 (Must):** Each pull kind MUST declare, in its defining module: the
  descriptor schema, the resolution audience derivation, the result validation
  rule, and any reserve-time durability gates. The decision pipeline and
  support helpers MUST consume these declarations generically instead of
  switching on kind.
- **DR-005 (Must):** The authority snapshot schema MUST validate pull
  descriptors against the same kind registry the parser uses, eliminating the
  hand-enumerated descriptor union in durable-authority-snapshot-schema.ts.
- **DR-006 (Should):** The adapter context SHOULD collapse to one generic
  `pull(descriptor)` boundary; `ctx.sample` / `ctx.foreignTool` authoring
  sugar survives in durable-create (agent-sdk) as thin wrappers over it.
- **DR-007 (Should):** Parity vectors (7 total) and all package test suites
  MUST stay green throughout; journals and execution forests for every parity
  vector MUST be byte-identical before and after the refactor.

## Design Decisions

### Decision 1: Resolver interface lives in journal-authority; transports live with their kinds
- **Context**: The registry type must be visible to the kernel layer (for
  policy consumption) and to hosts (for registration), while transports need
  diverse dependencies (invocation host, sampling service, relays).
- **Decision**: `PullResolver` interface + `PullResolverRegistry` are exported
  from journal-authority root:

```ts
interface PullResolver {
  readonly kind: string;
  audience(descriptor: Json): string;
  validateResult(descriptor: Json, value: Json): ParseResult<Json>;
  perform(ctx: PullResolutionContext, descriptor: Json): Operation<Json>;
}
```

  `PullResolutionContext` carries `{ sessionId, taskId, pullId }` plus the
  host-provided closure state (tools map, relay, sampling service). Kinds ship
  as modules: `kinds/elicit.ts`, `kinds/sample.ts`, `kinds/foreign.ts`, each
  exporting its descriptor schema + default policy. Hosts compose registries:
  the facade builds one from options (`foreign.tools`, `asks`, sampler),
  the engine registers the model-sampling resolver, tests register fixtures.

### Decision 2: Policy tables replace kind switches in decisions/support/snapshot
- **Context**: authority-decisions.ts:1924-1927 and authority-support.ts:163-169
  switch on kind for audience/durability/result rules;
  durable-authority-snapshot-schema.ts:91-103 hand-enumerates descriptor shapes.
- **Decision**: Each kind module exports a `PullKindPolicy` object consumed by:
  the decision pipeline (reserve/resolve rules), support helpers (result
  descriptor + audience derivation), and the snapshot schema (descriptor
  variant built from the kind's parser). The snapshot codec iterates the
  registry to build its union — one source of truth for "what shapes exist."

### Decision 3: Facade loop collapses; child branch remains distinct
- **Context**: durable-tool-session-facade.ts currently runs three parallel
  find→perform→resolve→continue sequences plus a child branch.
- **Decision**: The activation while-loop becomes: park → lookup resolver →
  `perform` → canonicalize (`JSON.parse(JSON.stringify(...))` strip already
  proven necessary for rich tool results) → `resolve-pull(audience, ok)` →
  continue. Children keep their branch because resolution is *achieved by
  running another program*, not by returning a value; forcing it through
  `perform` would bury snapshot export/import inside a callback. The child
  branch reduces to a registry-style lookup over `options.children`.

### Decision 4: Engine registers resolvers; parking reasons route generically
- **Context**: program-driver-chat-engine.ts:556 hardcodes sample
  auto-resolution inside the activation driver loop.
- **Decision**: The engine accepts `pullResolvers?: PullResolver[]` (or builds
  them from `modelSamplingService`) and its parked handling becomes: try
  registry → if hit, perform+resolve+re-run (guard stays); if miss, fall
  through to pendingElicit/interrupt projection → RUN_ERROR. The fenced legacy
  branch is untouched until remote-substrate migration.

## Constraints
- exactOptionalPropertyTypes strict mode active across packages; resolver
  option fields must use explicit optional members, not conditional spreads of
  undefined.
- No dynamic imports anywhere in the refactor (owner directive).
- Module-graph validator forbids import cycles; new kind modules must be
  leaves or depend only downward (kind modules must not import facade/engine).
- Journals are canonical JSON; resolver results must pass canonical
  validation — the facade's undefined-stripping step becomes part of the
  generic dispatch, not a sample special case.
- Zero-legacy endstate contract: this stretch must not add code that the
  deletion manifest will immediately remove.

## Dependencies
- Internal: journal-authority (kernel pulls, decisions, snapshot codec),
  tool-runtime-local (facade, foreign-tool-session executor), agent-sdk
  (durable-create sugar), model-sampling (`executeModelSamplePull`),
  durable-chat-runtime (engine).
- Internal: green gate baseline — journal-authority 160, tool-runtime-local 58
  (0 skipped after unskip work), acceptance 6, durable-chat-runtime 91,
  agent-sdk 159; exports + module-graph validators clean.
- External: none new; effection Operation semantics unchanged.

## Research Notes
All sites cited against the working tree at the time of writing:

- `packages/journal-authority/src/workflow/tool-adapter.ts:124-137` — adapter
  `foreignTool` method with inline ephemeral_handle gate; sibling
  `sampleModelPull` at :121; both lower onto workflow ops (`runtime.ts`
  helpers `foreignTool()`, `modelSample()`).
- `packages/journal-authority/src/authority-decisions.ts:1918-1932` —
  resolution-mode switch enumerating child kinds then `foreign`/`sample`
  returning identical `{kind:"participant", …}` — the duplicate arms that
  motivated this design.
- `packages/journal-authority/src/authority-support.ts:158-175` — per-kind
  switch deriving result descriptor + audience; foreign arm duplicates the
  ephemeral gate also present in the adapter and decisions.
- `packages/journal-authority/src/durable-authority-snapshot-schema.ts:62-103`
  — descriptor union enumerates effect/elicit/wait/invoke/foreign/spawn;
  `sample` was missing here and caused `Invalid durable authority snapshot`
  on second facade activation (fixed ad hoc during ordinary-harness unskip;
  this design removes the class of bug).
- `packages/tool-runtime-local/src/durable-tool-session-facade.ts` — options
  block :100-112 (`children`, `foreign {tools, asks}`); parked branches at
  ~340-430 (foreign, sample, elicit) each repeating find→perform→resolve;
  finders at :471-545; canonicalization precedent added at the sample branch
  (`JSON.parse(JSON.stringify(...))` for rich RuntimeTool results).
- `packages/tool-runtime-local/src/foreign-tool-session.ts` —
  `executeForeignToolCall` (:516+) over invocation-host `turnOnce` loop with
  ask relays; fail-closed codes `foreign_ask_unanswered`,
  `foreign_reference_lost`. Becomes the foreign kind's transport module.
- `packages/durable-chat-runtime/src/durable-handler/program-driver-chat-engine.ts:550-614`
  — guarded sample auto-resolve loop calling `journal.withAuthority` +
  `executeModelSamplePull`; replaced by resolver registration under DR-002.
- `packages/model-sampling/src/effect.ts` — `executeModelSamplePull` helper
  (decode → resolve sources → service call) reusable verbatim as the sample
  resolver body.
- Invocation-host double-fire finding: two distinct requestIds per authored
  `ctx.sample` observed via executor probes
  (`foreign-tool-session.ts` turn loop); dedupe scaffolding currently masks it
  in facade-foreign-execution.integration.test.ts. Root cause localized to
  post-resume crank re-emission in the local inline execution path; tracked as
  an open item resolved separately (see Open Questions).

## Open Questions
None blocking. Two items are deliberately deferred with owners:
1. Fenced-substrate design (remote children on workflow runtime) — separate
   sitting, unaffected by this refactor.
2. Invocation-host sample re-emission — the registry does not change crank
   replay semantics either way; the masked dedupe in
   facade-foreign-execution.integration.test.ts stays until the crank fix
   lands, then the assertion tightens to `toBe(1)` and the Set is deleted.

## Addendum: Peer authorities are explicitly future (ratified)

Three-case taxonomy ratified with owner: (1) within-authority interactions
(elicit/sample), (2) external protocol-unaware tools (foreign — park, live
call, verbatim journal), (3) peer agent loops with independent authority.
Case 3 is a DIFFERENT primitive (cross-journal message correlation, two logs,
no shared authority) and is deliberately unbuilt. It must not ride the foreign
kind or any pull kind; it enters later as its own top-level concept. Registry
frozen: no new kinds/abstractions until a real consumer appears. Reference:
.pi/specs/boundaries-and-logs.md
