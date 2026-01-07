# MCP Plugin Bridge (Isomorphic UI for MCP-Style Tools)

## Status
Draft (design spec)

## Elevator pitch
Author an MCP-style tool once (server-side generator calling `ctx.elicit/sample/log/notify`), then derive a **framework-native plugin** that:

- Runs the tool inside the framework chat handler (no external MCP process required)
- Bridges `elicit()` calls into the framework client runtime (React/steps/waitFor/etc.)
- Keeps `sample()` server-side (provider-backed) for now
- Optionally exposes the same tool as a real MCP server tool later

This avoids a bespoke “MCP-UI protocol” in userland: tool authors write a plugin and the UI experience is native to the framework.

---

## Goals
- **Per-tool plugins**: `makePlugin(mcpTool)` yields a plugin that contains:
  - `plugin.server` registration for chat handler
  - `plugin.client` registration for UI bridging
  - (optional later) `plugin.mcp` registration for external MCP server
- **Max type safety** for elicitation UI:
  - MCP-style tools declare a finite elicitation surface via `.elicits({...})`
  - `ctx.elicit(key, ...)` only accepts declared keys
  - `makePlugin(mcpTool).onElicit({ ... })` must implement every declared key (exhaustive)
- **Structured IDs internally**, but ergonomic API keys:
  - Author calls `ctx.elicit('confirm', ...)`
  - Runtime uses `{ toolName, key, callId, seq }` for correlation/logging/timeline
- **Server-side sampling works** in the in-app (bridged) mode.
- **Validation in all places**:
  - Client-side handler output is type-checked by TS
  - Server validates tool params and validates elicitation responses with Zod
  - (Optional) client validates before sending response (nice-to-have)

## Non-goals (initial MVP)
- `plugin.client` does **not** implement sampling.
- No durable/replay serialization of MCP generator state.
- No support for elicitation inside `ctx.branch()` sub-branches.
- No guaranteed support for concurrent pending elicitation requests.

---

## Terminology
- **MCP-style tool**: a server-side generator tool that may call capabilities:
  - `elicit` (user input)
  - `sample` (LLM completion)
  - `log` (logging)
  - `notify` (progress)
- **Bridge (in-app)**: an execution mode where `elicit` requests are handled by framework client UI runtime instead of MCP.
- **Plugin**: an E2E bundle derived from an MCP-style tool with client-side handlers and server-side registration.

---

## Core API shapes (proposed)

### 1) Declaring a finite elicitation surface
Add to MCP tool builder:

```ts
const tool = createMcpTool('book_flight')
  .description('Book a flight')
  .parameters(z.object({ from: z.string(), to: z.string() }))
  .elicits({
    pickFlight: z.object({ flightId: z.string() }),
    confirm: z.object({ ok: z.boolean() }),
  })
  .handoff({ ... })
```

**Design intent**: `.elicits(...)` is a compile-time contract that enables exhaustive UI bridging.

### 2) Elicitation call signature
Upgrade `ctx.elicit` from:

- `elicit<T>({ message, schema })`

to:

```ts
elicit<K extends keyof TElicits>(
  key: K,
  options: { message: string }
): Operation<ElicitResult<z.infer<TElicits[K]>>>
```

Where `TElicits` is the object passed to `.elicits(...)`.

**Notes**
- The schema is derived from `key`.
- Server always validates results against the Zod schema.

### 3) Plugin derivation

```ts
export const plugin = makePlugin(tool)
  .onElicit({
    pickFlight: function* (req, ctx) {
      const flightId = yield* ctx.step(FlightPicker, req.ui)
      return { action: 'accept', content: { flightId } }
    },
    confirm: function* (req, ctx) {
      const ok = yield* ctx.step(Confirm, { message: req.message })
      return { action: ok ? 'accept' : 'decline', content: { ok } }
    },
  })
  .build()
```

### 4) `onElicit` request object
Handlers should receive:

```ts
interface ElicitRequest<TKey extends string, TSchema extends z.ZodType> {
  id: {
    toolName: string
    key: TKey
    callId: string
    seq: number
  }

  key: TKey
  toolName: string
  callId: string
  seq: number

  message: string

  schema: {
    zod: TSchema
    json: Record<string, unknown> // derived
  }

  // Optional (recommended) for richer UI:
  params?: unknown
  handoff?: unknown
}
```

### 5) Response type
Handlers return the explicit MCP-style response:

```ts
type ElicitResult<T> =
  | { action: 'accept'; content: T }
  | { action: 'decline' }
  | { action: 'cancel' }
```

---

## Execution model (in-app bridge)

### Server (chat handler)
- LLM tool call begins normally.
- Execute MCP-style tool generator (Effection) with a capability context:
  - `sample`: server-side provider-backed sampling
  - `log/notify`: emit timeline patches/events
  - `elicit(key, {message})`:
    1. Construct `ElicitRequest` with structured id `{ toolName, key, callId, seq }`.
    2. Emit a client-visible “pending elicitation” step/event.
    3. Suspend awaiting `ElicitResponse` correlated by `id`.
    4. Validate the response with the declared Zod schema for `key`.
    5. Resume generator with `ElicitResult<T>`.

### Client (framework UI runtime)
- Receives `ElicitRequest` events.
- Uses `toolName` to select the active plugin.
- Dispatches to `plugin.onElicit[key]`.
- Runs the handler generator with the normal client context (steps/waitFor/etc.).
- Sends the returned `ElicitResult` back to server correlated by `id`.

---

## Branching constraints
- **Disallow `elicit` when branch depth > 0**.
  - Rationale: branches represent “sub-agent computation” collapsing into a value; user interaction breaks the abstraction and UX.
- Allow `sample` in branches (server-side).

---

## Concurrency constraints
MVP constraints:
- At most **one pending elicitation** per tool call.
- If a second `elicit` is attempted while one is pending, throw an error with a helpful message.

Rationale: supporting multiple concurrent UI prompts requires UX and state decisions.

---

## Validation strategy ("all the places")
- **Client**: TypeScript ensures handler returns the correct `ElicitResult` shape.
- **Client (optional)**: validate `content` with Zod before sending to server.
- **Server**: validate tool params and validate elicitation `content` with the tool’s declared Zod schema for that key.

---

## Registration / Packaging

### Plugin export shape
A plugin should provide:
- `server.tools`: server-side tool(s) to register into the chat handler tool registry
- `client`: client-side registration object consumed by `useChat({ plugins: [...] })`

Optional later:
- `mcp`: tools to register into an external MCP server

### Intended usage
Server:
```ts
import { bookFlightPlugin } from './bookFlightPlugin'
registerTools(bookFlightPlugin.server.tools)
```

Client:
```ts
import { bookFlightPlugin } from './bookFlightPlugin'
useChat({ plugins: [bookFlightPlugin.client] })
```

---

## Migration / Backwards compatibility
- Existing `createMcpTool` / `createBranchTool` should continue to work.
- `.elicits(...)` is opt-in; tools without it can still call the legacy `elicit({schema,...})` path or be considered “not bridgeable”.

---

## Open questions (deferred)
- Client-side sampling (`plugin.client.sample`) support.
- External MCP exposure (`plugin.mcp`) and how to share the same tool definition.
- Support for concurrent pending elicits (UI/UX implications).
- Whether/when to support `elicit` in branches (current answer: no).
