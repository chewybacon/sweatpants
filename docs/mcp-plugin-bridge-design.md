# MCP Plugin Bridge - Design Document

## Overview

This document describes the design for enabling MCP tools to run **inside the framework** (not as external MCP servers) with React UI handling for elicitation. This is "Phase 4" of the MCP runtime work.

## Goals

1. **MCP tools run in-app**: Tools execute within the chat-engine's Effection scope
2. **Server-side sampling**: `ctx.sample()` stays server-side, uses chat-engine's provider
3. **Client-side elicitation**: `ctx.elicit()` crosses serialization boundary to React
4. **React UI rendering**: `onElicit` handlers use `ctx.render()` to yield React components
5. **Type safety**: Exhaustive handlers, typed elicit keys, validated responses

## Architecture

```
SERVER (chat-engine)                    CLIENT (React)
                                        
MCP Tool Generator                      
  |                                     
  +-- ctx.sample() --> provider.stream()
  |   (stays server-side)               
  |                                     
  +-- ctx.elicit('key') -----------------> ElicitRequest
  |   (suspends on responseSignal)           |
  |                                          v
  |                                     onElicit handler
  |                                          |
  |                                          +-- ctx.render(Component)
  |                                          |   (React renders, user interacts)
  |                                          |
  |   <--------------------------------- ElicitResult
  |   (resumes)                         
  |                                     
  v                                     
Tool completes                          
```

## Key Design Decisions

### 1. Session ID = Tool Call ID

The LLM's `tool_call.id` is used as the `callId` for the bridge host. This:
- Ties the session to the specific tool invocation
- Enables correlation when client responds to elicit requests
- Matches the existing isomorphic tool pattern

### 2. `.elicits()` is Required

All MCP tools must call `.elicits({...})` (even if empty `{}`). This:
- Ensures type-safe `ctx.elicit(key)` calls
- Makes plugin tools detectable (they have `.elicits` property)
- Enforces exhaustive handler implementation in `makePlugin()`

### 3. `ctx.render()` for Elicit Handlers

The `onElicit` handlers use `ctx.render(Component, props)` matching the existing `BrowserRenderContext` pattern:

```typescript
onElicit: {
  pickFlight: function* (req, ctx) {
    const result = yield* ctx.render(FlightList, { flights: req.flights })
    return { action: 'accept', content: { flightId: result.flightId } }
  }
}
```

This reuses the emission channel infrastructure from isomorphic tools.

### 4. BridgeHost for Tool Execution

Each plugin tool execution creates a `BridgeHost` (from `bridge-runtime.ts`) which:
- Wraps the tool generator in an Effection resource
- Manages the `responseSignal` for suspend/resume on elicit
- Emits `BridgeEvent` for elicit, sample, log, notify

## Components

### Core Infrastructure

| Component | File | Purpose |
|-----------|------|---------|
| Plugin Executor | `plugin-executor.ts` | Creates `PluginClientContext`, runs handlers |
| Plugin Registry | `plugin-registry.ts` | Lookup plugins by tool name |
| Bridge Runtime | `bridge-runtime.ts` | Existing - runs MCP tools with backchannels |
| Plugin Builder | `plugin.ts` | Existing - `makePlugin().onElicit().build()` |

### Modified Components

| Component | File | Changes |
|-----------|------|---------|
| MCP Tool Builder | `mcp-tool-builder.ts` | Make `.elicits()` required |
| Plugin Types | `plugin.ts` | Update `PluginClientContext` with `render()` |
| Chat Engine | `chat-engine.ts` | Add plugin tool detection and execution |

### New Types

```typescript
// PluginClientContext - what onElicit handlers receive
interface PluginClientContext {
  callId: string
  signal: AbortSignal
  elicitRequest: ElicitRequest
  
  render<TProps, TResponse>(
    Component: ComponentType<TProps>,
    props: UserProps<TProps>
  ): Operation<TResponse>
  
  reportProgress?(message: string): Operation<void>
}

// PluginRegistry - lookup by tool name
interface PluginRegistry {
  register(plugin: PluginClientRegistration): void
  get(toolName: string): PluginClientRegistration | undefined
  has(toolName: string): boolean
}
```

## Execution Flow

### 1. Tool Call Received

```typescript
// In chat-engine executeToolCall()
const tool = registry.get(toolName)

// Check if it's a plugin tool
if (tool.elicits) {
  // Create bridge host with tool_call.id as callId
  const host = createBridgeHost({
    tool,
    params,
    callId: toolCall.id,
    samplingProvider: {
      *sample(messages, options) {
        // Use chat-engine's provider
        return yield* provider.stream(messages, options)
      }
    }
  })
  
  // Handle bridge events
  yield* spawn(function* () {
    for (const event of yield* each(host.events)) {
      // ... handle elicit, sample, log, notify
    }
  })
  
  return yield* host.run()
}
```

### 2. Elicit Event Handling

```typescript
case 'elicit': {
  // Look up plugin
  const plugin = pluginRegistry.get(toolName)
  
  // Create context with render() support
  const ctx = createPluginClientContext({
    callId: event.request.callId,
    toolName,
    elicitRequest: event.request,
    runtime,  // Emission runtime for ctx.render()
    signal,
  })
  
  // Execute handler
  const result = yield* executePluginElicitHandler(plugin, event.request, ctx)
  
  // Resume tool
  event.responseSignal.send({ id: event.request.id, result })
}
```

### 3. Component Emission

When handler calls `ctx.render()`:

```typescript
*render(Component, props) {
  const payload = {
    componentKey: getComponentKey(Component),
    props,
    _component: Component,
  }
  
  return yield* runtime.emit(COMPONENT_EMISSION_TYPE, payload)
}
```

The emission goes through the channel to React, which renders the component. When user interacts and calls `onRespond(value)`, the signal fires and the handler resumes.

## Demo: book_flight Tool

The implementation includes a full demo of an MCP plugin tool:

### Tool Definition

```typescript
const bookFlightTool = createMcpTool('book_flight')
  .description('Book a flight for the user')
  .parameters(z.object({
    from: z.string(),
    destination: z.string(),
  }))
  .elicits({
    pickFlight: z.object({ flightId: z.string() }),
    pickSeat: z.object({ row: z.number(), seat: z.string() }),
  })
  .execute(function* (params, ctx) {
    // 1. Mock flight search
    const flights = mockFlightSearch(params.from, params.destination)
    
    // 2. Elicit: Pick a flight
    const flightResult = yield* ctx.elicit('pickFlight', { 
      message: 'Select your flight',
      flights 
    })
    
    // 3. Elicit: Pick a seat
    const seatResult = yield* ctx.elicit('pickSeat', { 
      message: 'Select your seat',
      seatMap: mockSeatMap() 
    })
    
    // 4. Sample: Get travel tip
    const tip = yield* ctx.sample({ 
      prompt: `Travel tip for ${params.destination} airport...` 
    })
    
    // 5. Return confirmation
    return {
      ticketNumber: generateTicketNumber(),
      flight: selectedFlight,
      seat: `${seatResult.content.row}${seatResult.content.seat}`,
      price: selectedFlight.price,
      tip: tip.text,
    }
  })
```

### Plugin Definition

```typescript
const bookFlightPlugin = makePlugin(bookFlightTool)
  .onElicit({
    pickFlight: function* (req, ctx) {
      const result = yield* ctx.render(FlightList, {
        flights: req.flights,
        message: req.message,
      })
      return { action: 'accept', content: result }
    },
    pickSeat: function* (req, ctx) {
      const result = yield* ctx.render(SeatPicker, {
        seatMap: req.seatMap,
        message: req.message,
      })
      return { action: 'accept', content: result }
    },
  })
  .build()
```

### React Components

- **FlightList**: Cards with airline logo, flight number, times, price. Airplane icon in header.
- **SeatPicker**: Grid layout resembling airplane cabin. Available/taken/selected states.

## Testing Strategy

### Unit Tests

- `plugin-executor.test.ts`: Context creation, handler execution, emission flow
- `plugin-registry.test.ts`: Registration, lookup, error handling

### E2E Tests (Playwright)

- Full booking flow: message -> flight picker -> seat picker -> confirmation
- Verify UI elements: airplane icons, seat grid, prices
- Multi-elicit flow: both elicitations complete successfully
- Cancellation handling: user can decline

## File Structure

```
packages/framework/src/lib/chat/mcp-tools/
  plugin.ts               # Updated PluginClientContext
  plugin-executor.ts      # NEW: Handler execution
  plugin-registry.ts      # NEW: Plugin lookup
  mcp-tool-builder.ts     # Updated: .elicits() required

packages/framework/src/handler/durable/
  chat-engine.ts          # Plugin tool integration

apps/yo-chat/src/tools/book-flight/
  tool.ts                 # MCP tool definition
  plugin.ts               # makePlugin with handlers
  components/
    FlightList.tsx        # Flight selection UI
    SeatPicker.tsx        # Seat selection UI

apps/yo-chat/e2e/
  book-flight.spec.ts     # E2E tests
```

## Plugin Session Management

The Phase 1 implementation treats plugin tool execution synchronously within a single request.
This works for simple tools but fails when elicitation requires user interaction across HTTP request boundaries.

### Problem: Multi-Request Elicitation

Plugin tools can suspend mid-execution waiting for user input:

1. Request 1: LLM calls `book_flight` → tool calls `ctx.elicit('pickFlight')` → suspends
2. Client renders FlightPicker, user selects flight (could take seconds to hours)
3. Request 2: Client sends elicit response → tool resumes → may elicit again or complete

The tool generator must stay alive between requests. This requires a **session model**.

### Architecture: Plugin Session Manager

```
Handler Scope (long-lived)
├── PluginSessionManager
│   └── sessions: Map<sessionId, PluginSession>
│
Chat Engine Scope (per-request)
├── Request 1: executing_tools
│   ├── Create PluginSession for plugin tool
│   ├── Tool starts, calls ctx.elicit()
│   ├── Session emits elicit_request
│   └── Engine emits plugin_elicit_request, conversation_state → DONE
│
├── Request 2: process_plugin_responses
│   ├── Look up session by sessionId (= callId)
│   ├── session.respondToElicit(response)
│   ├── Tool resumes, completes OR elicits again
│   └── If complete → tool_result; If elicit → repeat
```

### Key Interfaces

```typescript
interface PluginSessionManager {
  create(config: CreatePluginSessionConfig): Operation<PluginSession>
  get(sessionId: string): Operation<PluginSession | null>
  abort(sessionId: string, reason?: string): Operation<void>
  listActive(): Operation<PluginSessionInfo[]>  // For inspection/debugging
}

interface PluginSession {
  readonly id: string           // Same as callId
  readonly toolName: string
  readonly callId: string
  
  status(): Operation<PluginSessionStatus>
  respondToElicit(elicitId: string, result: ElicitResult<unknown>): Operation<void>
  nextEvent(): Operation<PluginSessionEvent>
  abort(reason?: string): Operation<void>
}

type PluginSessionStatus =
  | 'running'
  | 'awaiting_elicit'
  | 'awaiting_sample'
  | 'completed'
  | 'failed'
  | 'aborted'
```

### State Machine Changes

New engine phases:
- `process_plugin_abort`: Handle explicit abort requests before anything else
- `process_plugin_responses`: Resume suspended sessions with elicit responses
- `plugin_awaiting_elicit`: Emit elicit request event, then transition to handoff

New tool execution result:
```typescript
{ ok: true; kind: 'plugin_awaiting'; sessionId: string; event: PluginElicitRequestEvent }
```

### Request Body Extensions

```typescript
interface ChatRequestBody {
  // ... existing fields ...
  
  pluginElicitResponses?: PluginElicitResponse[]
  pluginAbort?: { sessionId: string; reason?: string }
}

interface PluginElicitResponse {
  sessionId: string   // = callId from original tool call
  callId: string      // Included for conversation correlation
  elicitId: string    // Specific elicit request ID
  result: ElicitResult<unknown>
}
```

### Stream Event Extensions

```typescript
// Emitted when plugin tool suspends for elicitation
interface PluginElicitRequestEvent {
  type: 'plugin_elicit_request'
  sessionId: string
  callId: string
  toolName: string
  elicitId: string
  key: string         // Elicit key (e.g., 'pickFlight')
  message: string
  schema: Record<string, unknown>
}

// Emitted when session cannot be found (server restart, etc.)
interface PluginSessionErrorEvent {
  type: 'plugin_session_error'
  sessionId: string
  callId: string
  error: 'SESSION_NOT_FOUND' | 'SESSION_ABORTED' | 'INTERNAL_ERROR'
  message: string
}
```

### Error Handling: Session Not Found

When Request 2 arrives but session is gone (server restart, explicit abort, etc.):

1. Emit `plugin_session_error` event to stream
2. Add synthetic `tool_error` to conversation for the original callId
3. Continue to `start_iteration` - LLM can retry or handle gracefully

```typescript
state.conversationMessages.push({
  role: 'tool',
  tool_call_id: response.callId,
  content: 'Error: Plugin session was lost. Please retry the operation.',
})
```

### Session Lifecycle

**Creation:**
- When `executing_tools` detects a plugin tool
- Session ID = tool_call.id (correlation with LLM context)

**Active:**
- Session stays in `PluginSessionManager`
- Can transition between: running → awaiting_elicit → running → ...
- `listActive()` API for debugging/inspection

**Cleanup:**
- On tool completion (result or error)
- On explicit abort via `pluginAbort` in request body
- Future: configurable timeout (not implemented initially)

**Lost Sessions:**
- Server restart kills all in-memory sessions
- Request 2 receives `plugin_session_error`
- Client should handle gracefully (show error, allow retry)

### Reusing ToolSessionStore

The existing `ToolSessionStore` interface should be reused:

```typescript
interface ToolSessionStore {
  get(sessionId: string): Operation<ToolSessionEntry | null>
  set(sessionId: string, entry: ToolSessionEntry): Operation<void>
  delete(sessionId: string): Operation<void>
  updateRefCount(sessionId: string, delta: number): Operation<number>
  updateStatus(sessionId: string, status: ToolSessionStatus): Operation<void>
}
```

`PluginSession` should wrap or extend the existing `ToolSession` from `mcp-tools/session/`.
This may require refactoring to decouple `ToolSession` from `BridgeHost` - see TODO below.

### TODO: Sampling Configuration

**Deferred to future iteration.**

Plugin tools should be able to configure how `ctx.sample()` requests are handled:

```typescript
interface PluginSamplingConfig {
  // Prepare context window before sampling
  before?(messages: Message[], ctx: SamplingContext): Operation<PreparedRequest>
  
  // Make the model call (uses default provider if not specified)
  act?(prepared: PreparedRequest, provider: ChatProvider): Operation<SampleResult>
  
  // Validate/transform response before returning to tool
  after?(result: SampleResult, ctx: SamplingContext): Operation<SampleResult>
}
```

This follows the isomorphic handoff pattern (before/act/after) for fine-grained control
over the model call's context window, tool availability, and response validation.

For v1, sampling uses the chat-engine's provider directly without configuration.

---

## Context Data Transport (x-model-context)

### Problem

Plugin tools need to pass rich context data (e.g., flight list, seat map) to UI handlers. This data:
- Cannot be in the MCP elicitation response schema (that defines the *return* shape)
- Should work seamlessly over MCP wire protocol AND in-framework plugin pattern
- Should degrade gracefully for external MCP clients

### Solution: Belt and Suspenders

Context data is transmitted in **two locations** for maximum compatibility:

1. **JSON Schema extension**: `x-model-context` field (primary, clean JSON)
2. **Message boundary**: MIME-style encoded section (fallback)

### Wire Format

When tool calls:
```typescript
yield* ctx.elicit('pickFlight', {
  message: 'Select a flight from NYC to LAX:\n\n1. SkyHigh $299\n2. CloudAir $349',
  flights,     // context data
  seatMap,     // more context data
})
```

The MCP `elicitation/create` request becomes:

```json
{
  "method": "elicitation/create",
  "params": {
    "mode": "form",
    "message": "Select a flight from NYC to LAX:\n\n1. SkyHigh $299\n2. CloudAir $349\n\n--x-model-context: application/json\n{\"flights\":[...],\"seatMap\":{...}}",
    "requestedSchema": {
      "type": "object",
      "properties": { "flightId": { "type": "string" } },
      "x-model-context": {
        "flights": [...],
        "seatMap": {...}
      }
    }
  }
}
```

### Message Format (Multi-part style)

```
Select a flight from NYC to LAX:

1. SkyHigh SH-142 | 08:00-11:30 | $299
2. CloudAir CA-287 | 12:45-16:00 | $349

--x-model-context: application/json
{"flights":[...],"seatMap":{...}}
```

The boundary `--x-model-context: application/json` indicates:
- Everything above is human-readable message
- Everything below is encoded context data
- MIME type allows future formats (e.g., `application/json+gzip`)

### Extraction Priority (in plugin handler)

1. **Primary**: `schema['x-model-context']` - clean JSON, no parsing needed
2. **Fallback**: Parse from message boundary - handles schema stripping

```typescript
function extractModelContext(req: ElicitRequest): Record<string, unknown> {
  // Try schema first
  if (req.schema.json['x-model-context']) {
    return req.schema.json['x-model-context']
  }
  
  // Fallback to message parsing
  return parseMessageContext(req.message)
}
```

### Graceful Degradation

| Client Type | Experience |
|-------------|------------|
| Plugin handler | Full rich UI with typed context data |
| MCP client (x-model-context aware) | Can build enhanced UI from schema extension |
| MCP client (basic) | Shows human-readable message + basic form |
| Absolute fallback | Form works, message has encoded section at bottom |

### API Surface

Tool authors use the simple pattern:
```typescript
yield* ctx.elicit('pickFlight', {
  message: 'Human readable text with options listed...',
  flights,    // Extra props become context data
  seatMap,
})
```

Framework handles:
1. Extracting extra props (everything except `message`)
2. Injecting into schema as `x-model-context`
3. Appending encoded boundary section to message
4. On receive side: extraction from either location

### Why "x-model-context"?

- `x-` prefix: Standard convention for vendor extensions (OpenAPI, etc.)
- `model-context`: Generic enough for any MCP implementation, not framework-specific
- Validators ignore unknown keywords: JSON Schema compliant

---

## Open Questions (Resolved)

1. **Emission channel sharing**: Start with same channel as isomorphic tools; separate if needed
2. **State machine changes**: TBD during implementation based on test feedback
3. **Plugin registration**: Manual for now; update generator later if needed
4. **Session ID**: Use LLM's `tool_call.id` as sessionId for correlation
5. **Session storage**: Reuse existing `ToolSessionStore` interface
6. **Session cleanup**: On completion, abort, or server restart (no timeout for v1)
7. **Sampling config**: Deferred - use default provider pass-through for v1
8. **Context data transport**: Use `x-model-context` in schema + message boundary encoding
