# Glossary

Terms as they're used in the Sweatpants framework. Some may differ from general usage.

---

## Core Concepts

### BridgeHost

The execution container for an MCP tool generator. Manages the tool's lifecycle, event channel, and suspension/resumption.

**File:** [`src/lib/chat/mcp-tools/bridge-runtime.ts#L1184-L1290`](../src/lib/chat/mcp-tools/bridge-runtime.ts#L1184-L1290)

```typescript
const host = createBridgeHost({
  tool: bookFlightTool,
  params: { destination: 'Tokyo' },
  callId: 'call_xyz789',
})

// Subscribe to events
for (const event of yield* each(host.events)) {
  // handle elicit, sample, log, notify
}

// Run to completion
const result = yield* host.run()
```

---

### Elicit / Elicitation

Request user input from within a tool. Causes the tool to **suspend** until the user responds.

**File:** [`src/lib/chat/mcp-tools/bridge-runtime.ts#L897-L1047`](../src/lib/chat/mcp-tools/bridge-runtime.ts#L897-L1047)

```typescript
// In tool code:
const picked = yield* ctx.elicit('pickFlight', {
  message: 'Select your flight',
  flights: [...],
})

// Tool suspends here until user responds
if (picked.action === 'accept') {
  // Use picked.content
}
```

**Compare with:** [Sample](#sample) (does NOT cause suspension)

---

### Handoff

Transfer of execution between server phases. Used in the `before/client/after` pattern for isomorphic tools.

```typescript
.handoff({
  *before(params) {
    // Phase 1: Server prepares data
    return { flights: [...] }
  },
  *client(handoff, ctx) {
    // Client execution (React/Agent)
    return yield* ctx.elicit('pick', handoff)
  },
  *after(handoff, clientResult) {
    // Phase 2: Server processes result
    return { confirmation: '...' }
  }
})
```

---

### LSN (Log Sequence Number)

Monotonically increasing number assigned to each event. Enables:
- **Ordering** - Events processed in correct order
- **Replay** - Client can request events after a specific LSN
- **Reconnection** - Resume from where you left off

**Format in HTTP:**
```
Request:  X-Last-LSN: 5
Response: {"lsn": 6, "event": {...}}
          {"lsn": 7, "event": {...}}
```

---

### Patch

Atomic state update sent from server to React. Different from events—patches are specifically for state management.

**File:** [`src/lib/chat/patches/`](../src/lib/chat/patches/)

**Types:**
- `content` - Text/reasoning additions
- `tool` - Tool approval, execution, result
- `elicit` - Elicitation request/response
- `emission` - Component rendering
- `buffer` - Streaming state

---

### Plugin

Client-side handlers for a tool's elicitations. Connects MCP tool definitions to React UI components.

**File:** [`src/lib/chat/mcp-tools/plugin.ts`](../src/lib/chat/mcp-tools/plugin.ts)

```typescript
const bookFlightPlugin = makePlugin(bookFlightTool)
  .onElicit({
    pickFlight: function* (req, ctx) {
      const result = yield* ctx.render(FlightPicker, { ... })
      return { action: 'accept', content: result }
    },
  })
  .build()
```

---

### Sample

Request LLM completion from within a tool. Does NOT cause tool suspension—the framework handles it server-side.

**File:** [`src/lib/chat/mcp-tools/bridge-runtime.ts#L449-L610`](../src/lib/chat/mcp-tools/bridge-runtime.ts#L449-L610)

```typescript
// Plain text response
const response = yield* ctx.sample({
  prompt: 'Find flights to Tokyo',
})

// Structured output (guaranteed valid JSON)
const move = yield* ctx.sampleSchema({
  prompt: 'Pick your move',
  schema: z.object({ cell: z.number() }),
  retries: 3,
})

// Tool calling (guaranteed tool call)
const strategy = yield* ctx.sampleTools({
  prompt: 'Choose strategy',
  tools: [...],
  retries: 3,
})
```

**Compare with:** [Elicit](#elicit--elicitation) (causes suspension)

---

### Session

A single tool execution that may span multiple HTTP requests. Identified by the LLM's `tool_call.id`.

**Hierarchy:**
```
SessionRegistry (handler-level)
  └── PluginSessionManager (tracks tool sessions)
        └── PluginSession (individual tool, e.g., book_flight)
              └── ToolSession (wrapper around BridgeHost)
```

**File:** [`src/lib/chat/mcp-tools/session/tool-session.ts`](../src/lib/chat/mcp-tools/session/tool-session.ts)

---

### Signal

Effection primitive for cross-boundary communication. Used to suspend/resume generators.

```typescript
// Create signal
const responseSignal = createSignal<Response, void>()

// Wait on signal (suspends)
const subscription = yield* responseSignal
const next = yield* subscription.next()  // Blocks until signal fires

// Fire signal (from elsewhere)
responseSignal.send({ ... })  // Unblocks the waiting code
```

---

## Architecture Components

### Chat Engine

The state machine that orchestrates everything. Pull-based—each `next()` call advances the state.

**File:** [`src/handler/durable/chat-engine.ts`](../src/handler/durable/chat-engine.ts)

**Phases:**
| Phase | Description |
|-------|-------------|
| `init` | Startup, emit session info |
| `process_plugin_responses` | Resume suspended tools |
| `streaming_provider` | Stream from LLM |
| `executing_tools` | Run tool calls |
| `awaiting_elicit` | Tool suspended for user input |
| `complete` | Done |

---

### Durable Handler

HTTP handler that wraps events with LSN and buffers them for replay.

**File:** [`src/handler/durable/handler.ts`](../src/handler/durable/handler.ts)

**Protocol:**
```
Request Headers:
  X-Session-Id: sess_abc123
  X-Last-LSN: 5

Response (NDJSON):
  {"lsn": 6, "event": {"type": "text", ...}}
  {"lsn": 7, "event": {"type": "complete", ...}}
```

---

### Plugin Session Manager

Manages active plugin tool sessions. Handles creation, lookup, and cleanup.

**File:** [`src/handler/durable/plugin-session-manager.ts`](../src/handler/durable/plugin-session-manager.ts)

```typescript
// Create session
const session = yield* pluginSessionManager.create({
  tool: bookFlightTool,
  params: { destination: 'Tokyo' },
  callId: toolCall.id,
  provider,
})

// Later, find session to resume
const session = yield* pluginSessionManager.get(sessionId, provider)
yield* session.respondToElicit(elicitId, result)
```

---

### Token Buffer

Stores serialized events for replay. Enables reconnection and multi-client fan-out.

**File:** [`src/lib/chat/durable-streams/`](../src/lib/chat/durable-streams/)

---

## Tool Types

### Isomorphic Tool

Tool that can run on server, client, or both with handoff between phases. Uses `createIsomorphicTool()` builder.

**File:** [`src/lib/chat/isomorphic-tools/builder.ts`](../src/lib/chat/isomorphic-tools/builder.ts)

---

### MCP Tool / Plugin Tool

Tool built with `createMcpTool()` that uses the elicit/sample context. Requires a plugin for client-side handling.

**File:** [`src/lib/chat/mcp-tools/mcp-tool-builder.ts`](../src/lib/chat/mcp-tools/mcp-tool-builder.ts)

---

## React Hooks

### useChat

High-level hook for chat UI. Returns messages, sendMessage, isStreaming.

**File:** [`src/react/chat/useChat.ts`](../src/react/chat/useChat.ts)

---

### useChatSession

Low-level hook for session management. Handles NDJSON parsing, patches, state.

**File:** [`src/react/chat/useChatSession.ts`](../src/react/chat/useChatSession.ts)

---

### useElicitExecutor

Auto-executes plugin handlers when elicit requests arrive.

**File:** [`src/react/chat/useElicitExecutor.ts`](../src/react/chat/useElicitExecutor.ts)

---

## Context Methods

### ctx.elicit(key, options)

Request user input. Suspends tool until user responds.

```typescript
const result = yield* ctx.elicit('pickFlight', {
  message: 'Select your flight',
  flights: [...],
})
```

---

### ctx.sample(config)

Request LLM completion. Does not suspend—handled server-side.

```typescript
const response = yield* ctx.sample({
  prompt: 'Find flights...',
})
```

---

### ctx.sampleSchema(config)

Request structured LLM output with guaranteed valid JSON.

```typescript
const move = yield* ctx.sampleSchema({
  prompt: 'Pick a cell',
  schema: z.object({ cell: z.number() }),
  retries: 3,
})
// move.parsed is guaranteed non-null
```

---

### ctx.sampleTools(config)

Request LLM to call a tool with guaranteed tool call.

```typescript
const strategy = yield* ctx.sampleTools({
  prompt: 'Choose strategy',
  tools: [
    { name: 'offensive', inputSchema: z.object({...}) },
    { name: 'defensive', inputSchema: z.object({...}) },
  ],
  retries: 3,
})
// strategy.toolCalls[0] is guaranteed to exist
```

---

### ctx.branch(fn, options)

Create a sub-branch with isolated conversation context.

```typescript
const result = yield* ctx.branch(function* (subCtx) {
  // subCtx has its own message history
  const response = yield* subCtx.sample({ prompt: '...' })
  return response
})
```

> [!WARNING]
> `ctx.elicit()` is not allowed inside branches (throws `BranchElicitNotAllowedError`)

---

### ctx.render(Component, props)

Render a React component and wait for user interaction. Used in plugin handlers.

```typescript
pickFlight: function* (req, ctx) {
  const result = yield* ctx.render(FlightPicker, {
    flights: context.flights,
  })
  return { action: 'accept', content: result }
}
```

---

### ctx.log(level, message)

Emit a log event.

```typescript
yield* ctx.log('info', 'Processing flight search...')
```

---

### ctx.notify(message, progress?)

Emit a progress notification.

```typescript
yield* ctx.notify('Searching flights...', 0.5)  // 50% progress
```
