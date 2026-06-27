# @sweatpants/agents

Unified agent model: **agents as callable coroutines on a shared durable stream with unified tool, interrupt, and exchange semantics.**

This package implements the local/in-process foundation for the A2A protocol support work and the unified tool model described in `.pi/specs/unified-tool-model-spec.md`. It is built **alongside** the existing `@sweatpants/core` and framework chat runtimes during migration.

## Unified tool model

Implemented surfaces:

- **Content-part `Message` model** — agent history, checkpoints, and exchanges use normalized `ContentPart[]` messages (`text`, `tool_use`, `tool_result`, `image`, `audio`, `resource`).
- **Native `createTool` builder** — `createTool(name).description(...).parameters(...).elicits(...).requires(...).execute((input, ctx) => ...)` produces a `UnifiedToolFactory` directly.
- **Declared keyed elicits** — `ToolCtx<TElicits>.elicit(key, { message, ...context, interrupt })` is typed from `.elicits({...})`; `ctx.elicitDynamic(...)` remains the dynamic escape hatch.
- **Tool-local history** — `ToolCtx.history` is a per-invocation accumulator. Tools may append `result.exchange.messages`; `ctx.call` includes that local history between the outer `tool_use` and `tool_result`.
- **Exchange return shape** — tool calls return `{ result, exchange }` from `ctx.call(...)` and `ctx.tools.X(...)`; agent sub-calls return `{ result, exchange? }` from `ctx.agents.X(...)`.
- **Migration helper** — use `ctx.callResult(target, input)` at old result-only call sites.
- **Interrupt descriptors** — `elicit_request` and host-fulfilled `sample_request` events carry `interrupt: { id, key, seq, reason, message, responseSchema?, contextSchema?, context?, toolCallId?, expiresAt?, metadata? }`; `requestId` remains as a migration alias.
- **Checkpoint before park** — the runtime emits a checkpoint with `pendingInterruptIds` before parking on elicit or host-fulfilled sample.
- **Server vs host sampling** — server-resolved samples use the configured `sampleProvider`, stream progress, and do not park; host-fulfilled samples emit `sample_request` and resume through `respondSample`.
- **Structured notifications** — tools get both `ctx.notify(message, fraction?, level?)` and `ctx.log(level, message)`.
- **Unified framework builders** — framework `createMCPTool` / `createIsomorphicTool` builder syntax is supported when the emitted value is invoked through the unified callable/runtime contract.

## Usage

```ts
import {
  createAgent,
  createAgentSession,
  createInMemoryAgentStreamStore,
  createTool,
} from '@sweatpants/agents'
import { z } from 'zod'

const BookFlight = createTool('book_flight')
  .description('Book a flight after user confirmation')
  .parameters(z.object({ destination: z.string() }))
  .elicits({
    confirm: {
      response: z.object({ confirmed: z.boolean() }),
      reason: 'confirmation',
    },
  })
  .requires({ elicitation: true })
  .execute(function* (input, ctx) {
    const confirmation = yield* ctx.elicit('confirm', {
      message: `Book a flight to ${input.destination}?`,
    })

    if (confirmation.action !== 'accept' || !confirmation.content.confirmed) {
      return { confirmed: false, destination: input.destination }
    }

    ctx.history.push(...confirmation.exchange.messages)
    yield* ctx.notify('Booking flight', 0.8)
    return { confirmed: true, destination: input.destination }
  })

const Travel = createAgent({
  name: 'travel',
  description: 'travel planner',
  systemPrompt: 'you plan trips',
  tools: { book_flight: BookFlight },
  model: { provider: 'mock', id: 'm1' },
  maxIterations: 10,
  entry: function* (_goal: string, ctx) {
    const { result, exchange } = yield* ctx.tools.book_flight({ destination: 'Tokyo' })
    ctx.history.push(...exchange.messages) // explicit append; runtime does not auto-append
    return result
  },
})

const session = yield* createAgentSession(Travel, {
  contextId: 'trip-1',
  store: createInMemoryAgentStreamStore(),
})

yield* session.send({ type: 'sendMessage', message: 'plan a trip to Japan' })
// Subscribe to session.events(0); respond to elicits with respondElicit(requestId, result).
```

## Migration notes

- New local tools must use `(input, ctx: ToolCtx)` via the unified builder contract; the removed progress-callback local execution model is no longer supported.
- Existing `const result = yield* ctx.call(...)` / `ctx.tools.X(...)` sites must either destructure `{ result, exchange }` or switch to `ctx.callResult(...)`.
- The runtime does **not** auto-append elicit, sample, or tool-call exchanges to agent history. Append explicitly when the harness wants the model to see them.
- Bridgeable static UI prompts must be declared with `.elicits({...})` and called by key with `ctx.elicit(key, ...)`; truly dynamic prompts must use `ctx.elicitDynamic(...)` with request-local schema metadata.

## Implementation notes

- `createAgent` uses `createApi` from `effection/experimental`; the per-run `AgentCtx` is delivered through an Effection `Context`.
- Sub-agent/tool sugar maps index by `M[K]` per key so each accessor preserves its own input/output inference.
- The in-memory session substrate keeps parked coroutines live. If a parked substrate is lost, resume must fail rather than replaying JS generator frames from logs.

## Test coverage

Primary local proofs live under `src/__tests__/`:

- `ctx-call.test.ts` — `{ result, exchange }` return shape and migration helper behavior.
- `elicit.test.ts` — elicit routing, nested/sub-agent propagation, parallel cover-all behavior.
- `create-tool2-e2e.test.ts` — migration wrapper for native unified tools.
- `book-flight-e2e.test.ts` — framework MCP handoff through unified `ToolCtx`.
- `isomorphic-e2e.test.ts` — isomorphic server-only and handoff tools through unified `ToolCtx`.

Framework and core tests assert the terminal unified behavior rather than legacy coexistence.
