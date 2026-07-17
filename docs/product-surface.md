# Product Surface

> **Source of truth** for Sweatpants package lanes, product facade allowlist, and product-app import policy.
>
> Related: [product changelog](./product-changelog.md) · [product facade allowlist (machine-readable)](./product-facade-allowlist.json) · [demos](./demos/) · [cutover report](./cutover-yo-chat.md)

## Purpose

Sweatpants is a durable chat / human-in-the-loop substrate. This document freezes the **product door** so apps and strangers do not have to shop the architecture diagram.

Three lanes classify every workspace package:

| Lane | Meaning |
|---|---|
| **Product** | What apps and strangers should import. Facade freeze and changelog apply. |
| **Canonical substrate** | The one evolving implementation path under the facade. May churn if facade holds. |
| **Experimental / salvage** | Quarantine. No new dependents in product packages or product apps. |

## Lanes (baseline)

### Product

| Package / path | Notes |
|---|---|
| `@sweatpants/react-chat` | UI hooks / chat client (`useChat`, `useChatSession`, `ChatProvider`) |
| `@sweatpants/react-chat/pipeline` | Rendering pipelines when required |
| `@sweatpants/framework` **product entries** | Dual-nature (see below). Product import paths: `/server`, `/chat`, `/chat/browser-rendering`, `/chat/mcp-tools`, `/chat/durable-streams`; `/chat` owns `defineChatProgram`, while `/server` owns explicit agent serving profiles and connectivity |
| `@sweatpants/core` **authoring surface** | `createTool`, content-addressed resources/guidance, `defineAgent`, advertised capabilities, and portable manifest types (`.` / `/tool` / `/tools`) |
| `@sweatpants/cli` | Tooling (codegen), not runtime core |

### Canonical substrate

| Package | Notes |
|---|---|
| `@sweatpants/session-contract` | Session kernel under the durable handler |
| `@sweatpants/durable-streams` | Token buffers / reconnect protocol substrate |
| `@sweatpants/stream-bridge` | Effection ↔ Web stream bridge |
| `@sweatpants/elicit-context` | Elicit context encode/decode |
| `@sweatpants/tool-runtime-local` | Local/worker tool runtime (advanced app wiring) |
| `@sweatpants/tool-runtime-agentcore` | AgentCore remote tool runtime (advanced app wiring) |
| `@sweatpants/model-provider-pi-ai` | Model provider adapter (advanced app wiring) |
| `@sweatpants/vite-plugin` | Build/dev plugin for apps |
| `@sweatpants/ts-config` | Shared TypeScript config |
| `@sweatpants/framework` **internals** | Durable handler implementation, session runtime, mcp-tools implementation modules not on the facade allowlist |

### Experimental / salvage

| Area | Notes |
|---|---|
| Isomorphic-tool public authoring | `createIsomorphicTool` / `@sweatpants/framework/chat/isomorphic-tools` — not product authoring |
| Retired `@sweatpants/agent` | Package removed; docs that describe it are salvage |
| Archived durable-conversations spike | Not the active durable model (see ADR turn-scoped durable chat) |
| Docs marked PARTIALLY STALE / ARCHIVED | Guidance for **new** work must not treat them as current API |

### Framework dual nature (required note)

`@sweatpants/framework` is **dual-natured**:

- **Product entries** (import these):
  - `@sweatpants/framework/server` — `createChatApplication`, `createChatHandler` / `createDurableChatHandler`, `serveAgent`, explicit profiles, and posture-specific connections
  - `@sweatpants/framework/chat` — `defineChatProgram`, bounded protocol-neutral turn contracts, resource mount policy, `makePlugin`, plugin helpers, and chat types
  - `@sweatpants/framework/chat/browser-rendering` — plugin UI `RenderableProps` and rendering helpers
  - `@sweatpants/framework/chat/mcp-tools` — plugin registry helpers for MCP tool authoring
  - `@sweatpants/framework/chat/durable-streams` — in-memory durable stream setup for product apps
- **Internals** (canonical, not experimental by default): implementation modules under `packages/framework/src/**` that are not listed on the facade allowlist. Do not deep-import `@sweatpants/framework/src/...` from product apps.

## Phase 1 product facade (v0.1)

### Required symbols

| Symbol | Allowlisted path |
|---|---|
| `useChat` | `@sweatpants/react-chat` |
| `useChatSession` | `@sweatpants/react-chat` |
| `ChatProvider` | `@sweatpants/react-chat` |
| `createChatApplication` | `@sweatpants/framework/server` |
| `createChatHandler` / `createDurableChatHandler` | `@sweatpants/framework/server` |
| `createTool` | `@sweatpants/core` |
| `makePlugin` | `@sweatpants/framework/chat` |
| `defineAgent` / `advertiseCapability` | `@sweatpants/core` |
| `defineChatProgram` / `latestContextWindow` | `@sweatpants/framework/chat` |
| `serveAgent` / `remoteExecutor` / `standardA2A` / `sweatpantsPeer` | `@sweatpants/framework/server` |

Durable reconnect/resume behavior is documented via product session hooks (`useChat` / `useChatSession`) and the durable handler protocol (session/conversation id + offset/LSN).

### Machine-readable allowlist

Path: [`docs/product-facade-allowlist.json`](./product-facade-allowlist.json)

Validate with:

```bash
pnpm validate:product-surface
```

Also runs as part of root `pnpm build` (after package builds and export validation).

### v0.1 exclusions (not happy-path authoring)

These MAY remain available as canonical/experimental surfaces, but MUST NOT be advertised as the product happy path:

- Direct session-contract `createAgent` fold harness as primary app authoring
- Raw durable-streams store APIs as app-author primary surface
- Transport primitives from `@sweatpants/core/transport` as app-author primary surface
- Isomorphic tool builders as public product authoring
- AG-UI conformance internals, interrupt registries, and fold drivers as app-author primary surface

### Advanced setup / canonical app-wiring (not shopping-list equals)

Document under Advanced only:

- `@sweatpants/tool-runtime-local`
- `@sweatpants/tool-runtime-agentcore`
- `@sweatpants/durable-streams` (including `/redis`)
- `@sweatpants/model-provider-pi-ai`

Happy-path samples SHOULD prefer local/in-memory defaults (no Redis or AgentCore required).

## Conceptual package story (≤4 normal-user targets)

| Conceptual target | Concrete path (today) | Job |
|---|---|---|
| `@sweatpants/react` | `@sweatpants/react-chat` | UI hooks / chat client |
| `@sweatpants/server` | `@sweatpants/framework/server` | Durable handler + app wiring |
| `@sweatpants/tools` | `@sweatpants/core` (`createTool`) | Tool authoring |
| `@sweatpants/chat` | `@sweatpants/framework/chat` | Session helpers, plugins, advanced chat |

Physical package renames are optional. Docs and facade maps are the Phase 4 exit path.

## Product apps and import policy

### Reference app (Phases 0–4)

**`apps/yo-chat`** is the reference product app.

New yo-chat features MUST target **Product** and **Canonical substrate** lanes only. New experimental-lane imports are forbidden.

### Cutover app (Phase 5)

Default cutover target: **`apps/yo-chat`**. See [cutover-yo-chat.md](./cutover-yo-chat.md).

### Experimental import prohibition

Product-lane packages and product apps MUST NOT add new imports from experimental-lane packages or experimental paths. Enforcement: `pnpm validate:product-surface` (see `scripts/validate-product-surface.ts`).

## Import inventory (Phase 0 baseline)

**Dated:** 2026-07-09

Scan of `apps/yo-chat` source (excluding `node_modules` / `dist`) for `@sweatpants/*` imports:

| Import root | Lane | Count (approx) | Notes |
|---|---|---|---|
| `@sweatpants/framework/chat` | Product entry | high | plugins, elicit helpers |
| `@sweatpants/framework/server` | Product entry | high | app + handler |
| `@sweatpants/framework/chat/mcp-tools` | Product entry | medium | plugin registry |
| `@sweatpants/framework/chat/browser-rendering` | Product entry | medium | tool UI components |
| `@sweatpants/framework/chat/durable-streams` | Product entry | low | durable setup |
| `@sweatpants/react-chat` | Product | medium | chat routes |
| `@sweatpants/core` | Product tool surface | medium | `createTool` |
| `@sweatpants/tool-runtime-local` | Canonical wiring | medium | local tools |
| `@sweatpants/tool-runtime-agentcore` | Canonical wiring | low | optional remote tools |
| `@sweatpants/durable-streams/redis` | Canonical wiring | low | Redis buffer when configured |
| `@sweatpants/model-provider-pi-ai` | Canonical wiring | low | model provider |
| `@sweatpants/vite-plugin` | Canonical | low | vite config |
| `@sweatpants/stream-bridge` | Canonical | package dep | may appear transitively |

**Experimental-lane imports in yo-chat at inventory time:** **none found**.

Known grandfather exceptions: **none** (empty exception list in allowlist JSON).

## Golden-path acceptance

Location: `packages/framework/acceptance/golden-path.acceptance.test.ts`

Imports only product facade allowlisted paths. Exercises: start chat application, define a tool with `createTool`, send a message, complete a turn.

```bash
pnpm -C packages/framework test:acceptance
```

## Demos

Differentiator demos live under [docs/demos/](./demos/) and the yo-chat **Durability Lab** (`/lab/durability`).

## Lane changes

Deviations from this baseline MUST be recorded here with date and reason (and reflected in the allowlist JSON when facade paths change). Breaking facade changes also go in [product-changelog.md](./product-changelog.md).

| Date | Change | Reason |
|---|---|---|
| 2026-07-18 | Added agent/chat authoring and explicit serving profiles to existing core/chat/server targets | Durable authoring without adding a fifth product target |
| 2026-07-09 | Initial baseline classification | Phase 0 product surface program |

## Tombstones / default path hygiene

Superseded APIs (isomorphic tools as public authoring, retired `@sweatpants/agent`, durable-conversations spike as active API) are tombstoned at the top of affected docs and MUST NOT appear as the root README happy path. Archive under `docs/archive/` is acceptable retention.
