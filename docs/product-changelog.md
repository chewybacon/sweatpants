# Product Changelog

Breaking changes to product facade exports or allowlisted paths are recorded here.

Format for breaking entries:

- **Date** (or version)
- **Change summary**
- **Migration note**

See also: [product-surface.md](./product-surface.md) · [product-facade-allowlist.json](./product-facade-allowlist.json)

---

## 2026-07-19 — journal-backed standard A2A host

### Summary

Added a production-bound `standardA2A()` host compiler with authenticated HTTP+JSON Agent Card discovery, task-generating message sends, exact-task cancellation, pull-based Task/artifact/status streaming, immutable terminal turns, explicit ordered `referenceTaskIds`, journal-derived projection, and bounded context acceptance. Public history is configurable as `task-only` or immutable `accepted-context`, including in-task elicitation prompts and responses. Added immutable digest-addressed content custody primitives to `@sweatpants/a2a` and a real-loopback `startAgentHarness()` under `@sweatpants/framework/server/testing`.

Added `apps/yo-a2a` as the real standard-agent vertical: a model-driven authored chat program loads guidance, invokes crank-native card/echo tools, parks on elicitation, resumes through task-directed A2A messages, and preserves conversation memory across immutable tasks. The pinned Inspector Playwright job drives this app through its Python SDK backend; the former standalone Inspector fixture app was removed.

### Migration note

A standard profile is ready only when it is bound to a real host created by `createStandardA2AHost()` (or an equivalent bound host port). Production interfaces must use HTTPS. Loopback HTTP requires `insecureLoopbackDevelopment: true`; non-loopback HTTP requires the separate unsafe override. Authentication and authorization are deployment `Operation` callbacks, and payload metadata never establishes principal or tenant identity. `accepted-context` is the conversational default; use `task-only` for orchestration surfaces that should expose only one work item's exchange.

## 2026-07-18 — durable chat and agent authoring facade

### Summary

Added protocol-neutral bounded chat turns, deterministic accepted context views, digest-covered `defineChatProgram`, portable `AgentManifestV1` plus runtime `AgentDefinition`, descriptive advertised capabilities, exact entrypoints, explicit serving profiles, and posture-specific connection APIs.

Portable agent authoring is exported from `@sweatpants/core`, chat authoring from `@sweatpants/framework/chat`, and serving/connectivity from `@sweatpants/framework/server`. No `@sweatpants/agent` package was introduced. The `a2a-review` acceptance vertical now publishes its clean-context reviewer through the caller-authoritative facade while retaining caller-owned `model.sample`, `ask_parent`, credentials, and journal authority.

### Migration note

Choose `remoteExecutor()`, `standardA2A()`, or `sweatpantsPeer()` explicitly when calling `serveAgent()`. Serialize `definition.manifest`, never the runtime definition. Provider routes, handlers, credentials, journals, grants, and endpoints remain deployment bindings.

Model-visible durable tools now carry a binding-owned result-classification ceiling through `modelTool()`. Arbitrary payload fields are not trusted as provenance, while the explicit `classifiedToolResult()` envelope may only raise the ceiling. Authored-chat v1 rejects reserved `resources.*` aliases and non-empty elicitation declarations.

The `a2a-review` process certification now executes the generated `REFERENCE_REVIEWER_CHAT` itself: deterministic samples load pinned guidance through a reader child, invoke the durable `ask_parent` child, and return the terminal chat result. The legacy reviewer remains only as a low-level compatibility fixture and now lives in `src/legacy.ts`, separate from the Spec-3-facing facade composition.

The generated acceptance artifact intentionally hashes the complete reviewer source set (`src/index.ts` and `src/legacy.ts`). `REFERENCE_ASK_PARENT_TOOL` reuses that coarse application artifact digest as its implementation artifact input, so any reviewer source edit deliberately repins the child.

## 2026-07-17 — content-addressed resources and generated program identity

### Summary

Added immutable resource packages, guidance metadata, exact package registries, scoped mounts, deterministic resource-reader programs, build-time directory generation/verification, and generated durable-program artifact identity to `@sweatpants/core`.

The low-level session-contract manifest-plus-generator constructor is now named `createPinnedDurableProgram`. Its previous `createDurableTool` name remains as a deprecated compatibility alias; the staged `@sweatpants/core` `createDurableTool("name")` product builder is unchanged.

### Migration note

Low-level `@sweatpants/session-contract` consumers should replace `createDurableTool(manifest, program)` with `createPinnedDurableProgram(manifest, program)`. Existing asserted pins continue to load in compatibility mode, while release-strict validation requires generated artifact provenance.

## 2026-07-09 — v0.1 facade freeze (initial)

### Summary

Freeze the Phase 1 product facade allowlist and document the ≤4 conceptual package story. No import path renames.

### Allowlisted paths (initial)

- `@sweatpants/react-chat`
- `@sweatpants/react-chat/pipeline`
- `@sweatpants/framework/server`
- `@sweatpants/framework/chat`
- `@sweatpants/framework/chat/browser-rendering`
- `@sweatpants/framework/chat/mcp-tools`
- `@sweatpants/framework/chat/durable-streams`
- `@sweatpants/core` (and `/tool`, `/tools`)

### Migration note

None for existing yo-chat-style apps already using the paths above. Do not introduce new isomorphic-tool public authoring or deep `@sweatpants/framework/src/...` imports in product apps.
