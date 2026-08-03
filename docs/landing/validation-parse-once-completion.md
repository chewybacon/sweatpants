# Validation Parse-Once Completion — Implementation Memo

## Status

Completed migration memo for the revised **Trust Topology and Contract Flow Completion** design. The v2
shape-owner inventory was a temporary diagnostic and migration queue; it was retired after the owning
parsers and permanent package tests landed.

This memo distinguishes completed evidence from planned work. Individual slices have deterministic landing artifacts; it is not yet the final repository-wide completion attestation.

## Implemented in this change

### Historical inventory v2 migration evidence

- Evolved the temporary validation-boundary inventory to its v2 migration format before retiring it.
- Retained the 86 historical `VAL-*` validation-boundary records.
- Added stable `SHAPE-*` records for production owners that inspect unknown, JSON, decoded, persisted, provider, or extension values.
- Added the `B`, `R`, `S`, `G`, and `C` classification vocabulary.
- Added AST owner discovery for functions, methods, callbacks, and module initializers.
- Added exact inventory drift detection for newly introduced and stale shape owners.
- Added validation requiring authority evidence for `B`/`R`/`S` and a rationale for every `G`/`C` exception.
- Retained the direct decode-to-domain cast gate.

Current inventory totals:

| Record | Count |
| --- | ---: |
| Historical validation records | 87 |
| Manual shape owners | 319 |
| `B` external boundary | 105 |
| `R` same-domain revalidation | 151 |
| `S` typed semantic verification | 15 |
| `G` generic mechanism | 6 |
| `C` compatibility normalizer | 41 |

The counts are evidence indicators, not completion criteria or an edit queue. Owners are reviewed when their vertical producer-to-consumer trust flow is migrated; deletion follows from establishing the upstream authority.

### Tool Runtime Local foreign sessions

`packages/tool-runtime-local/src/foreign-tool-session.ts` now uses strict package-owned Zod schemas for:

- continuation state;
- durability discriminants;
- sample responses and nested tool calls;
- parse errors; and
- elicitation responses.

The ingress returns typed values to internal consumers. Historical provider `calls` and `content` arrays are accepted only at the named sample-response compatibility seam, bounded to 256 entries, and omitted from canonical internal output. Malformed durable or protocol values fail through the existing controlled foreign-tool error family.

### CLI collection and archive loading

`packages/cli/src/remote-development/collection.ts` now exposes explicit parse-then-verify flow:

```text
JSON bytes -> unknown -> strict archive/manifest schema
  -> typed manifest -> digest/path/pin semantic verification
```

Strict schemas own archive, manifest, builder, target, program, file, digest, bounded-string, count, and unknown-field policy. Typed verification retains collection digest, artifact integrity, program identity, compatibility-major, ordering, duplicate, entrypoint, and safe-path authority. The obsolete `parseCollectionFile`, exact-key helper, and nested manual shape tree were removed.

### Durable Execution restoration

`packages/durable-execution/src/transitions.ts`, `checkpoint.ts`, `program-identity.ts`, and `program-context.ts` now use strict package-owned Zod schemas for persisted Terminal Capsules, Recovery Checkpoints, artifact identity inputs, resumed operation outcomes, child descriptors, task handles, and effect resolvers. The schemas close all nested owned structures, including program identities, stored JSON variants, durable references, projection frontiers, parked task topology, pending inputs, and required child outcomes. Artifact identity orchestration explicitly performs outer parse, nested durable-manifest parse, then digest/provenance verification without a parser-return cast. Count, integer, finite-number, discriminant, digest, and unknown-field policies are proven before returning canonical domain values. Existing transition error ownership and checkpoint rejection semantics are preserved; terminalization, quiescence, activation fences, revision, retry-safety, and provenance decisions remain typed semantic authority.

### Durable Chat requests and interrupt restoration

`packages/durable-chat-runtime/src/handler/request-normalization.ts` now keeps raw-message normalization inside the established strict request schema trust domain. The typed normalizer no longer repeats array, record, tool-call, or function-field shape checks. The obsolete `normalizeChatRequestBody` same-domain forwarding API was deleted rather than retained as a compatibility alias. Model-authored tool arguments now remain designed-open `Json` through provider, chat, worker, and replay carriers; JSON string decoding occurs at the encoding owner, while the authored Standard Schema narrows exactly once at `execute(args, ctx)`.

`packages/durable-chat-runtime/src/interrupts/store.ts` now treats JSON restoration as a new trust boundary and strictly parses the complete persisted interrupt collection. Closed schemas prove identities, status, timestamps, optional execution references, canonical continuation/response-schema slots, metadata, and collection bounds before returning `OpenInterruptRecord[]`. Invalid persisted JSON or structure now fails closed instead of being cast or silently treated as absent.

`packages/durable-chat-runtime/src/response-streams/conversation-checkpoint.ts` is now the sole versioned conversation-checkpoint codec. It owns the closed persisted AG-UI event envelope, nested message/tool/interrupt/replay structures, distinct collection bounds, total byte bounds, encode/decode symmetry, and malformed/version rejection. The event stream writes through `encodeConversationCheckpoint`; the durable handler restores only through `decodeConversationCheckpoint` and maps codec failure to the existing `CrankError` boundary. The former weak `z.record(z.string(), z.json())` array and `as unknown as StreamEvent[]` restore path were deleted.

Checkpoint persistence is explicitly short-term best effort: encode, replay, storage, and replacement failures are observable but cannot fail an already-completed chat turn. Checkpoints now write immutable version artifacts, publish a complete pointer, and compact the previous pointer/artifact only after publication; the last valid restore point survives failed replacement. Pointer slots use O(1) tail reads where the durable buffer provides them, while full checkpoint snapshots are never accumulated in one version log. The current 8 MiB total bound remains a protective operational limit; no message truncation or history-windowing is silently introduced. Test Rig treats any observed checkpoint error as a teardown failure. Long-term full-history segmentation versus whole-turn checkpoint compaction remains a separate product decision.

`packages/durable-chat-runtime/src/durable-handler/local-program-host.ts` now parses restored pinned program catalogs with a closed nested schema covering program and foreign-tool variants, pinned identities, durability discriminants, target keys, and digest syntax. The parser delegates catalog digest and key/target consistency to `verifyPinnedProgramCatalog`. Typed in-memory request paths call only the semantic verifier, eliminating same-domain structural reparsing. The obsolete `parseCatalog` API and parser-return cast were removed.

`program-driver-tool-runtime.ts` now strictly parses durable continuation state and nested `ToolExecutionRef` values. The former scalar-to-object tool-input adapter was deleted because wrapping non-object input as `{ input: value }` changed model-authored meaning before the authored validator. `program-driver-schema.ts` retains Standard Schema as the authored registry contract but delegates the framework-owned chat program input structure to a strict private Zod schema. Catalog digest verification remains typed semantic logic after parsing.

### Workspace Runtime protocol boundaries

`packages/workspace-runtime/src/index.ts` now uses strict package-owned schemas for every request and response variant and the nested activation fence. The schemas close protocol envelopes and prove versions, discriminants, identities, revisions, line bounds, output variants, list counts, and unknown-field policy. Path containment, activation-fence equality, mutation revision, digest progression, script allowlisting, and output byte totals remain typed semantic checks. Manual record, exact-key, primitive field, array, and response-return casts were removed. The public `WorkspaceService.execute` API retains its own parser because its structural interface cannot prevent arbitrary extension callers from constructing malformed objects; ordinary internal operation calls use parsed values. `sandbox-substrate.ts` now strictly parses the complete provider capability object, including mandatory finite request/response support and the workspace-persistence discriminant, while checkpoint capability consistency remains typed semantic verification. Workspace Runtime now declares its runtime Zod dependency through the pinned catalog and has no remaining production manual object/array shape owner.

### Journal Authority parse-once restoration

Journal Authority remains intentionally free of Zod, as enforced by its package-boundary charter. The existing `parseDurableAuthoritySnapshot` remains the sole schema-vendor-neutral structural restoration boundary for its canonical persisted snapshot DTO. `InMemoryDurableJournalAuthority.#restore` now consumes only that parsed snapshot or the trusted output of `exportSnapshot` and no longer repeats version/task/record shape checks. Descriptor and outcome canonicalization likewise no longer rechecks typed discriminants after `canonicalSnapshot`; durable manifest, operation, schema-registry, replay, fence, cancellation, and state-transition semantics remain with Journal Authority.

### Tool Session foreign and MCP contracts

`packages/tool-session/src/foreign-contract.ts` keeps Standard Schema V1 as the durable/user-facing registry contract while strict private Zod schemas now own framework foreign start and continuation structure. Driver/tool identities, canonical input/state/response values, durability and response discriminants, optional route policy, bounds, and unknown-field closure are proved before the Standard Schema callback accepts the value. `mcp/durable-invocation.ts` now strictly parses the closed durable invocation metadata envelope, including format, UTF-8 idempotency-key bounds, and inventory digest. Manual generic record, exact-key, array, and primitive-field trees were removed; inventory-generation and invocation identity semantics remain typed code.

### Tool Session MCP decoding and compatibility adapters

`packages/tool-session/src/mcp/protocol/message-decoder.ts` now parses JSON-RPC request, notification, response, tools/call, elicitation, sampling, and nested MCP content envelopes through strict schemas before typed decoder logic. The decoder no longer owns generic record or exact-key predicates for those envelopes; response and tool-call classification proceeds from parsed discriminants.

`packages/tool-session/src/mcp/handler/request-parser.ts` now uses bounded Zod schemas for JSON-RPC request, notification, response, elicitation-result, and sampling-result recognition. The notification schema explicitly rejects an `id`, preserving request-versus-notification semantics. Existing MCP error families, session requirements, method support, and compatibility classification behavior remain unchanged.

`packages/tool-session/src/elicit-context/decode.ts` now treats the `x-elicit-context` extension as a bounded canonical JSON-object slot. The caller-authored `TContext` remains the public semantic contract; malformed or non-object extension values safely produce an empty context without forwarding unchecked nested values.

`packages/tool-session/src/mcp/handler/session-manager.ts` now parses sampling content through one owned text-block compatibility representation before projecting it to the wire sample result. Non-text MCP blocks are omitted from array content as before, while object and scalar legacy forms retain their existing fallback behavior. `tool-inventory.ts` likewise uses one canonical JSON-object projection parser before removing schema metadata keys.

### AgentCore durable protocol and provider boundaries

`packages/tool-runtime-agentcore/src/durable-protocol.ts` now strictly parses the closed AgentCore durable envelope before dispatching typed payload semantic verification. Envelope structure, protocol scalar bounds, identity fields, optional attachment/action fields, canonical JSON payloads, and unknown-field policy are owned by one parser; allowed host/runtime message types, action-index relationships, replay-chain integrity, command semantics, affinity, and payload variants remain typed protocol authority.

`placement-sampling-authorization.ts` now strictly parses authenticated sampling claims, including nested remote-sample identity, digest syntax, permission tuple, classification count, and expiry field. Issuer/key, expected identity/digest equality, permission equality, and expiration remain authenticated semantic verification after parsing. `agentcore-aws-invoker.ts` now parses the optional SSE data envelope through one bounded JSON-object schema before handing the value to the existing AgentCore response parser. `durable-websocket-transport.ts` now parses the private placement route and optional development extension through canonical JSON-object schemas before placement/release semantic verification.

The Redis-backed stores retain their owning Zod boundary parsers. `execution-store-redis/src/execution-store.ts` now explicitly reconstructs the versioned payload and replay domain values from parsed schema fields, including omission-safe durable-reference normalization; execution control record semantic authority remains with Journal Authority.

### A2A foreign protocol values

`packages/a2a/src/foreign-validation.ts` now parses foreign A2A send results, tasks, task status, messages, artifacts, and parts with strict package-owned schemas after canonical-JSON bounding. Identity syntax, closed field policy, role variants, and exactly-one-content-field part policy are proved structurally, while canonical byte bounds, artifact/history/part counts, task-state mapping, timestamp validity, base64 syntax, and observation-conflict authority remain typed semantic checks. The direct Task/Message compatibility forms accepted by some HTTP+JSON implementations are preserved.

### CLI and Agent Host residue

CLI bundler schema-catalog extraction, evaluator-loaded durable-tool recognition, and AWS error classification now use bounded schemas instead of manual object/array inspection. Agent Host request-body records, elicitation accept-shaped outcomes, and Agent Card signing projections likewise parse before use; signing removal of empty extensions and A2A error families are unchanged.

### A2A protocol, peer, and discovery seams

`protocol.ts` now relies on its owning envelope schema and no longer repeats identifier, epoch, attachment, action-index, command-id, or payload-object checks after parsing. `peer-contracts.ts` parses requirement manifests and individual effect requirements with strict schemas while retaining digest, duplicate-name, and ordering authority. `peer-adapter.ts`, `peer-discovery.ts`, and `foreign-session.ts` parse remote profile and durable-invocation metadata before grant/manifest echo and binding-conflict verification. `foreign-discovery.ts` parses the foreign invocation pin envelope structurally and keeps expiry, guarantee, extension-evidence, and duplicate-risk decisions as typed semantics.

### Agent SDK and Chat Core boundaries

Agent SDK worker out-of-band message recognition now uses bounded schemas. Chat Core adopts its own pinned Zod dependency and parses AG-UI tool-call arguments, activity content, reducer arguments, stream tool-call arguments, and projected chat-turn history facts through canonical JSON-object schemas. The former plugin-replay compatibility normalizer was removed with the pre-release client contract rebuild.

### Durable Effects contracts and test rig history

`model-sampling` owns the framework-owned `model.sample` input, output, and cancellation-partial structures with strict schemas behind the durable Standard Schema registry contract. Effect-error code extraction also parses instead of inspecting. `test-rig` history normalization parses wire records and tool arguments through bounded schemas while remaining a deliberately tolerant provider-history projection.

### Durable Chat engine and client surfaces

The chat program-driver engine now parses canonical JSON records and tool-call arguments through owned schemas instead of local record predicates, and the wire projection module shares one parsed record mechanism. `platform-acceptance` NDJSON event unwrapping and `react-chat` session-identity tool naming parse their loose inputs before projection; `react-chat` also promotes Zod to a production dependency so its runtime import is declared, satisfying the concrete Zod-ownership charter.

### A2A caller-authoritative discovery

`packages/a2a/src/discovery.ts` now uses strict schemas for:

- caller-authoritative extension parameters;
- bounded skill mappings; and
- pinned program identities.

Duplicate skill mappings remain a typed semantic failure. URL/origin and skill-advertisement authority remain in their existing semantic verifiers. No parser-return cast is used.

### Acceptance boundaries use simulators

Acceptance tests now have a repository-wide tooling gate: they may not replace modules with `vi.mock`, use `createMockProvider`/fake external clients, or import package-private `__tests__` harnesses. A rare exception requires a substantive `boundary-simulator-escape-hatch:` rationale. The obsolete durable-chat reconnect demo—three tests built on a hand-written model provider—was deleted because the test-rig reconnect scenario already proves continuation after disconnect, offset replay, terminal completion, and exactly one real model request through the HTTP Responses simulator.

### Neutral model-provider contract and wire conformance

Protocol-neutral model/runtime types and `ModelProviderPort` now live in `@sweatpants/model-provider`. Chat Core and the concrete pi-ai adapter are sibling consumers of that narrow package; the pi-ai adapter no longer depends on Chat Core. The two former 286-line runtime type copies and Chat Core's provider-port owner were deleted without re-export aliases. Module-graph and package-charter gates enforce that the neutral package depends only on Foundation/Effection and the concrete adapter cannot import Chat Core.

Provider behavior tests no longer mock `@earendil-works/pi-ai/compat`. The provider is exercised through `test-rig`'s real HTTP Responses simulator, so the actual pi-ai client, SSE decoder, request projection, tool-call chunking, structured-response unwrapping, provider errors, and malformed-argument behavior are covered together. The simulator characterization records an important vendor fact: pi-ai repairs truncated JSON arguments and turns unparseable argument text into `{}` before Sweatpants receives it. The adapter now consumes pi-ai's typed discriminated content union directly instead of treating it as `unknown`. Tool arguments are transported as the best-effort object guaranteed by pi-ai; no second JSON-string protocol, generic parser, empty fallback, or field-by-field argument normalization remains in Sweatpants. Domain shape remains open until the authored Standard Schema executes. Assistant model provenance is a typed producer-owned `source` field rather than loose metadata inspected on replay; locally authored history falls back explicitly to the selected model instead of fabricating empty `api`/`provider`/`model` strings. Policy-only tests remain in the concrete provider package; wire conformance lives in `platform-acceptance`.

The provider now transports authored JSON Schema projections rather than re-deriving them. `createTool` computes and digests the portable projection once; inventory and provider types carry it as `JsonObject`. The provider-side schema-normalization implementation and duplicate sanitization walk were deleted. Runtime-supplied sampling schemas still use the single conversion at their actual authoring ingress. MCP `tools/list` and discovery manifests now follow the same rule: one shared projection reads parameter and elicitation schemas from the authored tool artifacts, rather than casting the tool to an ad-hoc legacy shape and re-running schema conversion twice. The local worker adapter also carries authored elicitation projections into the worker; the worker no longer inspects raw elicitation definitions or re-converts their response schemas. Hydra's standalone tool-authoring examples now compute their Ollama projection in `defineTool` and retain it with the validator instead of re-running `z.toJSONSchema` each time a registry is serialized.

A repository-wide authored-schema projection gate now rejects `toToolParameterJsonSchema(tool.parameters)` and `z.toJSONSchema(tool.parameters)` outside recognised authoring owners. Conversion of call-time `.inputSchema` and `.schema` remains legal because those call sites are the actual authoring ingress.

### Canonical Tool Session sampling messages

`@sweatpants/tool-session/messages` is now the sole owner of basic, MCP, tool-call, tool-result, and `ExtendedMessage` sampling history. The incompatible copies in the root contract and MCP tool types were deleted. A single sequence-aware `toModelMessages` adapter projects directly to `@sweatpants/model-provider`, resolving result names from preceding calls and rejecting orphan results instead of fabricating empty identity. The Durable Chat Runtime intermediate adapter, app-local provider-message adapters, synthetic sampling message IDs, duplicate guards, and OpenAI-shaped snake-case internal fields were removed. Worker IPC retains one real transport conversion using the canonical message union and explicit unsupported-content rejection.

### Canonical authored sampling contract

`@sweatpants/agent-sdk` now solely owns authored sample configuration, results, retry errors, tool definitions, and the generic `ToolSamplingCtx<TMessage>` surface. Tool Session and Tool Runtime Local specialize that contract with their stronger message carriers instead of redeclaring parallel MCP and Worker families. `SampleToolsResult` retains the helper's proven non-empty call tuple and literal `toolUse` stop reason; named sample requests retain typed options and authored output-schema evidence through `RuntimeTool` rather than reconstructing or casting it downstream. The spread-and-cast `toWorkerSampleConfig`, `toWorkerToolsConfig`, `toWorkerSchemaConfig`, and result canonicalizers were deleted. Agent SDK's `WorkerSampleRequest` and `WorkerSampleResponse` remain the only real serialized worker sampling DTOs; unused local MCP worker request/response copies were removed. A charter gate enforces one declaration owner and rejects return of the former forwarding adapters.

### Neutral Tool Runtime and exchange completion authority

`@sweatpants/tool-runtime` now owns the protocol-neutral execution port, strategy composition, execution references, continuation envelopes, portable inventory definitions, inventory context, and authored-contract projection. The former `@sweatpants/tool-session/chat-runtime` and `tool-inventory` facades and Chat Core's duplicate `ToolDefinition`, `ToolCapabilities`, and `ToolInventoryEntry` families were deleted. Chat Core retains only chat-specific exposure policy; Tool Runtime Local and AgentCore are sibling implementations of the neutral port.

The misleading `WireElicitResult` and `WireSampleResult*` names were replaced by `ElicitExchangeCompletion` and `SampleExchangeCompletion*`: transport-safe response facts that settle a pending exchange but do not pretend to contain local history. Real Worker envelopes now carry a `completion` field instead of flattening and reconstructing action/content/result fields. Agent SDK's `completeElicitExchange` is the single authority that runs the authored Standard Schema, retains defaults/transforms, preserves producer-owned correlation and context, and constructs `ElicitExchange`; Tool Session bridge and worker execution both call it. `completeSampleExchange` and the sample exchange constructors are likewise Agent SDK-owned. Continuation carriers now carry typed completions rather than `unknown`, deleting casts in both runtime drivers. Worker-side `content as T`, `Date.now()` elicitation identity, fabricated empty context, duplicate exchange construction, and empty sample-response fallback were removed.

### Settled model function-call authority

`@sweatpants/model-provider` now owns the sole settled `ToolCall`: an OpenAI-compatible decoded function-call shape whose arguments remain `Json`. The concrete pi-ai adapter performs the one real conversion from pi-ai's flat settled block, while partial stream events remain incomplete and separate. Chat Core, Tool Runtime, and Tool Session deleted their competing declarations and carry the provider-established call through history and execution without argument reconstruction. Model-provider content blocks wrap the settled call, and `toolcall_end` transports the settled call directly, preserving opaque thought signatures and provider-owned identity.

The paired settled result now follows the same seam. Model Provider solely owns OpenAI-compatible `ToolResultMessage` with `role: "tool"`, `tool_call_id`, required producer-known `name`, content, and explicit `isError`. Tool Session names its pre-correlation carrier `PendingSessionToolResult`; sequence-aware completion produces the settled Model Provider message. Chat Core carries tool name and failure directly instead of hiding identity in `replay.toolName`, and AG-UI/history projections reject orphan results rather than fabricating empty or `unknown` identity. Only the concrete pi-ai adapter translates to pi-ai's `role: "toolResult"`/camel-case vocabulary.

The unused `OllamaChatRequest`, `OllamaChatChunk`, and `ClientToolSchema` residue was deleted from Chat Core and its public exports. The old direct-Ollama Hydra examples and their app-local protocol DTOs were also removed; installed Ollama behavior remains owned by the concrete pi-ai adapter. A package-charter gate enforces sole `ToolCall` and `ToolResultMessage` declarations and prevents provider-specific request/chunk DTOs from returning to Chat Core.

### Durable model-sampling seam

`@sweatpants/model-sampling` now owns the current `model.sample@1` durable command, output, cancellation partial, retained validator catalog, scoped `ModelSamplingApi`, remote delivery API, and structured-result settlement. Authored Chat owns a distinct current `chat.model.sample@1` contract. Pre-release Chat contracts no longer carry V1/V2 type suffixes or embedded chat format markers; the descriptor and effect identity are the compatibility authority. Generic Durable Effects retains only placement evidence and generic post-resolution acknowledgement; Journal Authority no longer imports or branches on model-specific contracts. The old model-sampling files and exports were deleted from `@sweatpants/durable-effects` without forwarding aliases.

Model Provider owns the JSON-safe portable invocation, settled context messages, tool definitions, tool calls, and assistant response projection. A model-sample command wraps those provider-owned semantics with only durable tool binding, response mode, placement classifications, and opaque model preferences. Provider-produced tool arguments remain open `Json` through the portable assistant response, durable journal, chat-root loop, catalog route, and tool runtime, and are narrowed only by the authored tool parameter schema immediately before execution. Structured responses are decoded to `Json` once by model-sampling settlement before journaling; the authored Standard Schema remains the sole domain validator at the sample helper.

Durable Chat now computes a pure `ModelInvocationPlan` from the parsed command, authority-established program/task placement, selected model, history policy, and one atomic digested chat tool catalog containing both provider exposure and execution targets. `ModelSamplingApi` invokes the existing `ModelProviderPort`; the removed `Runtime` adapter, loose `Json[]` message reconstruction, role fallbacks, empty schema/description defaults, classification-based ownership inference, duplicate text/call/result bags, and downstream content-block parsing are gone. Root versus nested delivery derives from pinned program identity, and live deltas flow through the scoped middleware-aware Turn event API. The new placement policy is conservative: outer delivery remains Host-owned, while trusted private execution may own nested sampling; unavailable or unauthorized placement fails closed. Program authorization now forwards placement evidence into execution drivers rather than reconstructing it. Test Rig covers root Host and execution ownership through the real Responses simulator and HTTP binding, with passive executor evidence asserting exactly which owner handled the pull.

### Simulator-to-hook AG-UI testing authority

Test Rig now passively observes the same application response body consumed by Chat Core and React; it does not replace the AG-UI producer. A transform taps emitted NDJSON/SSE bytes without cloning the stream, validates the pinned AG-UI event vocabulary, tracks run/message/tool lifecycle, rejects obsolete public events, and exposes causal barriers to scenario scripts. React hook acceptance drives the real HTTP Responses simulator through pi-ai, Durable Chat, worker-backed tools, AG-UI, Chat Core, and `useChat`, then validates the emitted protocol and hook-visible result together across in-process and HTTP bindings. The scenario also proves activity separation and that private system prompts do not enter public events.

With that path authoritative, 29 mock-backed, synthetic-event, implementation-state, duplicate stream/HTTP smoke, simple export/helper, and upstream Effection suites were deleted (nearly 9,000 lines). Platform Acceptance also stopped running every semantic scenario through both bindings: semantics now run in-process, while HTTP is reserved for reconnect, streaming, connection isolation, generation replacement, cancellation propagation, and one complex parity flow. Pairwise A2A posture coverage replaced Cartesian binding coverage, removing 36 duplicate acceptance cases. Chat Core no longer directly tests reducer/class state arrangements; retained tests cover public functional contracts such as authoring, policy, replay bounds, projection facts, and a compact codec boundary. React Chat now relies on rendering and simulator-to-hook acceptance rather than mock plugin executors. Durable Chat retains authority/fencing/store/parser tests while model/tool/AG-UI/session/HTTP behavior is covered through Test Rig, React, and Platform Acceptance. A charter gate prevents mock providers, local AG-UI schema mirrors, and the removed internal-state suites from returning. The package-test coverage baseline was deliberately lowered after each deletion; it now records 1,043 collected package tests (1,019 passed, 17 skipped). The lower count is intentional consolidation, not missing imports.

### Retired Chat Core session projection

The intermediate `ChatState`/`createChatSession` client described by the original migration memo was
subsequently replaced by the first-class `@sweatpants/chat-client` runtime. Test Rig, React Chat, Ink,
and outside-in drivers now use that single client. Chat Core retains only framework-neutral AG-UI
codecs, immutable nested projection, provider-history conversion, frame types, and authored chat
programs; the fetch-oriented session machine, pending-elicit side state, and prototype execution tree
were deleted rather than preserved as a second pre-release client API.

## Validation performed

| Scope | Result |
| --- | --- |
| Validation inventory/tooling tests | 33 passed |
| Tool Runtime contract tests | 3 passed |
| Tool Runtime Local source tests | 40 passed |
| Tool Runtime Local acceptance tests | 6 passed |
| CLI tests | 14 passed |
| A2A tests | 48 passed, 1 live test skipped |
| Agent Host tests | 38 passed |
| Agent SDK tests | 155 passed |
| Chat Core tests | 39 passed |
| Durable Effects tests | 3 passed |
| Model Sampling tests | 6 passed |
| Test Rig tests | 21 passed |
| React Chat tests | 8 passed |
| Durable Execution tests | 25 passed |
| Durable Chat Runtime tests | 75 passed |
| Workspace Runtime tests | 18 passed |
| Journal Authority tests | 92 passed |
| Tool Session tests | 113 passed, 7 todo |
| AgentCore tests | 49 passed |
| Execution Store Redis tests | 29 passed |
| Model provider contract tests | 5 passed |
| Pi-ai provider unit tests | 8 passed |
| Model provider wire tests (test-rig simulator) | 10 passed |
| Platform Acceptance tests | 63 passed |
| Tool Runtime Local typecheck | passed |
| CLI typecheck | passed |
| A2A typecheck | passed |
| Agent Host typecheck | passed |
| Agent SDK typecheck | passed |
| Chat Core typecheck | passed |
| Durable Effects typecheck | passed |
| Test Rig typecheck | passed |
| React Chat typecheck | passed |
| Platform Acceptance typecheck | passed |
| Provider wire simulator typecheck | passed |
| Durable Execution typecheck | passed |
| Durable Chat Runtime typecheck | passed |
| Workspace Runtime typecheck | passed |
| Journal Authority typecheck | passed |
| Tool Session typecheck | passed |
| AgentCore typecheck | passed |
| Execution Store Redis typecheck | passed |
| Model provider contract typecheck | passed |
| Pi-ai provider typecheck | passed |
| `git diff --check` | passed |

Completed slices have passed repository checks and deterministic landing. Final completion still requires trust-flow v3 evidence and durable restoration review, so those slice artifacts are not presented as the final certification artifact.

## Preserved semantic authority

The migrated schemas establish structure only. The following decisions remain typed domain logic:

- collection and artifact digest integrity;
- program identity provenance and release pins;
- A2A URL, origin, authorization, and advertised-skill consistency;
- duplicate mappings and collection entries;
- foreign-session durability behavior; and
- provider history/tool-call compatibility policy.

Foundation remains free of a production Zod dependency. Canonical JSON and Standard Schema mechanics remain vendor-neutral.

## Remaining work before final completion

Work now proceeds by vertical trust flow rather than package/check count:

1. Evolve inventory evidence to trust-flow v3 while retaining v2 IDs and shape-owner drift coverage.
2. Classify open carrier fields as designed or accidental; migrate the highest downstream-reconstruction trees first.
3. Define writer, mutation, envelope/version, integrity, migration, and single restore authority for each durable store and Journal Authority flow.
4. Continue carrying producer-known identity, failure, capability, provenance, and correlation facts rather than reconstructing them downstream.
5. Move remaining external protocol behavior from hand-built clients/fakes to installed adapters exercised through simulators.
6. Delete residual `R` owners as their upstream authority is established; do not translate them mechanically to schemas.
7. Review remaining `G`/`C` residue and direct decode/parser-return assertions in the context of their trust flow.
8. Run final focused, simulator, package, application, exports, product-surface, module-graph, clean-build, and deterministic landing gates.

## Certification criteria

This work may be marked complete only when:

- inventory and trust-flow drift are empty;
- every external, authored, and durable flow names one owning authority;
- every designed-open value names its final authored validator;
- accidental-open carrier fields no longer force downstream reconstruction;
- authored validators, projections, and digests are not re-derived downstream;
- producer-known facts are carried explicitly rather than inferred or fabricated;
- acceptance protocol behavior is simulator-backed or has a reviewed exact escape hatch;
- durable restore authority is centralized per store/domain and replay consumers do not repeat payload parsing;
- remaining manual shape owners are reviewed residue rather than unresolved migration placeholders;
- diagnostics remain bounded and redacted;
- all focused and repository-wide gates pass; and
- one final deterministic landing artifact is recorded here.

## Evidence locations

- Design: enclosing workspace `.pi/specs/validation-parse-once-completion-design.md`
- Prior migration evidence: `docs/landing/validation-boundary-cleanup.md`
- Permanent boundary behavior: package-owned parser, codec, restore, and acceptance tests
