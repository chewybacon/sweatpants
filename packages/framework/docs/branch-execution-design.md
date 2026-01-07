# Branch-Based Tool Execution Design

## Overview

This document describes the design and implementation of a **branch-based tool execution system** for MCP (Model Context Protocol) tools. The core innovation is using JavaScript generators to express multi-turn, bidirectional communication between MCP servers and clients, with support for **sub-branches** that enable complex agentic workflows.

## The Problem

When building AI tools that need to interact with both an LLM and a user, there's a fundamental tension:

1. **MCP servers** can expose tools and request LLM completions (`sampling/createMessage`) or user input (`elicitation/create`)
2. **MCP clients** (like Claude Desktop) own the LLM connection and user interface
3. Complex workflows often need **multiple rounds** of LLM reasoning and user interaction
4. Each "sub-task" might need its own **isolated context** (conversation history)

The question: How do we author tools that can orchestrate complex multi-turn flows while respecting MCP's client/server boundary?

## The Mental Model: Branching Timelines

We model tool execution as **branches off the main LLM timeline**:

```
Main Timeline (LLM conversation)
    |
    +-- tool_call: book_flight ----+
    |                              |
    |   +---------------------------v---------------------------+
    |   |  BRANCH (server-driven generator)                     |
    |   |                                                       |
    |   |  +-- sample() --> LLM backchannel --> response        |
    |   |  +-- sample() --> LLM backchannel --> response        |
    |   |  +-- branch() --+                                     |
    |   |  |              |                                     |
    |   |  |   SUB-BRANCH (isolated context)                    |
    |   |  |   +-- sample() --> response                        |
    |   |  |   +-- return value                                 |
    |   |  |              |                                     |
    |   |  +-- <reduces>--+                                     |
    |   |  +-- elicit() --> user input --> response             |
    |   |  +-- return final result                              |
    |   |                                                       |
    |   +-------------------------------------------------------+
    |                              |
    +-- tool_response <------------+
    |
    v continues
```

Key properties:

1. **Fork is a feature**: The branch has its own conversation context, isolated from the main timeline
2. **Server drives the loop**: The generator runs on the server, making multiple backchannel calls
3. **Client provides LLM as a service**: Server says "reason about this", client makes the LLM call
4. **Everything reduces**: Branches return a single value to their parent

## Why Generators?

JavaScript generators with `yield*` provide the perfect abstraction:

```typescript
function* bookFlight(params, ctx) {
  // This looks like synchronous code...
  const flights = yield* searchFlights(params.destination)  // Server-side
  const analysis = yield* ctx.sample({ prompt: 'Analyze...' })  // Crosses to client
  const confirmed = yield* ctx.elicit({ message: 'Book?' })  // Crosses to client
  return confirmed ? 'Booked!' : 'Cancelled'
}
```

Each `yield*` is a **suspension point** where:
- The generator pauses
- Control can cross the client/server boundary
- The result comes back
- The generator resumes

This maps naturally to MCP's request/response protocol.

## The Constraint: Serialization Boundaries

Not everything can cross the wire. Only **serializable data** can pass between client and server:

- Primitives (strings, numbers, booleans)
- Plain objects and arrays
- JSON-serializable structures

What **cannot** cross:
- Database connections
- File handles
- Closures
- Class instances with methods

This is why we have the **`before/client/after` handoff pattern**:

```typescript
.handoff({
  *before(params) {
    // SERVER: Has DB, file system, secrets
    const flights = yield* db.query('SELECT * FROM flights...')
    return { flights }  // Only serializable data crosses
  },
  
  *client(handoff, ctx) {
    // CLIENT PHASE: Can sample/elicit/branch
    // handoff.flights is just data - no DB connection
    const pick = yield* ctx.elicit({ message: 'Pick one' })
    return { flightId: pick.content.flightId }
  },
  
  *after(handoff, clientResult) {
    // SERVER: DB available again
    yield* db.query('INSERT INTO bookings...')
    return 'Booked!'
  }
})
```

## MCP Protocol Mapping

Our primitives map directly to MCP:

| Our Primitive | MCP Method | Direction |
|---------------|------------|-----------|
| `ctx.sample()` | `sampling/createMessage` | Server -> Client |
| `ctx.elicit()` | `elicitation/create` | Server -> Client |
| `ctx.log()` | `notifications/message` | Server -> Client |
| `ctx.notify()` | `notifications/progress` | Server -> Client |
| `ctx.branch()` | N/A (server-side) | Stays on server |

The `branch()` primitive is **not** an MCP concept - it's structured concurrency within the server. MCP only sees the leaf `sample`/`elicit` calls.

## The BranchContext API

```typescript
interface BranchContext {
  // Parent context (read-only)
  readonly parentMessages: readonly Message[]
  readonly parentSystemPrompt: string | undefined
  
  // Current branch state
  readonly messages: readonly Message[]  // Auto-tracked conversation
  readonly depth: number
  
  // LLM backchannel (MCP: sampling/createMessage)
  sample(config: { prompt: string }): Operation<SampleResult>      // Auto-tracked
  sample(config: { messages: Message[] }): Operation<SampleResult> // Explicit
  
  // User backchannel (MCP: elicitation/create)
  elicit<T>(config: ElicitConfig<T>): Operation<ElicitResult<T>>
  
  // Sub-branches (server-side structured concurrency)
  branch<T>(
    fn: (ctx: BranchContext) => Operation<T>,
    options?: BranchOptions
  ): Operation<T>
  
  // Logging
  log(level: LogLevel, message: string): Operation<void>
  notify(message: string, progress?: number): Operation<void>
}
```

### Two Sample Modes

**Auto-tracked mode** - Conversation history managed automatically:

```typescript
// Each call appends to ctx.messages
const r1 = yield* ctx.sample({ prompt: 'First question' })
const r2 = yield* ctx.sample({ prompt: 'Follow up' })  // Sees r1 in history
```

**Explicit mode** - Full control over messages:

```typescript
const result = yield* ctx.sample({
  messages: [
    ...ctx.parentMessages,  // Include parent context if wanted
    { role: 'user', content: 'Custom prompt' }
  ]
})
// Does NOT update ctx.messages
```

### Sub-Branches

```typescript
const detail = yield* ctx.branch(function* (subCtx) {
  // subCtx has its own conversation history
  // Can read parent via subCtx.parentMessages
  const result = yield* subCtx.sample({ prompt: 'Detailed analysis...' })
  return result.text
}, {
  inheritMessages: false,  // Start fresh (default: true)
  maxDepth: 2,             // Limit nesting
  timeout: 5000,           // Limit duration
})
```

Sub-branches:
- Run server-side (not a separate MCP call)
- Can sample/elicit/branch themselves
- Have their own conversation context
- Reduce back to a single return value

### Concurrency

Using Effection's `all()` for parallel branches:

```typescript
const [priceAnalysis, scheduleAnalysis] = yield* all([
  ctx.branch(analyzePrices),
  ctx.branch(analyzeSchedules),
])
```

Both branches run concurrently, both must complete before continuing.

## Implementation Architecture

```
+-------------------------------------------------------------------+
|  AUTHORING LAYER (what you write)                                 |
|                                                                   |
|  createBranchTool('book_flight')                                  |
|    .parameters(z.object({ destination: z.string() }))             |
|    .handoff({                                                     |
|      *before(params) { ... },                                     |
|      *client(handoff, ctx) { ... },                               |
|      *after(handoff, clientResult) { ... },                       |
|    })                                                             |
+-------------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------------+
|  RUNTIME LAYER (executes generators)                              |
|                                                                   |
|  - Runs generator, handling yield* operations                     |
|  - On sample -> creates protocol action, waits for response       |
|  - On elicit -> creates protocol action, waits for response       |
|  - On branch -> runs sub-generator with new context               |
|  - Manages conversation state (messages array) per branch         |
|  - Enforces limits (depth, tokens, timeout)                       |
+-------------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------------+
|  TRANSPORT LAYER (MCP)                                            |
|                                                                   |
|  - tools/list, tools/call (client -> server)                      |
|  - sampling/createMessage (server -> client)                      |
|  - elicitation/create (server -> client)                          |
+-------------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------------+
|  CLIENT (Claude Desktop, yo-chat, etc.)                           |
|                                                                   |
|  - Provides LLM for sampling requests                             |
|  - Provides UI for elicitation requests                           |
|  - Enforces policies (rate limits, approval)                      |
+-------------------------------------------------------------------+
```

## File Structure

```
packages/framework/src/lib/chat/mcp-tools/
  branch-types.ts      # BranchContext, BranchOptions, Message types
  branch-builder.ts    # createBranchTool() fluent builder
  branch-runtime.ts    # runBranchTool() executor, context management
  branch-mock.ts       # createMockBranchClient() for testing
  index.ts             # Public exports

apps/yo-mcp/src/
  runtime/mcp-bridge.ts  # Bridges generators to real MCP SDK
  tools/pick-card-branch.ts  # Example branch-based tool
  cli.ts                 # MCP server entry point
```

## Example: Pick Card with LLM Analysis

```typescript
export const pickCardBranchTool = createBranchTool('pick_card_branch')
  .description('Draw cards with optional LLM analysis')
  .parameters(z.object({
    count: z.number().min(2).max(10).default(5),
    analyze: z.boolean().default(false),
  }))
  .requires({ elicitation: true, sampling: true })
  .handoff({
    *before(params) {
      // Server-side: draw random cards (non-idempotent)
      const cards = drawCards(params.count)
      const secret = cards[Math.floor(Math.random() * cards.length)]
      return { cards, secret, analyze: params.analyze }
    },

    *client(handoff, ctx) {
      yield* ctx.log('info', `Drew ${handoff.cards.length} cards`)
      
      let analysis: string | undefined
      
      if (handoff.analyze) {
        // Sub-branch for isolated LLM analysis
        analysis = yield* ctx.branch(function* (subCtx) {
          const result = yield* subCtx.sample({
            prompt: `Analyze these cards: ${formatCards(handoff.cards)}`
          })
          return result.text
        }, {
          inheritMessages: false,  // Fresh context for analysis
          maxDepth: 1,
        })
      }
      
      // Ask user to pick
      const result = yield* ctx.elicit({
        message: analysis 
          ? `Analysis: ${analysis}\n\nPick a card!`
          : 'Pick a card!',
        schema: z.object({ cardNumber: z.number() })
      })
      
      if (result.action !== 'accept') {
        return { picked: null, cancelled: true, analysis }
      }
      
      return {
        picked: handoff.cards[result.content.cardNumber - 1],
        cancelled: false,
        analysis,
      }
    },

    *after(handoff, client) {
      if (client.cancelled) {
        return { success: false, message: 'Cancelled' }
      }
      
      const isWinner = client.picked === handoff.secret
      return {
        success: true,
        picked: formatCard(client.picked),
        secret: formatCard(handoff.secret),
        isWinner,
      }
    },
  })
```

## Testing

The mock runtime allows testing without a real MCP client:

```typescript
import { createMockBranchClient, runBranchTool } from '@sweatpants/framework/chat/mcp-tools'

const client = createMockBranchClient({
  sampleResponses: [
    'These cards show an interesting pattern...',  // For analysis branch
  ],
  elicitResponses: [
    { action: 'accept', content: { cardNumber: 3 } },
  ],
})

const result = yield* runBranchTool(
  pickCardBranchTool,
  { count: 5, analyze: true },
  client
)

// Assert on calls made
expect(client.sampleCalls).toHaveLength(1)
expect(client.elicitCalls).toHaveLength(1)
```

## Limits and Safety

Branches can be constrained at multiple levels:

```typescript
// 1. At branch site (most specific)
yield* ctx.branch(fn, { maxDepth: 2, timeout: 5000 })

// 2. At tool definition
createBranchTool('my_tool')
  .limits({ maxDepth: 5, maxTokens: 50000 })

// 3. At runtime (global policy)
runBranchTool(tool, params, client, {
  limits: { maxDepth: 10 }
})
```

Errors are thrown when limits are exceeded:
- `BranchDepthError` - Too many nested branches
- `BranchTokenError` - Token budget exceeded
- `BranchTimeoutError` - Branch took too long

## Future Directions

### Tool Composition in Branches

Currently, branches can only `sample`/`elicit`. Future work could allow:

```typescript
yield* ctx.branch(function* (subCtx) {
  // Call another tool from within a branch
  const result = yield* subCtx.callTool('analyze_prices', { ... })
  return result
}, {
  tools: [analyzePrices, checkAvailability],  // Bound tools
})
```

### Sampling with Tool Hints

MCP's `sampling/createMessage` doesn't support specifying which tools the LLM can use. Options:
- Protocol extension (add `tools` field)
- Message convention (embed tool schemas in system prompt)
- Lobby MCP spec maintainers

### AST Splitting

The `client()` generator could potentially be compiled/split to run in different environments (browser, different server), with MCP as the transport between phases. This would require solving generator state serialization.

## Design Decisions

1. **Explicit `branch()` vs implicit boundaries**: We chose explicit `ctx.branch()` calls rather than trying to infer boundaries. This makes the code clearer and avoids serialization surprises.

2. **Server-side branches**: Branches run entirely on the server. MCP is only used for the backchannel (`sample`/`elicit`). This avoids the complexity of distributed generator state.

3. **Two sample modes**: Auto-tracked (`{ prompt }`) for convenience, explicit (`{ messages }`) for control. Both are useful in different scenarios.

4. **Separate from isomorphic tools**: We kept `createBranchTool` separate from the existing `createIsomorphicTool` to avoid coupling. Future unification is possible.

5. **MCP-compatible**: Everything maps to existing MCP primitives. No protocol extensions required (though some would be nice).

## References

- [MCP Specification](https://modelcontextprotocol.io/specification)
- [MCP Sampling](https://modelcontextprotocol.io/specification/2025-06-18/client/sampling)
- [MCP Elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation)
- [Effection](https://frontside.com/effection) - Structured concurrency for JavaScript
