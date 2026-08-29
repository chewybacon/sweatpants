# Product Surface

> **Source of truth** for Sweatpants package lanes, product facade allowlist, and product-app import policy.
>
> Related: [product changelog](./product-changelog.md) · [product facade allowlist (machine-readable)](./product-facade-allowlist.json) · [demos](./demos/)

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
| `@sweatpants/chat-client` | Headless `ChatClient`, optional `ChatRuntime`, transport Ports, reconnect, middleware, and frame pipeline |
| `@sweatpants/chat-client/pipeline` | Framework-neutral Sweatpants frame pipeline |
| `@sweatpants/react-chat` | Thin React client facade (`createChatClient`, `createChatRuntime`, `useChat`, `makePlugin`) |
| `destination domain packages` **product entries** | Dual-nature (see below). Product import paths: `/server`, `/chat`, `/chat/mcp-tools`, `/chat/durable-streams`; `/chat` owns `defineChatProgram`, while `/server` owns explicit agent serving profiles and connectivity |
| `@sweatpants/agent-sdk` **authoring surface** | `createTool`, content-addressed resources/guidance, `defineAgent`, advertised capabilities, and portable manifest types (`.` / `/tool` / `/tools`) |
| `@sweatpants/cli` | Tooling (codegen), not runtime core |

### Canonical substrate

| Package | Notes |
|---|---|
| `@sweatpants/durable-execution` | Session kernel under the durable handler |
| `@sweatpants/durable-streams` | Token buffers / reconnect protocol substrate |
| `@sweatpants/stream-bridge` | Effection ↔ Web stream bridge |
| `@sweatpants/tool-session/elicit-context` | Elicit context encode/decode |
| `@sweatpants/tool-runtime-local` | Local/worker tool runtime (advanced app wiring) |
| `@sweatpants/tool-runtime-agentcore` | AgentCore remote tool runtime (advanced app wiring) |
| `@sweatpants/model-provider-pi-ai` | Model provider adapter (advanced app wiring) |
| `@sweatpants/vite-plugin` | Build/dev plugin for client-contract extraction, workers, and app tooling |
| `@sweatpants/ts-config` | Shared TypeScript config |
| `destination domain packages` **internals** | Durable handler implementation, session runtime, mcp-tools implementation modules not on the facade allowlist |

### Experimental / salvage

| Area | Notes |
|---|---|
| Isomorphic-tool public authoring | `createIsomorphicTool` / `@sweatpants/chat-core/isomorphic-tools` — not product authoring |
| Retired `@sweatpants/agent` | Package removed; docs that describe it are salvage |
| Archived durable-conversations spike | Not the active durable model (see ADR turn-scoped durable chat) |
| Docs marked PARTIALLY STALE / ARCHIVED | Guidance for **new** work must not treat them as current API |

### Framework dual nature (required note)

`destination domain packages` is **dual-natured**:

- **Product entries** (import these):
  - `@sweatpants/agent-host/server` — `createChatApp` (primary; see [chat-application-configuration.md](./chat-application-configuration.md)), plus `createChatApplication` and `createChatHandler` / `createDurableChatHandler`
  - `@sweatpants/chat-core` — framework-neutral message/event/frame types, codecs, immutable folds, and internal placement normalization
  - `@sweatpants/chat-client` — headless client/runtime/transport Ports, reconnect, middleware, and pipeline orchestration
  - `@sweatpants/react-chat` — thin React `useChat`, client/runtime facades, framework-native `makePlugin`, and prepared native render parts
  - `@sweatpants/tool-session/mcp` — plugin registry helpers for MCP tool authoring
  - `@sweatpants/durable-chat-runtime/response-streams` — in-memory durable stream setup for product apps
- **Internals** (canonical, not experimental by default): implementation modules outside package export maps and the facade allowlist. Product apps must not deep-import package source paths.

## Phase 1 product facade (v0.1)

### Required symbols

| Symbol | Allowlisted path |
|---|---|
| `ChatClient` / `ChatRuntime` | `@sweatpants/chat-client` |
| `createChatClient` / `createChatRuntime` / `useChat` | `@sweatpants/react-chat` |
| `makePlugin` | `@sweatpants/react-chat` (framework-native) |
| `createChatApp` / `chatStorageFromEnv` | `@sweatpants/agent-host/server` |
| `createChatApplication` | `@sweatpants/agent-host/server` |
| `createChatHandler` / `createDurableChatHandler` | `@sweatpants/agent-host/server` |
| `createTool` | `@sweatpants/agent-sdk` |
| `makePlugin` | `@sweatpants/react-chat` (framework-native) |
| `defineAgent` / `advertiseCapability` | `@sweatpants/agent-sdk` |
| `defineChatProgram` / `latestContextWindow` | `@sweatpants/chat-core` |

Durable reconnect/resume behavior is documented via `ChatClient`/`useChat` and the durable handler protocol (conversation id + cursor/LSN).

### Machine-readable allowlist

Path: [`docs/product-facade-allowlist.json`](./product-facade-allowlist.json)

Validate with:

```bash
pnpm validate:product-surface
```

Also runs as part of root `pnpm build` (after package builds and export validation).

### v0.1 exclusions (not happy-path authoring)

These MAY remain available as canonical/experimental surfaces, but MUST NOT be advertised as the product happy path:

- Direct low-level Durable Execution fold harness as primary app authoring
- Raw durable-streams store APIs as app-author primary surface
- Transport primitives from `@sweatpants/agent-sdk/transport` as app-author primary surface
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
| `@sweatpants/client` | `@sweatpants/chat-client` | Headless client/runtime, transport, and pipeline |
| `@sweatpants/react` | `@sweatpants/react-chat` | React external-store/native interaction adapter |
| `@sweatpants/server` | `@sweatpants/agent-host/server` | Durable handler + app wiring |
| `@sweatpants/tools` | `@sweatpants/agent-sdk` (`createTool`) | Tool authoring |

Physical package renames are optional. Docs and facade maps are the Phase 4 exit path.

## Product apps and import policy

### Reference app (Phases 0–4)

**`apps/yo-chat`** is the reference product app.

New yo-chat features MUST target **Product** and **Canonical substrate** lanes only. New experimental-lane imports are forbidden.

### Cutover app (Phase 5)

Default cutover target: **`apps/yo-chat`**.

### Experimental import prohibition

Product-lane packages and product apps MUST NOT add new imports from experimental-lane packages or experimental paths. Enforcement: `pnpm validate:product-surface` (see `scripts/validate-product-surface.ts`).

## Import inventory (Phase 0 baseline)

**Dated:** 2026-07-09

Scan of `apps/yo-chat` source (excluding `node_modules` / `dist`) for `@sweatpants/*` imports:

| Import root | Lane | Count (approx) | Notes |
|---|---|---|---|
| `@sweatpants/chat-core` | Product entry | high | plugins, elicit helpers |
| `@sweatpants/agent-host/server` | Product entry | high | app + handler |
| `@sweatpants/tool-session/mcp` | Product entry | medium | plugin registry |
| `@sweatpants/react-chat` | Product entry | medium | chat hooks, native plugin UI components, and recursive message rendering |
| `@sweatpants/durable-chat-runtime/response-streams` | Product entry | low | durable setup |
| `@sweatpants/react-chat` | Product | medium | chat routes |
| `@sweatpants/agent-sdk` | Product tool surface | medium | `createTool` |
| `@sweatpants/tool-runtime-local` | Canonical wiring | medium | local tools |
| `@sweatpants/tool-runtime-agentcore` | Canonical wiring | low | optional remote tools |
| `@sweatpants/durable-streams/redis` | Canonical wiring | low | Redis buffer when configured |
| `@sweatpants/model-provider-pi-ai` | Canonical wiring | low | model provider |
| `@sweatpants/vite-plugin` | Canonical | low | vite config |
| `@sweatpants/stream-bridge` | Canonical | package dep | may appear transitively |

**Experimental-lane imports in yo-chat at inventory time:** **none found**.

Known grandfather exceptions: **none** (empty exception list in allowlist JSON).

## Golden-path acceptance

Location: `packages/platform-acceptance/src/product/golden-path.acceptance.test.ts`

Imports only product facade allowlisted paths. Exercises: start chat application, define a tool with `createTool`, send a message, complete a turn.

```bash
pnpm -C packages/platform-acceptance test
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

Superseded APIs (isomorphic tools as public authoring, retired `@sweatpants/agent`, durable-conversations spike as active API) MUST NOT appear as the root README happy path. Superseded docs are deleted, not archived in-tree; source control history is the archive (`git log --follow --diff-filter=D -- docs/`).
