# Product Changelog

Breaking changes to product facade exports or allowlisted paths are recorded here.

Format for breaking entries:

- **Date** (or version)
- **Change summary**
- **Migration note**

See also: [product-surface.md](./product-surface.md) · [product-facade-allowlist.json](./product-facade-allowlist.json)

---

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
