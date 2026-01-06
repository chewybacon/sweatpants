# MCP Tools Design Spec

> **Status:** Draft  
> **Authors:** Grove Team  
> **Date:** January 2026

## Overview

This document describes the design for authoring MCP (Model Context Protocol) tools using our generator-based approach. The goal is to bring the same ergonomic DX we have for isomorphic browser tools to the MCP ecosystem.

## Background

### The Generator-Based Tool Pattern

Our framework uses Effection generators for tool execution. The `yield*` pattern provides:

- **Structured concurrency** - Child tasks automatically clean up
- **Suspension points** - Operations pause at `yield*`, resume when complete
- **Composability** - Generators compose naturally
- **Cancelation** - Operations can be halted at any yield point

### MCP's Bidirectional Primitives

MCP is not just request/response. During a `tools/call` execution, the server can make requests **back to the client**:

| Primitive | Method | Description |
|-----------|--------|-------------|
| **Elicitation** | `elicitation/create` | Request structured user input |
| **Sampling** | `sampling/createMessage` | Request LLM completion from client |
| **Logging** | `logging/setLevel` | Send log messages to client |

The spec explicitly states:

> "Elicitation in MCP allows servers to implement interactive workflows by enabling user input requests to occur *nested* inside other MCP server features."

> "Sampling in MCP allows servers to implement agentic behaviors, by enabling LLM calls to occur *nested* inside other MCP server features."

This maps perfectly to our generator model.

## Design

### The `*client(ctx)` Generator

The core authoring surface is the `*client()` generator with an `MCPClientContext`:

```typescript
const bookFlight = createMCPTool('book_flight')
  .description('Book a flight with user confirmation')
  .parameters(z.object({ 
    destination: z.string(),
    date: z.string() 
  }))
  .handoff({
    *before(params, ctx) {
      // Phase 1: Server-side setup (runs ONCE)
      const flights = yield* searchFlights(params)
      yield* ctx.db.saveSession({ flights, status: 'searching' })
      return { flights }
    },

    *client(handoff, ctx) {
      // Client phase: Multi-turn interaction via MCP primitives
      yield* ctx.log('info', 'Found available flights')
      
      const selection = yield* ctx.elicit({
        message: `Found ${handoff.flights.length} flights. Pick one:`,
        schema: z.object({ 
          flightId: z.string(),
          seatPreference: z.enum(['window', 'aisle', 'none'])
        })
      })
      
      if (selection.action === 'decline') {
        return { cancelled: true, reason: 'user_declined' }
      }
      
      if (selection.action === 'cancel') {
        return { cancelled: true, reason: 'user_dismissed' }
      }
      
      // Ask client's LLM to summarize the selection
      const summary = yield* ctx.sample({
        prompt: `Summarize flight ${selection.content.flightId} booking details`,
        maxTokens: 100
      })
      
      // Confirm with user
      const confirmation = yield* ctx.elicit({
        message: `${summary}\n\nConfirm this booking?`,
        schema: z.object({ confirmed: z.boolean() })
      })
      
      if (confirmation.action !== 'accept' || !confirmation.content.confirmed) {
        return { cancelled: true, reason: 'not_confirmed' }
      }
      
      return { 
        flightId: selection.content.flightId,
        seat: selection.content.seatPreference,
        confirmed: true
      }
    },

    *after(handoff, clientResult, ctx) {
      // Phase 2: Server-side finalization (runs ONCE)
      if (clientResult.cancelled) {
        yield* ctx.db.updateSession({ status: 'cancelled' })
        return `Booking cancelled: ${clientResult.reason}`
      }
      
      const booking = yield* createBooking(clientResult)
      yield* ctx.db.updateSession({ status: 'confirmed', booking })
      return `Booked flight ${booking.confirmationNumber}`
    },
  })
```

### MCPClientContext Primitives

```typescript
interface MCPClientContext {
  /**
   * Request structured input from user via MCP elicitation.
   * Maps to: elicitation/create
   */
  elicit<T>(config: {
    message: string
    schema: z.ZodType<T>
  }): Operation<ElicitResult<T>>

  /**
   * Request LLM completion from client via MCP sampling.
   * Maps to: sampling/createMessage
   */
  sample<T = string>(config: {
    prompt: string
    systemPrompt?: string
    schema?: z.ZodType<T>  // For structured output
    maxTokens?: number
    modelPreferences?: ModelPreferences
  }): Operation<T>

  /**
   * Send a log message to the client.
   * Maps to: notifications/message (logging)
   */
  log(level: 'debug' | 'info' | 'warning' | 'error', message: string): Operation<void>

  /**
   * Send a progress notification.
   * Maps to: notifications/progress
   */
  notify(message: string, progress?: number): Operation<void>
}

type ElicitResult<T> = 
  | { action: 'accept'; content: T }
  | { action: 'decline' }
  | { action: 'cancel' }

interface ModelPreferences {
  hints?: Array<{ name: string }>
  costPriority?: number      // 0-1
  speedPriority?: number     // 0-1  
  intelligencePriority?: number  // 0-1
}
```

### Multi-Turn via Natural Generator Flow

Each `yield*` is a suspension point. The runtime:

1. Sends the appropriate MCP request to the client
2. Suspends the generator
3. Waits for the response
4. Resumes the generator with the result

```typescript
*client(handoff, ctx) {
  // First round-trip
  const step1 = yield* ctx.elicit({ ... })
  
  // Second round-trip (only runs if first succeeded)
  const step2 = yield* ctx.sample({ ... })
  
  // Third round-trip
  const step3 = yield* ctx.elicit({ ... })
  
  // Normal control flow works
  if (step1.action === 'decline') {
    return { error: 'declined' }
  }
  
  // Loops work
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = yield* ctx.elicit({ ... })
    if (result.action === 'accept') {
      return result.content
    }
  }
  
  return { error: 'max_attempts' }
}
```

### Convenience Helpers

For common patterns, provide helpers:

```typescript
// Strict elicit - throws on decline/cancel
*client(handoff, ctx) {
  // Throws ElicitationDeclinedError or ElicitationCancelledError
  const result = yield* ctx.elicit.strict({
    message: 'Pick one:',
    schema: z.object({ choice: z.string() })
  })
  // result is T, not ElicitResult<T>
}

// Elicit with retry
*client(handoff, ctx) {
  const result = yield* ctx.elicit.withRetry({
    message: 'Pick one:',
    schema: z.object({ choice: z.string() }),
    maxAttempts: 3,
    onDecline: 'retry',  // or 'error' or 'return'
  })
}
```

## Protocol Mapping

### Message Flow

```
MCP Client                              MCP Server (your tool)
    |                                           |
    |------ tools/call (book_flight) --------->|
    |                                           |  before() runs
    |                                           |
    |<----- elicitation/create ----------------|  yield* ctx.elicit()
    |                                           |
    |------ elicitation response ------------->|  generator resumes
    |                                           |
    |<----- sampling/createMessage ------------|  yield* ctx.sample()
    |                                           |
    |------ sampling response ---------------->|  generator resumes
    |                                           |
    |<----- elicitation/create ----------------|  yield* ctx.elicit()
    |                                           |
    |------ elicitation response ------------->|  generator resumes
    |                                           |  after() runs
    |<----- tools/call result -----------------|
```

### Capability Checking

The runtime checks client capabilities during initialization:

```typescript
// During MCP handshake
const clientCapabilities = initResult.capabilities

// When tool uses ctx.elicit()
if (!clientCapabilities.elicitation) {
  throw new MCPCapabilityError('Client does not support elicitation')
}

// When tool uses ctx.sample()  
if (!clientCapabilities.sampling) {
  throw new MCPCapabilityError('Client does not support sampling')
}
```

Tools can declare required capabilities:

```typescript
const myTool = createMCPTool('my_tool')
  .requires({ elicitation: true, sampling: true })
  // Tool won't be listed if client doesn't have these capabilities
```

## Schema Handling

### Zod to JSON Schema

Elicitation uses JSON Schema. We convert Zod schemas at build time:

```typescript
const schema = z.object({
  flightId: z.string(),
  seatPreference: z.enum(['window', 'aisle', 'none'])
})

// Converts to:
{
  "type": "object",
  "properties": {
    "flightId": { "type": "string" },
    "seatPreference": { 
      "type": "string", 
      "enum": ["window", "aisle", "none"] 
    }
  },
  "required": ["flightId", "seatPreference"]
}
```

### Elicitation Schema Constraints

MCP elicitation only supports **flat objects with primitive properties**:

- `string` (with optional format: email, uri, date, date-time)
- `number` / `integer` (with optional min/max)
- `boolean`
- `enum` (string enums only)

**No nested objects, no arrays.**

We should validate this at build time:

```typescript
// This is valid
z.object({
  name: z.string(),
  age: z.number().min(18),
  agree: z.boolean()
})

// This will error at build time
z.object({
  user: z.object({ name: z.string() }),  // ERROR: nested object
  tags: z.array(z.string())              // ERROR: array
})
```

## The Handoff Pattern

Same pattern as isomorphic tools, but with MCP-specific context:

```typescript
.handoff({
  // Phase 1: Runs ONCE on server before client interaction
  *before(params, ctx) {
    // ctx has server capabilities (db, etc)
    // Return value is cached, sent to client phase
    return { /* handoff data */ }
  },

  // Client phase: Multi-turn MCP interaction
  *client(handoff, ctx) {
    // ctx is MCPClientContext (elicit, sample, log, notify)
    // handoff is cached data from before()
    // Can yield* multiple times for multi-turn
    return { /* client result */ }
  },

  // Phase 2: Runs ONCE on server after client interaction
  *after(handoff, clientResult, ctx) {
    // ctx has server capabilities
    // handoff is same cached data (NOT re-run)
    // clientResult is return value from *client()
    // Return value goes to LLM
    return 'Final result for LLM'
  },
})
```

## Context Comparison

### Browser Context vs MCP Context

| Capability | Browser Context | MCP Context |
|------------|-----------------|-------------|
| User input | `ctx.render(Component)` | `ctx.elicit({ schema })` |
| LLM call | `ctx.prompt({ ... })` | `ctx.sample({ ... })` |
| Progress | Component state | `ctx.notify()` |
| Logging | `console.log` | `ctx.log()` |
| Rich UI | Full React | Flat form (JSON Schema) |

### Future: Declarative UI Bridge (v2)

For richer UI in MCP contexts, we could support declarative UI specs:

```typescript
*client(handoff, ctx) {
  // v2: If client supports A2UI/MCP-UI
  if (ctx.capabilities.declarativeUI) {
    return yield* ctx.renderUI({
      type: 'card-picker',
      cards: handoff.flights,
      responseSchema: z.object({ flightId: z.string() })
    })
  }
  
  // Fallback to flat elicitation
  return yield* ctx.elicit({
    message: formatFlightsAsText(handoff.flights),
    schema: z.object({ flightId: z.string() })
  })
}
```

## Error Handling

### Elicitation Errors

```typescript
*client(handoff, ctx) {
  const result = yield* ctx.elicit({ ... })
  
  switch (result.action) {
    case 'accept':
      return result.content
    case 'decline':
      // User explicitly said no
      return { error: 'user_declined' }
    case 'cancel':
      // User dismissed without choosing
      return { error: 'user_cancelled' }
  }
}
```

### Capability Errors

```typescript
class MCPCapabilityError extends Error {
  constructor(
    public capability: 'elicitation' | 'sampling',
    message: string
  ) {
    super(message)
  }
}
```

### Timeout/Disconnect

The runtime handles MCP timeouts and disconnects:

```typescript
*client(handoff, ctx) {
  try {
    return yield* ctx.elicit({ ... })
  } catch (e) {
    if (e instanceof MCPTimeoutError) {
      return { error: 'timeout' }
    }
    if (e instanceof MCPDisconnectError) {
      return { error: 'disconnected' }
    }
    throw e
  }
}
```

## Builder API

### Basic Tool

```typescript
const simpleTool = createMCPTool('simple')
  .description('A simple tool')
  .parameters(z.object({ input: z.string() }))
  .execute(function*(params, ctx) {
    // No handoff, just execute
    const result = yield* ctx.elicit({
      message: `Process "${params.input}"?`,
      schema: z.object({ confirm: z.boolean() })
    })
    return result.action === 'accept' && result.content.confirm
      ? `Processed: ${params.input}`
      : 'Cancelled'
  })
```

### Tool with Handoff

```typescript
const complexTool = createMCPTool('complex')
  .description('A complex tool with handoff')
  .parameters(z.object({ ... }))
  .requires({ elicitation: true, sampling: true })
  .handoff({
    *before(params, ctx) { ... },
    *client(handoff, ctx) { ... },
    *after(handoff, clientResult, ctx) { ... },
  })
```

### Headless Tool (No Client Interaction)

```typescript
const headlessTool = createMCPTool('calculate')
  .description('Perform calculation')
  .parameters(z.object({ expression: z.string() }))
  .execute(function*(params) {
    // No ctx needed, pure computation
    return { result: evaluate(params.expression) }
  })
```

## Runtime Architecture

### MCP Server Setup

```typescript
import { createMCPServer } from '@grove/framework/mcp'
import { bookFlight, calculate } from './tools'

const server = createMCPServer({
  name: 'my-server',
  version: '1.0.0',
  tools: [bookFlight, calculate],
})

// For stdio transport
server.listen()

// For HTTP transport
server.createHandler() // Returns HTTP handler
```

### Tool Execution

```typescript
// Pseudocode for runtime execution
async function executeToolCall(tool, params, mcpClient) {
  // Check capabilities
  if (tool.requires?.elicitation && !mcpClient.capabilities.elicitation) {
    throw new MCPCapabilityError('elicitation', '...')
  }

  // Create context
  const ctx = createMCPClientContext(mcpClient)
  
  // Run generator
  if (tool.handoff) {
    // Phase 1
    const handoff = await run(tool.handoff.before(params, serverCtx))
    
    // Client phase
    const clientResult = await run(tool.handoff.client(handoff, ctx))
    
    // Phase 2
    return await run(tool.handoff.after(handoff, clientResult, serverCtx))
  } else {
    return await run(tool.execute(params, ctx))
  }
}
```

## Open Questions

### 1. Unified Builder vs Separate Builders

**Option A:** Single `createIsomorphicTool()` that can target MCP or browser

```typescript
createIsomorphicTool('my_tool')
  .context('mcp')  // New context type
  .handoff({ ... })
```

**Option B:** Separate `createMCPTool()` builder

```typescript
createMCPTool('my_tool')
  .handoff({ ... })
```

**Recommendation:** Start with Option B for clarity. Unify later if patterns converge.

### 2. Shared Code Between Browser and MCP Tools

For tools that should work in both contexts:

```typescript
// Shared business logic
const flightSearch = {
  *searchFlights(params) { ... },
  *createBooking(data) { ... },
}

// MCP version
const bookFlightMCP = createMCPTool('book_flight')
  .handoff({
    *before(params) { return yield* flightSearch.searchFlights(params) },
    *client(handoff, ctx) {
      return yield* ctx.elicit({ ... })
    },
    *after(handoff, result) { return yield* flightSearch.createBooking(result) },
  })

// Browser version
const bookFlightBrowser = createIsomorphicTool('book_flight')
  .context('browser')
  .handoff({
    *before(params) { return yield* flightSearch.searchFlights(params) },
    *client(handoff, ctx) {
      return yield* ctx.render(FlightPicker, { flights: handoff.flights })
    },
    *after(handoff, result) { return yield* flightSearch.createBooking(result) },
  })
```

### 3. Testing Strategy

How do we test MCP tools?

```typescript
// Mock MCP client for testing
const mockClient = createMockMCPClient({
  elicitResponses: [
    { action: 'accept', content: { flightId: 'FL123' } },
    { action: 'accept', content: { confirmed: true } },
  ],
  sampleResponses: [
    'Flight FL123 departs at 10am, arrives 2pm.',
  ],
})

const result = await runMCPTool(bookFlight, { destination: 'NYC' }, mockClient)
```

### 4. Build-Time Discovery

Like isomorphic tools, MCP tools need build-time discovery for:

- Generating tool manifests
- Validating schemas
- Type generation

Extend existing Vite plugin or create MCP-specific plugin?

## Implementation Roadmap

### Phase 1: Core Primitives
- [ ] Define `MCPClientContext` interface
- [ ] Define `ElicitResult` and related types
- [ ] Implement `createMCPTool()` builder
- [ ] Basic schema validation (flat object constraint)

### Phase 2: Runtime
- [ ] MCP server wrapper (stdio transport)
- [ ] Generator executor with MCP request/response
- [ ] Capability checking
- [ ] Error handling

### Phase 3: DX
- [ ] Convenience helpers (`elicit.strict`, `elicit.withRetry`)
- [ ] Build-time schema validation
- [ ] Testing utilities
- [ ] HTTP transport support

### Phase 4: Advanced (v2)
- [ ] Declarative UI bridge (A2UI/MCP-UI)
- [ ] Unified builder exploration
- [ ] Tool composition patterns

## References

- [MCP Specification](https://modelcontextprotocol.io/specification/2025-06-18)
- [MCP Elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation)
- [MCP Sampling](https://modelcontextprotocol.io/specification/2025-06-18/client/sampling)
- [Isomorphic Tools Doc](./isomorphic-tools.md)
- [AG-UI Protocol](https://docs.ag-ui.com/) (for future declarative UI)
