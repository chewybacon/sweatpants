# Framework DX Findings from Deterministic Acceptance

Status: Follow-up backlog

This document records framework authoring friction exposed while building
`@sweatpants/framework-acceptance`. These are not failures of the test rig.
They are framework/runtime seams that forced the acceptance fixture to know
more about execution plumbing than an application author should.

The findings are ordered by recommended implementation priority. Correctness
fixes discovered by the same work are listed separately as closed findings.

## F1 — Worker invocation is untyped and shape-driven

**Priority:** P1  
**Status:** Implemented in the first follow-up  
**Owner:** `@sweatpants/tool-runtime-local/worker` and the Vite worker generator

### Evidence

The acceptance worker has to invoke an authored `ToolDefinition` through an
unsafe cast:

```ts
const invoke = yield * (acceptanceBookingTool as any)(ctx);
return yield * invoke(params);
```

The generated yo-chat worker repeats that cast for every tool and additionally
falls back through three runtime shapes:

1. callable with a `capabilities` property,
2. object with an `execute` property,
3. directly callable handler.

This logic is emitted by `packages/vite-plugin/src/tool-discovery.ts`, so every
generated worker inherits the same unchecked protocol detection.

### Impact

- Contract/runtime incompatibility is discovered in the worker at runtime,
  not by TypeScript.
- The generator duplicates protocol knowledge owned by core tool authoring.
- Adding another tool shape expands generated branching rather than one
  audited adapter.
- Acceptance fixtures must copy implementation details from generated output
  to prove they exercise the same path.

### Resolution

`createWorkerTool(tool: RuntimeTool): WorkerTool` now constructs a complete
canonical tool context over the worker transport: tool-local `messages`, named
and generic sampling, canonical exchanges, typed elicitation, three-argument
notification, logging, and cancellation. Application and generated code no
longer cast contexts to `any`, and generated workers no longer perform shape
dispatch. Worker generation rejects legacy `.build()` authoring with migration
guidance; registry-only discovery can retain legacy compatibility.

## F2 — Worker-entry bootstrap is handwritten boilerplate

**Priority:** P1 (after F1)  
**Status:** Implemented in the first follow-up  
**Owner:** `@sweatpants/tool-runtime-local/worker`

### Evidence

The acceptance fixture must manually:

1. convert each authored tool into a `{ name, handler }` entry,
2. create a worker registry,
3. call `runWorker(registry)`, and
4. install process-level error handling.

The Vite generator emits the same structure. A test fixture should describe
its tools, not reproduce worker bootstrap conventions.

### Impact

- Generated and handwritten workers can drift in startup/error behavior.
- Correct single-authoring of tools requires intimate knowledge of the worker
  protocol.
- Every non-Vite consumer must invent a worker entry.

### Resolution

`runToolWorkerEntry([bookingTool, calculatorTool])` now adapts canonical tools,
creates the registry, and runs the worker. Generated and acceptance entries
use top-level `await`, so startup/terminal errors propagate through module
loading consistently. Lower-level `runWorker` and `createWorkerToolRegistry`
exports remain available for runtime tests and advanced transports.

## F3 — Local runtime installation does not install its durable foreign effects

**Priority:** P1  
**Status:** Implemented in the first follow-up  
**Owner:** `@sweatpants/tool-runtime-local`

### Evidence

A sampling-capable ordinary tool used through the durable Program Runtime
requires two separate setup calls over the same registry and tool set:

```ts
yield *
    ProgramDriverForeignEffectsContext.set(
        createToolSessionForeignEffectRegistrations({ registry, tools }),
    );
yield * installLocalToolRuntime({ tools, registry, samplingProvider });
```

Omitting the first call fails nested `ctx.sample()` with
`foreign_sampling_driver_required`, even though the local runtime was
otherwise installed successfully. The acceptance app and yo-chat composition
both repeat this pairing.

### Impact

- A valid-looking installation fails only when a tool reaches a foreign effect.
- Registry and tool maps can diverge between the two calls.
- The requirement is especially surprising because `.samples()` explicitly
  declares the capability on each authored tool.

### Resolution

`installLocalProgramToolRuntime` now composes the worker-backed local runtime
with durable foreign-effect registration using the same required registry and
tool list. Plain `installLocalToolRuntime` remains unchanged. The acceptance
fixture and yo-chat local composition use the helper; AgentCore retains an
explicit registration because it is not a local-runtime composition.

## F4 — Worker mode imports an executable host-side tool closure that cannot run

**Priority:** P2  
**Owner:** core tool artifacts and local runtime registration

### Evidence

`installLocalToolRuntime` receives full `RuntimeTool` objects. In worker-backed
mode the session registry uses the host object for name/schema validation, but
execution happens only in the worker identified by `workerUrl`. The authored
execute closure is therefore present in the host process even though that
mode cannot invoke it.

The acceptance fixture makes this visible by importing one tool definition
into both host setup and worker entry. This preserves single authorship, but
host registration unnecessarily loads implementation-only imports such as
`node:worker_threads`.

### Impact

- Host bundles can include worker-only dependencies and side effects.
- The API does not communicate whether a supplied implementation is executable
  in the current substrate.
- Tests can accidentally pass through inline execution unless worker identity
  is asserted explicitly.

### Recommendation

Let worker-backed registration consume a portable authored contract/artifact
projection (identity, schemas, capabilities, annotations) separately from its
implementation closure, while retaining a single source definition for tool
authors. A build helper can project the host artifact and worker executable
from that one definition.

Do not solve this by duplicating a metadata-only host stub; that recreates the
single-authoring defect the acceptance fixture was designed to prevent.

## F5 — History compaction and interrupted-call policy lacks an explicit owner

**Priority:** P2  
**Owner:** chat session/history policy, not the pi-ai provider adapter

### Evidence

The previous pi-ai normalizer compacted completed historical tool call/result
pairs after an assistant summary. That lost causal records needed by follow-up
turns. The new contract preserves completed pairs and performs only
wire-safety repair:

- hanging tool calls with no result are dropped,
- orphan results with no preceding call are dropped.

The chat session already records cancellation for the normal cancel-on-send
path. Provider-boundary repair is therefore a last-resort safety net, not the
right place to decide semantic retention or token budgeting.

### Impact

Without an explicit policy layer, token optimization can silently become data
loss, while malformed interrupted history can leak to providers.

### Recommendation

If automatic compaction is needed, define it as an opt-in chat history policy
with context such as token budget, turn age, and tool outcome. It should:

1. run before provider adaptation,
2. preserve completed pairs by default,
3. record interrupted/cancelled calls explicitly when possible,
4. expose compaction decisions to diagnostics, and
5. have deterministic acceptance coverage for follow-up questions that depend
   on tool arguments/results.

The provider adapter should continue to enforce wire validity only.

## Closed finding — Failed request tasks killed conversation ownership

**Status:** Fixed by the negative-path acceptance expansion

A Program Runtime/tool failure was emitted as `RUN_ERROR` and then rethrown by
the spawned client request task. Effection propagated that child failure into
the long-lived session owner, preventing later sends. Request tasks now report
failure through events/lifecycle callbacks and terminate without killing the
command loop. Turn barriers settle only after request-task join and error-path
history synchronization.

## Closed finding — Error/cancellation history projection

**Status:** Fixed by the negative-path acceptance expansion

Errored durable tasks and unsupported/invalid calls previously left no tool
result in follow-up model history. Journal projection now emits one structured
error result for unfinished calls, and the client persists mirrored call/result
messages before surfacing `RUN_ERROR`. Cancel-on-send uses Program Runtime
cancellation instead of resuming tool business logic with a normal cancel
response.

## Closed finding — Durable child sampling provenance

**Status:** Fixed by the durable-tool acceptance migration

A crank-native tool fixture initially had to know the internal
`TOOL_OWNED_SAMPLE_CLASSIFICATION` to prevent its nested `context.sample()`
text from streaming into the outer chat turn. The Program Runtime already
provides stronger provenance: the sampling execution context identifies the
child task separately from the root chat task. The chat engine now permits
outer streaming only for the root task and retains explicit classification for
foreign ToolSession adapter samples. This changes no journaled request
descriptors and remains replay-compatible.

## Closed finding — Vendor-name activation fencing

**Status:** Fixed by the test-rig implementation

Framework logic previously selected activation fencing with
`driverKind === "agentcore"`. Bindings now declare the capability explicitly
with `activation: "fenced"`, and the chat engine uses that declaration.
Tests establish that behavior follows capability rather than vendor string.

A possible follow-up validation could reject known remote application routes
that omit the declaration, but the framework should not reintroduce a vendor
name to infer it.

## Recommended sequence

1. **F1 (done):** typed authored-tool → worker adapter; generator and fixture migrated.
2. **F2 (done):** worker-entry helper built on the adapter.
3. **F3 (done):** explicit composition helper for local runtime + durable effects.
4. **F4:** portable host artifact projection for worker-backed registration.
5. **F5:** design history compaction only when a concrete token-budget use case
   exists.

F1–F3 now have direct unit/integration coverage, and the canonical nested-
sampling acceptance scenario traverses their composed path. F4 and F5 affect
broader architecture and should go through design/spec planning before
implementation.
