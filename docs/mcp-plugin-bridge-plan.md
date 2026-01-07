# MCP Plugin Bridge — Execution Plan

## Status
Active (work plan)

## Constraints (agreed)
- `makeTool` renamed to `makePlugin`.
- `plugin.client` does not implement sampling (for now).
- Server-side sampling must work.
- Elicitation is per-call suspend/resume.
- Elicitation is not supported inside `ctx.branch()` sub-branches.
- Validation everywhere (TS + server Zod + optional client Zod).

---

## Phase 0 — Prep / alignment
- [ ] Confirm naming for new API surface:
  - `createMcpTool().elicits(...)`
  - `ctx.elicit(key, { message })`
  - `makePlugin(mcpTool).onElicit({...}).build()`

---

## Phase 1 — Types & DSL
- [ ] Extend MCP tool types to carry `elicits` map type parameter
- [ ] Add `.elicits({...})` to MCP tool builder
- [ ] Add keyed `ctx.elicit(key, ...)` overload
- [ ] Maintain backwards compatibility with existing `elicit({ schema })` API where possible

Deliverable: TypeScript compilation passes; MCP unit tests updated/added.

---

## Phase 2 — Plugin artifact definition
- [ ] Define `McpPlugin` interface:
  - `server.tools` (server registration)
  - `client` (client registration)
- [ ] Implement `makePlugin(mcpTool)` builder:
  - `.onElicit({ ...handlers })` exhaustive map
  - `.build()` returns `{ server, client }`

Deliverable: An exported plugin object can be imported on server and client.

---

## Phase 3 — Server-side bridge runtime (in-app execution)
- [ ] Add a server-side executor for MCP tools that supports two capability hosts:
  - Host A: real MCP (existing)
  - Host B: framework-bridge (new)
- [ ] Implement bridge host B `elicit`:
  - emit request event / step with structured id `{ toolName, key, callId, seq }`
  - suspend awaiting correlated response
  - validate with Zod schema from `.elicits` map
- [ ] Implement bridge host B `log/notify` as timeline steps
- [ ] Ensure server-side `sample` works (provider-backed)

Deliverable: server can run MCP tool in-app and pause on `elicit`.

---

## Phase 4 — Client-side bridge runtime (UI fulfillment)
- [ ] Add a client-side plugin registry keyed by `toolName`
- [ ] When an `ElicitRequest` arrives:
  - select plugin for `toolName`
  - run `onElicit[key]` with client ctx
  - send `ElicitResponse` back to server
- [ ] Render each elicitation request into the timeline (React steps)

Deliverable: end-to-end UI elicitation works.

---

## Phase 5 — Branching constraints
- [ ] In branch runtime, throw if `elicit` called at depth > 0
- [ ] Add a clear error type/message

Deliverable: prevents invalid UX patterns.

---

## Phase 6 — Tests & examples
- [ ] Unit test: `.elicits` + exhaustive `.onElicit` typing
- [ ] Integration-ish test: server executes MCP tool, emits elicit request, client responds, tool completes
- [ ] Update one demo tool (e.g. book-flight or pick-card) to use `.elicits` and a plugin

Deliverable: regression safety + example.

---

## Phase 7 — Optional exposure as real MCP
- [ ] Add `plugin.mcp` export later:
  - register the same tool into external MCP server
  - no UI bridge

Deliverable: optional; not required for MVP.

---

## Progress log
- 2026-01-07: wrote design spec and this plan file.
- 2026-01-07: Phase 1 complete - added `.elicits()` to branch builder, keyed `ctx.elicit(key, {message})` 
- 2026-01-07: Phase 2 complete - added `makePlugin()` builder with exhaustive `onElicit({...})` handlers
  - New files: `packages/framework/src/lib/chat/mcp-tools/plugin.ts`
  - New types: `McpPlugin`, `PluginBuilder`, `ElicitHandlers`, etc.
  - Tests: `packages/framework/src/lib/chat/mcp-tools/__tests__/plugin.test.ts`
- 2026-01-07: Phase 3 complete - server-side bridge runtime for in-app tool execution
  - New file: `packages/framework/src/lib/chat/mcp-tools/bridge-runtime.ts`
  - New types: `BridgeHost`, `BridgeHostConfig`, `BridgeEvent`, `BridgeSamplingProvider`, `ElicitResponse`
  - New functions: `createBridgeHost()`, `runBridgeTool()`
  - New error: `BranchElicitNotAllowedError` (Phase 5 constraint - no elicit in sub-branches)
  - Tests: `packages/framework/src/lib/chat/mcp-tools/__tests__/bridge-runtime.test.ts` (13 tests)
  - Key patterns:
    - Channel-based event emission with Signal-based response coordination
    - Spawned event handlers with `yield* sleep(0)` for subscription timing
    - Zod validation on elicit responses
