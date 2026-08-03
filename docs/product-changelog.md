# Product Changelog

Breaking changes to product facade exports or allowlisted paths are recorded here.

Format for breaking entries:

- **Date** (or version)
- **Change summary**
- **Migration note**

See also: [product-surface.md](./product-surface.md) · [product-facade-allowlist.json](./product-facade-allowlist.json)

---

## 2026-08-03 — headless client and recursive interaction projection

### Summary

Replaced the pre-release `createChatSession`/`ChatState` client with one first-class
`@sweatpants/chat-client` runtime. React Chat is now a thin external-store and native-interaction
adapter. Active and nested messages use one recursive `messages[]`/`parts[]` model; exact typed client
elicitation remains local while host settlement and public placement remain durable authorities.
Frame processing moved below framework hooks and is paced by a frontend clock over an eager client
buffer, with direct transport-cadence fallback for unpaced clients. Product Vite builds derive
client-only contract variants from static `makePlugin(importedTool)` calls, retaining authored schemas
while excluding ordinary execution and durable effect implementations.

### Migration note

Use `createChatClient`/`createChatRuntime` from `@sweatpants/chat-client` or the React-specialized
facades and `useChat` from `@sweatpants/react-chat`. Render messages and parts recursively. The removed
`createChatSession`, `ChatState`, `streamingMessage`, host-tree, browser replay, and
`execution.children` APIs have no compatibility aliases. Server/application composition—not client
plugin registration—owns executable tools and model policy.

## 2026-07-20 — durable-tool authoring DX

### Summary

Fluent `createDurableTool()` results now satisfy `AgentProgramInput` directly. `defineChatProgram()` and `defineAgent()` infer tool schemas and resources, eliminating handwritten `AgentProgramBinding` objects and unsafe casts. Versioned tools can omit `.identity()` and receive deterministic `generated-interface` provenance over their complete durable manifest. Persistent reference journal stores can derive their schema registry from an authored `agent`.

### Migration note

Prefer `createDurableTool(name, { version })`, pass the resulting tool directly to `modelTool()` and `defineAgent()`, and pass `agent` rather than `programDriverSchemaRegistry(agent.bindings.schemas)` to `createFileProgramDriverJournalStore()`. Interface-derived identity does not cover executor source and therefore does not satisfy `releaseStrict`; generated builds should provide `implementationArtifactDigest`. Explicit asserted identities and explicit schema registries remain low-level escape hatches.

## 2026-07-19 — journal-backed standard A2A host

### Summary

Added a production-bound `standardA2A()` host compiler with authenticated HTTP+JSON Agent Card discovery, task-generating message sends, exact-task cancellation, pull-based Task/artifact/status streaming, immutable terminal turns, explicit ordered `referenceTaskIds`, journal-derived projection, and bounded context acceptance. Public history is configurable as `task-only` or immutable `accepted-context`, including in-task elicitation prompts and responses. Added immutable digest-addressed content custody primitives to `@sweatpants/a2a` and a real-loopback `startAgentHarness()` under `@sweatpants/agent-host/server/testing`.

Added `apps/yo-a2a` as the real standard-agent vertical: a model-driven authored chat program loads guidance, invokes crank-native card/echo tools, parks on elicitation, resumes through task-directed A2A messages, and preserves conversation memory across immutable tasks. The pinned Inspector Playwright job drives this app through its Python SDK backend; the former standalone Inspector fixture app was removed.

### Migration note

A standard profile is ready only when it is bound to a real host created by `createStandardA2AHost()` (or an equivalent bound host port). Production interfaces must use HTTPS. Loopback HTTP requires `insecureLoopbackDevelopment: true`; non-loopback HTTP requires the separate unsafe override. Authentication and authorization are deployment `Operation` callbacks, and payload metadata never establishes principal or tenant identity. `accepted-context` is the conversational default; use `task-only` for orchestration surfaces that should expose only one work item's exchange.

## 2026-07-18 — durable chat and agent authoring facade

### Summary

Added protocol-neutral bounded chat turns, deterministic accepted context views, digest-covered `defineChatProgram`, portable `AgentManifestV1` plus runtime `AgentDefinition`, descriptive advertised capabilities, exact entrypoints, explicit serving profiles, and posture-specific connection APIs.

Portable agent authoring is exported from `@sweatpants/agent-sdk`, chat authoring from `@sweatpants/chat-core`, and serving/connectivity from `@sweatpants/agent-host/server`. No `@sweatpants/agent` package was introduced. The `a2a-review` acceptance vertical now publishes its clean-context reviewer through the caller-authoritative facade while retaining caller-owned `model.sample`, `ask_parent`, credentials, and journal authority.

### Migration note

Choose `remoteExecutor()`, `standardA2A()`, or `sweatpantsPeer()` explicitly when calling `serveAgent()`. Serialize `definition.manifest`, never the runtime definition. Provider routes, handlers, credentials, journals, grants, and endpoints remain deployment bindings.

Model-visible durable tools now carry a binding-owned result-classification ceiling through `modelTool()`. Arbitrary payload fields are not trusted as provenance, while the explicit `classifiedToolResult()` envelope may only raise the ceiling. Authored-chat v1 rejects reserved `resources.*` aliases and non-empty elicitation declarations.

The `a2a-review` process certification now executes the generated `REFERENCE_REVIEWER_CHAT` itself: deterministic samples load pinned guidance through a reader child, invoke the durable `ask_parent` child, and return the terminal chat result. The legacy reviewer remains only as a low-level compatibility fixture and now lives in `src/legacy.ts`, separate from the Spec-3-facing facade composition.

The generated acceptance artifact intentionally hashes the complete reviewer source set (`src/index.ts` and `src/legacy.ts`). `REFERENCE_ASK_PARENT_TOOL` reuses that coarse application artifact digest as its implementation artifact input, so any reviewer source edit deliberately repins the child.

## 2026-07-17 — content-addressed resources and generated program identity

### Summary

Added immutable resource packages, guidance metadata, exact package registries, scoped mounts, deterministic resource-reader programs, build-time directory generation/verification, and generated durable-program artifact identity to `@sweatpants/agent-sdk`.

The low-level Durable Execution manifest-plus-generator constructor is `createPinnedDurableProgram`. The staged `@sweatpants/agent-sdk` `createDurableTool("name")` product builder is unchanged.

### Migration note

Low-level `@sweatpants/durable-execution` consumers should replace `createDurableTool(manifest, program)` with `createPinnedDurableProgram(manifest, program)`. Existing asserted pins continue to load in compatibility mode, while release-strict validation requires generated artifact provenance.

## 2026-07-09 — v0.1 facade freeze (initial)

### Summary

Freeze the Phase 1 product facade allowlist and document the ≤4 conceptual package story. No import path renames.

### Allowlisted paths (initial)

- `@sweatpants/react-chat`
- `@sweatpants/chat-client/pipeline`
- `@sweatpants/agent-host/server`
- `@sweatpants/chat-core`
- `@sweatpants/react-chat` (including framework-native plugin rendering)
- `@sweatpants/tool-session/mcp`
- `@sweatpants/durable-chat-runtime/response-streams`
- `@sweatpants/agent-sdk` (and `/tool`, `/tools`)

### Migration note

None for existing yo-chat-style apps already using the paths above. Do not introduce new isomorphic-tool public authoring or deep package-source imports in product apps.
