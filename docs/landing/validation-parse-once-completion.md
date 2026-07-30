# Validation Parse-Once Completion — Implementation Memo

## Status

In progress. The policy/inventory foundation and four production trust-domain slices are implemented and tested. Repository-wide certification remains blocked on migration of the unresolved inventory entries listed below.

This memo intentionally distinguishes completed evidence from planned work. It is not a final `pnpm land` attestation.

## Implemented in this change

### Inventory v2 and enforcement

- Evolved `docs/architecture/validation-boundary-inventory.json` to `sweatpants.validation-boundary-inventory.v2`.
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
| Historical validation records | 86 |
| Manual shape owners | 345 |
| `B` external boundary | 113 |
| `R` same-domain revalidation | 166 |
| `S` typed semantic verification | 15 |
| `G` generic mechanism | 6 |
| `C` compatibility normalizer | 45 |

The counts are evidence indicators, not completion criteria. Every remaining `B` and `R` record still requires package-level review before final certification.

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

`packages/durable-chat-runtime/src/handler/request-normalization.ts` now keeps raw-message normalization inside the established strict request schema trust domain. The typed normalizer no longer repeats array, record, tool-call, or function-field shape checks. The obsolete `normalizeChatRequestBody` same-domain forwarding API was deleted rather than retained as a compatibility alias. Provider-compatible string tool arguments are parsed through the owned canonical record schema.

`packages/durable-chat-runtime/src/interrupts/store.ts` now treats JSON restoration as a new trust boundary and strictly parses the complete persisted interrupt collection. Closed schemas prove identities, status, timestamps, optional execution references, canonical continuation/response-schema slots, metadata, and collection bounds before returning `OpenInterruptRecord[]`. Invalid persisted JSON or structure now fails closed instead of being cast or silently treated as absent.

`packages/durable-chat-runtime/src/durable-handler/local-program-host.ts` now parses restored pinned program catalogs with a closed nested schema covering program and foreign-tool variants, pinned identities, durability discriminants, target keys, and digest syntax. The parser delegates catalog digest and key/target consistency to `verifyPinnedProgramCatalog`. Typed in-memory request paths call only the semantic verifier, eliminating same-domain structural reparsing. The obsolete `parseCatalog` API and parser-return cast were removed.

`program-driver-tool-runtime.ts` now strictly parses durable continuation state and nested `ToolExecutionRef` values, while the deliberately tolerant scalar-to-object tool-input adapter returns one canonical object representation. `program-driver-schema.ts` retains Standard Schema as the authored registry contract but delegates the framework-owned chat program input structure to a strict private Zod schema. Catalog digest verification remains typed semantic logic after parsing.

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

Agent SDK worker out-of-band message recognition now uses bounded schemas. Chat Core adopts its own pinned Zod dependency and parses AG-UI tool-call arguments, activity content, reducer arguments, stream tool-call arguments, and projected chat-turn history facts through canonical JSON-object schemas. `plugin-replay` remains the designated compatibility normalizer.

### Durable Effects contracts and test rig history

`durable-effects` adopts its own pinned Zod dependency and now proves the framework-owned `model.sample` input, output, and cancellation-partial structures with strict schemas behind the unchanged Standard Schema registry contract. Effect-error code extraction also parses instead of inspecting. `test-rig` history normalization parses wire records and tool arguments through bounded schemas while remaining a deliberately tolerant provider-history projection.

### A2A caller-authoritative discovery

`packages/a2a/src/discovery.ts` now uses strict schemas for:

- caller-authoritative extension parameters;
- bounded skill mappings; and
- pinned program identities.

Duplicate skill mappings remain a typed semantic failure. URL/origin and skill-advertisement authority remain in their existing semantic verifiers. No parser-return cast is used.

### Model provider normalization

The three package-local generic record predicates in `model-provider-pi-ai` were consolidated into the exact compatibility-mechanism owner `isProviderRecord` in `runtime/schema-normalization.ts`. Model selection, provider tool-argument normalization, and schema projection share that mechanism. Standard Schema remains the public user-schema contract.

## Validation performed

| Scope | Result |
| --- | --- |
| Validation inventory/tooling tests | 21 passed |
| Tool Runtime Local source tests | 39 passed |
| Tool Runtime Local acceptance tests | 6 passed |
| CLI tests | 14 passed |
| A2A tests | 48 passed, 1 live test skipped |
| Agent Host tests | 38 passed |
| Agent SDK tests | 149 passed |
| Chat Core tests | 123 passed |
| Durable Effects tests | 3 passed |
| Test Rig tests | 18 passed |
| Durable Execution tests | 25 passed |
| Durable Chat Runtime tests | 207 passed, 4 skipped |
| Workspace Runtime tests | 18 passed |
| Journal Authority tests | 92 passed |
| Tool Session tests | 109 passed, 7 todo |
| AgentCore tests | 49 passed |
| Execution Store Redis tests | 29 passed |
| Model provider tests | 22 passed |
| Tool Runtime Local typecheck | passed |
| CLI typecheck | passed |
| A2A typecheck | passed |
| Agent Host typecheck | passed |
| Agent SDK typecheck | passed |
| Chat Core typecheck | passed |
| Durable Effects typecheck | passed |
| Test Rig typecheck | passed |
| Durable Execution typecheck | passed |
| Durable Chat Runtime typecheck | passed |
| Workspace Runtime typecheck | passed |
| Journal Authority typecheck | passed |
| Tool Session typecheck | passed |
| AgentCore typecheck | passed |
| Execution Store Redis typecheck | passed |
| Model provider typecheck | passed |
| `git diff --check` | passed |

No final repository-wide `pnpm check`, clean build, or deterministic `pnpm land` result is claimed by this memo.

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

The following package priorities from DR-041 still require completion review or broader migration:

1. Remaining A2A protocol/manifest/peer envelope trees and connector transport values.
2. Remaining Durable Chat projection and provider-message compatibility owners.
3. Remaining Durable Execution manifest-authoring constructor invariants and any transport-specific driver values.
4. Remaining Journal Authority snapshot predicate decomposition and authenticated wire-envelope review.
5. Remaining Tool Session worker/session-manager bridge and provider compatibility predicates.
6. Remaining AgentCore worker/session transport values and provider-normalization residue.
7. Remaining CLI bundler, evaluator-loader, AWS, and artifact ingress checks.
8. Deletion or reclassification of every unresolved `R` owner.
9. Entry-level positive and negative test evidence for all final `B` and `C` records.
10. Final residue review of generic record predicates and parser-return assertions.
11. Repository typecheck, formatting, exports, product surface, module graph, clean build, and deterministic landing.

## Certification criteria

This work may be marked complete only when:

- inventory drift is empty;
- every inventory record reflects reviewed source rather than an initial classification;
- all `R` records are deleted or tied to a distinct serialized trust transition;
- all remaining `G` and `C` records have exact function-level rationale and fixtures;
- parser errors remain bounded and redacted;
- focused and repository-wide checks pass; and
- a clean deterministic landing artifact is recorded here.

## Evidence locations

- Design: enclosing workspace `.pi/specs/validation-parse-once-completion-design.md`
- Inventory: `docs/architecture/validation-boundary-inventory.json`
- Tooling: `scripts/validation-boundary-inventory.ts`
- Tooling tests: `scripts/__tests__/validation-boundary-inventory.test.ts`
- Prior validation cleanup evidence: `docs/landing/validation-boundary-cleanup.md`
