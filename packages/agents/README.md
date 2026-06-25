# @sweatpants/agents

Unified agent model: **agents as callable coroutines on a shared durable stream with isomorphic fulfillment.**

This package implements the foundation of the A2A Protocol Support & Core Unification spec (`.pi/specs/a2a-protocol-support-spec.md`). It is built **alongside** the existing `@sweatpants/core` `createAgent` and the framework chat engine per the NFR-004 migration strategy — nothing existing is deleted.

## Implementation notes

- **`createAgent` uses `createApi` from `effection/experimental`** (same as `createTool`) — the agent's invocation surface is a `createApi` whose `invoke` runs the `entry` harness; the per-run `AgentCtx` is delivered through an Effection `Context`. `decorate` composes agent-level middleware via `api.around`.
- **Sub-agent sugar uses `M[K]` per key** (not `infer V`) so each `ctx.agents.X` accessor is typed by its own target's input/output. See the `SugarMap` comment in `ctx.ts` (review CB-1).
- **`waitForChange` race fix** (`@sweatpants/durable-streams`): subscribe-then-recheck inside a spawned child task, awaited via `yield* task`. Race-free (recheck closes the dropped-signal window) and leak-free (the child task tears down its own subscription on return; structured concurrency handles external halt). Avoids `resolve()`+`task.halt()` re-entrancy and `scoped`'s scope-rewrite interaction with dual-tail `each` consumers (review B-2).

## Stage 1 (this package)

The core skeleton the rest of the spec builds on:

| Spec requirement | Status | Where |
| --- | --- | --- |
| REQ-001 Agent as a callable coroutine (`createAgent` with `entry`/`subAgents`/`model`/`maxIterations`/`goal`) | ✅ | `create-agent.ts`, `types.ts` |
| REQ-002 Tool authoring API unchanged (re-exports `createTool`) | ✅ | `index.ts` |
| REQ-003 `ctx.call` single composition primitive; isomorphic local fulfillment | ✅ (local) | `ctx.ts`, `driver.ts` |
| REQ-004 Generated typed `ctx.agents`/`ctx.tools` sugar | ✅ | `ctx.ts` |
| REQ-005 Parallel composition (`all()` + `parallel()` helper) | ✅ | `parallel.ts` |
| REQ-006 Sub-agents are imports (no server) | ✅ | `driver.ts`, `ctx.ts` |
| REQ-007 Durable stream as shared medium; commands are appends | ✅ | `stream.ts`, `session.ts` |
| REQ-009 Harness as the `entry` tool (`ctx.sample`/`call`/`elicit`/`notify`) | ✅ | `ctx.ts`, `driver.ts` |
| REQ-010 Harness pure-function discipline (`ctx.state`/`messages`) | ✅ (mechanism) | `ctx.ts` |
| REQ-011 Snapshot+delta restoration (checkpoint) | ✅ (basic) | `driver.ts` |
| REQ-012 `sendMessage` with `contextId` OR `snapshot` | ✅ | `session.ts` |
| REQ-013 Checkpoint emission + O(1) LSN index | ✅ | `driver.ts`, `stream.ts` |
| REQ-014 Eliciting via `ctx.elicit` (parks on a substrate) | ✅ (long-lived scope) | `ctx.ts`, `session.ts` |
| REQ-015 Elicit/sample propagation through nesting + requestId routing | ✅ | `ctx.ts` (router) |
| REQ-020 `AgentEvent` canonical LSN-tagged vocabulary | ✅ | `events.ts`, `log.ts` |

## Remaining stages (not yet implemented)

- **REQ-016/017** `createA2AHandler` (A2A server, per-agent) and A2A client delegation — the HTTP handler, Agent Card, JSON-RPC `SendMessage`/`SendStreamingMessage`, SSE task/artifact updates, `input-required`↔elicit mapping. The `RemoteHandle` seam exists in `ctx.ts`; transports are stage 2.
- **REQ-018** Agent-aware `createMcpHandler` overload (generalize the existing framework MCP handler).
- **REQ-019** AG-UI as a configured event projection (no `bindAGUI`).
- **REQ-021** Eliminate `replayState` from the framework chat handler (migration).
- **REQ-022** agentcore tool-session → agent-session generalization.
- Full snapshot+**delta** replay (REQ-011 currently restores from the latest checkpoint; bounded delta replay lands with the chat-engine migration).
- Redis/Durable-Object backing for true stateless-server (NFR-002).

## Usage

```ts
import { createAgent, createAgentSession, createInMemoryAgentStreamStore } from '@sweatpants/agents'
import { createTool } from '@sweatpants/core'
import { z } from 'zod'

const Book = createTool({
  name: 'book',
  description: 'book a flight',
  input: z.object({ destination: z.string() }),
  output: z.object({ confirmed: z.boolean(), destination: z.string() }),
  progress: z.object({}),
  impl: function* ({ destination }) { return { confirmed: true, destination } },
})

const Hotel = createAgent({
  name: 'hotel', description: 'hotel agent', systemPrompt: 'book hotels',
  tools: {}, model: { provider: 'mock', id: 'm1' }, maxIterations: 1,
  entry: function* (input: { city: string }) { return { hotel: `Hilton ${input.city}` } },
})

const Travel = createAgent({
  name: 'travel', description: 'travel planner', systemPrompt: 'you plan trips',
  tools: { book: Book },
  subAgents: { hotel: Hotel },
  model: { provider: 'mock', id: 'm1' }, maxIterations: 10,
  entry: function* (_goal, ctx) {
    const flight = yield* ctx.tools.book({ destination: 'Tokyo' })
    const hotel = yield* ctx.agents.hotel({ city: 'Tokyo' })
    const confirm = yield* ctx.elicit('confirm', { message: 'Book it?' })
    return { flight, hotel, confirm }
  },
})

// Compose in-process — no server:
const session = yield* createAgentSession(Travel, {
  contextId: 'trip-1',
  store: createInMemoryAgentStreamStore(),
})
yield* session.send({ type: 'sendMessage', message: 'plan a trip to Japan' })
// …subscribe to session.events(0); respond to elicits via session.send({ type: 'respondElicit', … })
```
