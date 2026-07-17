# Product Changelog

Breaking changes to product facade exports or allowlisted paths are recorded here.

Format for breaking entries:

- **Date** (or version)
- **Change summary**
- **Migration note**

See also: [product-surface.md](./product-surface.md) · [product-facade-allowlist.json](./product-facade-allowlist.json)

---

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
