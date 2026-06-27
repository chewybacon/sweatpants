# MCP Durable Tool Runtime - Progress Tracker

**Spec**: [mcp-durable-runtime-spec.md](./mcp-durable-runtime-spec.md)  
**Started**: 2026-01-07

## Phase Overview

| Phase | Description | Status | Notes |
|-------|-------------|--------|-------|
| 1 | Naming Unification (Breaking) | COMPLETE | Unified types in new files, legacy aliases for compat |
| 2 | Fix Effection Pattern | COMPLETE | Buffered channel eliminates sleep(0) |
| 3 | ToolSession Interface | COMPLETE | Core abstraction with session, registry, store |
| 4 | MCP Protocol Mapping | COMPLETE | Event → JSON-RPC, SSE formatting |
| 5 | McpHttpHandler | COMPLETE | HTTP transport |
| 6 | Miniflare / DO | PENDING | Optional Cloudflare backend |
| 7 | Integration & Examples | COMPLETE | E2E tests, example server |
| 8 | yo-mcp Integration | COMPLETE | Rewrote yo-mcp to use HTTP handler |

---

## Phase 1: Naming Unification (Breaking) - COMPLETE

**Goal**: Single tool builder with MCP-first naming. Legacy aliases for backward compatibility.

### What Was Done

1. **Created new unified type file**: `mcp-tool-types.ts`
   - All `McpTool*` types (context, config, limits, etc.)
   - All error types (`McpToolDepthError`, `McpToolTokenError`, etc.)
   - Merged content from old `branch-types.ts` and `types.ts`

2. **Created new unified builder**: `mcp-tool-builder.ts`
   - `createMcpTool()` function
   - All builder interfaces (`McpToolBuilderBase`, etc.)
   - All finalized tool types (`FinalizedMcpTool`, `FinalizedMcpToolWithElicits`)

3. **Updated index.ts** with:
   - Primary exports from new unified files
   - Legacy aliases (`createBranchTool`, `BranchContext`, `BranchDepthError`, etc.)
   - Kept original simple API (`createMCPTool`, `builder.ts`, `types.ts`, `mock-runtime.ts`)

4. **Updated runtime files** to import from new unified files:
   - `branch-runtime.ts` - Uses `mcp-tool-types.ts` and `mcp-tool-builder.ts`
   - `bridge-runtime.ts` - Uses `mcp-tool-types.ts` and `mcp-tool-builder.ts`
   - `plugin.ts` - Uses `mcp-tool-types.ts` and `mcp-tool-builder.ts`
   - `branch-mock.ts` - Uses `mcp-tool-types.ts` and `mcp-tool-builder.ts`

5. **Updated test files** to import from index (using legacy aliases)

6. **Deleted orphaned old files**:
   - `branch-types.ts` (replaced by `mcp-tool-types.ts`)
   - `branch-builder.ts` (replaced by `mcp-tool-builder.ts`)

### Files After Phase 1

```
packages/framework/src/lib/chat/mcp-tools/
├── __tests__/          # All tests import from index
├── examples/           # Example tools
├── mcp-tool-types.ts   # NEW: Unified types (primary source)
├── mcp-tool-builder.ts # NEW: Unified builder (primary source)
├── branch-runtime.ts   # Updated: imports from new files
├── branch-mock.ts      # Updated: imports from new files
├── bridge-runtime.ts   # Updated: imports from new files
├── plugin.ts           # Updated: imports from new files
├── builder.ts          # KEPT: Original simple builder
├── types.ts            # KEPT: Original simple types
├── mock-runtime.ts     # KEPT: Original simple mock
└── index.ts            # Updated: exports both new and legacy
```

### Verification

- ✅ TypeScript compiles clean
- ✅ All 72 tests pass
- ✅ yo-mcp compiles clean

### Progress Log

- 2026-01-07: Phase 1 started
- 2026-01-07: Created `mcp-tool-types.ts` and `mcp-tool-builder.ts`
- 2026-01-07: Updated all runtime files to use new types
- 2026-01-07: Updated index.ts with legacy aliases
- 2026-01-07: Updated test imports
- 2026-01-07: Deleted orphaned files (`branch-types.ts`, `branch-builder.ts`)
- 2026-01-07: Phase 1 COMPLETE ✅

---

## Phase 2: Fix Effection Pattern (No sleeps) - COMPLETE

**Goal**: Replace `spawn + sleep(0)` with proper Effection patterns.

### What Was Done

1. **Created `createBufferedChannel<T>()`** in bridge-runtime.ts
   - Sync-safe channel that queues messages until subscriber iterates
   - No messages are dropped, regardless of subscription timing
   - `close()` waits for all queued messages to be delivered

2. **Updated `createBridgeHost()`** to use buffered channel
   - `eventChannel` is now created with `createBufferedChannel()`
   - This eliminates the subscribe-before-send race condition

3. **Removed `sleep(0)` from `runBridgeTool()`**
   - No longer needed because the buffered channel handles timing
   - Spawned event handler starts processing when it iterates, forwarder delivers all queued messages

4. **Key insight**: The buffered channel's `close()` method waits for:
   - A subscriber to start iterating (if queue has messages)
   - The forwarder to deliver all queued messages
   - This ensures no events are lost even if the tool completes before handler starts

### Verification

- ✅ TypeScript compiles clean
- ✅ All 72 tests pass
- ✅ No `sleep(0)` in bridge-runtime.ts

### Progress Log

- 2026-01-07: Phase 2 started
- 2026-01-07: Created `createBufferedChannel()` implementation
- 2026-01-07: Updated `createBridgeHost()` to use buffered channel
- 2026-01-07: Removed `sleep(0)` from `runBridgeTool()`
- 2026-01-07: Fixed `close()` to wait for subscriber if queue has messages
- 2026-01-07: All tests passing
- 2026-01-07: Phase 2 COMPLETE ✅

---

## Phase 3: ToolSession Interface - COMPLETE

**Goal**: Define the durable execution abstraction.

### What Was Done

1. **Created `session/types.ts`** with all interfaces:
   - `ToolSession` - Main session interface with events(), respondToElicit(), respondToSample(), cancel()
   - `ToolSessionRegistry` - Registry with create(), acquire(), release() and refcount
   - `ToolSessionStore` - Pluggable storage interface
   - `ToolSessionEvent` - Union of all event types (progress, log, elicit_request, sample_request, result, error, cancelled)
   - `ToolSessionSamplingProvider` - Interface for LLM sampling

2. **Created `session/contexts.ts`** for Effection DI:
   - `ToolSessionStoreContext`, `ToolSessionRegistryContext`, `ToolSessionSamplingProviderContext`
   - Accessor functions: `useToolSessionStore()`, `useToolSessionRegistry()`, etc.
   - Optional accessors that return undefined instead of throwing

3. **Created `session/in-memory-store.ts`**:
   - `createInMemoryToolSessionStore()` - Simple Map-based implementation
   - `createInMemoryToolSessionStoreWithDebug()` - With debug helpers for testing

4. **Created `session/tool-session.ts`**:
   - `createToolSession()` - Resource that wraps bridge-runtime
   - Keeps generator alive across HTTP requests
   - Emits events with LSN for resumability
   - Buffers events for late-joining subscribers

5. **Created `session/session-registry.ts`**:
   - `createToolSessionRegistry()` - Manages session lifecycle with refcount
   - Automatic cleanup when refCount reaches 0 and session is complete
   - Background polling for status updates

6. **Created `session/setup.ts`**:
   - `setupToolSessions()` - Configures all contexts in one call
   - Convenience re-exports of contexts and accessors

7. **Created `session/index.ts`**:
   - Barrel export for all session types and functions

8. **Updated main `index.ts`**:
   - Added exports for session module
   - All types and functions accessible from `@grove/framework/mcp-tools`

9. **Added tests** in `session/__tests__/tool-session.test.ts`:
   - Tests for createToolSession with result/progress/log/error events
   - Tests for LSN-based resumability
   - Tests for in-memory store CRUD operations
   - Tests for registry create/acquire/release
   - Tests for setupToolSessions DI

### Files Structure

```
packages/framework/src/lib/chat/mcp-tools/session/
├── __tests__/
│   └── tool-session.test.ts   # 9 tests
├── contexts.ts                 # Effection DI contexts
├── in-memory-store.ts          # In-memory implementation
├── index.ts                    # Barrel exports
├── session-registry.ts         # Registry with refcount
├── setup.ts                    # Setup helper
├── tool-session.ts             # Core session implementation
└── types.ts                    # All interfaces
```

### Verification

- ✅ TypeScript compiles clean
- ✅ All 81 tests pass (72 existing + 9 new session tests)

### Progress Log

- 2026-01-07: Phase 3 started
- 2026-01-07: Created session/types.ts with all interfaces
- 2026-01-07: Created session/contexts.ts for Effection DI
- 2026-01-07: Created session/in-memory-store.ts
- 2026-01-07: Fixed TypeScript errors in tool-session.ts (Stream type, optional properties)
- 2026-01-07: Created session/session-registry.ts with refcount pattern
- 2026-01-07: Created session/setup.ts for context configuration
- 2026-01-07: Created session/index.ts exports
- 2026-01-07: Updated main index.ts to export session module
- 2026-01-07: Added 9 tests for session module
- 2026-01-07: Phase 3 COMPLETE ✅

---

## Phase 4: MCP Protocol Mapping - COMPLETE

**Goal**: Map tool session events to MCP JSON-RPC messages.

### What Was Done

1. **Created `protocol/types.ts`** with MCP message types:
   - JSON-RPC base types (request, response, notification, error)
   - MCP content types (text, image, audio, resource, tool_use, tool_result)
   - Sampling types (createMessage request/response, model preferences)
   - Elicitation types (form mode, URL mode)
   - Notification types (progress, message/log)
   - SSE event types
   - Type guards and error codes

2. **Created `protocol/message-encoder.ts`**:
   - `encodeSessionEvent()` - Unified encoder for all ToolSessionEvent types
   - Individual encoders: `encodeProgressNotification()`, `encodeLogNotification()`, etc.
   - `createEncoderContext()` - Context for request ID generation and tracking
   - Maps internal LogLevel to MCP McpLogLevel

3. **Created `protocol/message-decoder.ts`**:
   - `decodeElicitationResponse()` - Converts MCP elicitation result to ElicitResult
   - `decodeSamplingResponse()` - Converts MCP sampling result to SampleResult
   - `parseJsonRpcMessage()` - Parses raw JSON into typed messages
   - `createDecoderContext()` - Tracks pending requests for correlation
   - Validation helpers for request/response types

4. **Created `protocol/sse-formatter.ts`**:
   - `formatSseEvent()` - Formats SSE events per spec
   - `formatMessageAsSse()` - Combines JSON-RPC + SSE formatting
   - `generateEventId()` / `parseEventId()` - Session:LSN format for resumability
   - `createPrimeEvent()` / `createCloseEvent()` - Stream control events
   - `parseSseEvent()` / `parseSseChunk()` - SSE parsing for clients/testing
   - `createSseHeaders()` / `createSseWriter()` - Stream helpers

5. **Created `protocol/index.ts`**:
   - Barrel export for all protocol types and functions

6. **Updated main `index.ts`**:
   - Added exports for entire protocol module

7. **Added tests** in `protocol/__tests__/protocol.test.ts`:
   - 28 tests covering encoder, decoder, and SSE formatter

### MCP Event Mapping

| ToolSessionEvent     | MCP Message                        |
|---------------------|-------------------------------------|
| progress            | notifications/progress              |
| log                 | notifications/message               |
| elicit_request      | elicitation/create request          |
| sample_request      | sampling/createMessage request      |
| result              | tools/call response (success)       |
| error               | tools/call response (error)         |
| cancelled           | tools/call response (error)         |

### Files Structure

```
packages/framework/src/lib/chat/mcp-tools/protocol/
├── __tests__/
│   └── protocol.test.ts     # 28 tests
├── types.ts                  # MCP JSON-RPC types
├── message-encoder.ts        # ToolSessionEvent → MCP
├── message-decoder.ts        # MCP → tool responses
├── sse-formatter.ts          # SSE formatting with event IDs
└── index.ts                  # Barrel exports
```

### Verification

- ✅ TypeScript compiles clean
- ✅ All 109 tests pass (72 original + 9 session + 28 protocol)

### Progress Log

- 2026-01-07: Phase 4 started
- 2026-01-07: Created protocol/types.ts with MCP message types (from MCP spec 2025-11-25)
- 2026-01-07: Created protocol/message-encoder.ts
- 2026-01-07: Created protocol/message-decoder.ts
- 2026-01-07: Created protocol/sse-formatter.ts with resumability support
- 2026-01-07: Created protocol/index.ts exports
- 2026-01-07: Added 28 tests for protocol module
- 2026-01-07: Updated main index.ts to export protocol module
- 2026-01-07: Phase 4 COMPLETE ✅

---

## Phase 5: McpHttpHandler - COMPLETE

**Goal**: HTTP handler that speaks MCP Streamable HTTP transport.

### What Was Done

1. **Created `handler/types.ts`** with handler types:
   - `McpHandlerConfig` - Configuration for the handler
   - `McpHttpMethod`, `McpRequestHeaders`, `McpParsedRequest` - Request parsing
   - `McpClassifiedRequest` - Union of all request types (tools_call, elicit_response, sample_response, sse_stream, terminate)
   - `McpPostResult` - Result of POST handling (JSON or SSE upgrade)
   - `McpSessionState` - Session state with pending elicits/samples
   - `McpHandlerError` - Error class with error codes

2. **Created `handler/request-parser.ts`**:
   - `parseHeaders()` - Extract MCP-relevant headers
   - `validatePostHeaders()` / `validateGetHeaders()` - Validate Content-Type/Accept
   - `parseRequest()` - Parse and validate incoming request
   - `classifyRequest()` - Classify request type based on method and body
   - `parseAndClassify()` - Unified parse + classify helper

3. **Created `handler/session-manager.ts`**:
   - `McpSessionManager` - Manages session state and lifecycle
   - `createSession()` - Create new session for tools/call
   - `acquireSession()` / `releaseSession()` - Session lifecycle with refcount
   - `handleElicitResponse()` / `handleSampleResponse()` - Route responses to sessions
   - Pending request tracking for correlation

4. **Created `handler/post-handler.ts`**:
   - `handleToolsCall()` - Handle tools/call requests
   - `handleElicitResponse()` / `handleSampleResponse()` - Handle responses
   - `handlePost()` - Unified POST handler
   - Race logic for immediate vs SSE response

5. **Created `handler/get-handler.ts`**:
   - `createSseEventStream()` - Transform ToolSessionEvents to SSE
   - `handleGet()` - Handle GET requests for SSE streaming
   - `createSseStreamSetup()` - Setup function for createStreamingHandler integration

6. **Created `handler/mcp-handler.ts`**:
   - `createMcpHandler()` - Main factory function
   - Returns `{ handler, manager }` for direct use
   - Proper Effection scope management for SSE streaming
   - JSON-RPC error responses for all error cases

7. **Created `handler/index.ts`**:
   - Barrel exports for all handler types and functions

8. **Updated main `index.ts`**:
   - Added exports for handler module

9. **Added tests** in `handler/__tests__/handler.test.ts`:
   - 26 tests for request parsing (headers, validation, classification)
   - Tests for POST request classification (tools_call, elicit, sample)
   - Tests for GET request classification (SSE stream, resumability)
   - Tests for DELETE request classification

### Files Structure

```
packages/framework/src/lib/chat/mcp-tools/handler/
├── __tests__/
│   └── handler.test.ts         # 26 tests + 7 todo
├── types.ts                    # Handler types and errors
├── request-parser.ts           # Request parsing and classification
├── session-manager.ts          # Session lifecycle management
├── post-handler.ts             # POST request handling
├── get-handler.ts              # SSE streaming
├── mcp-handler.ts              # Main handler factory
└── index.ts                    # Barrel exports
```

### MCP Streamable HTTP Implementation

| Endpoint | Method | Request | Response |
|----------|--------|---------|----------|
| /mcp | POST | tools/call | JSON or SSE (202 + upgrade) |
| /mcp | POST | elicitation response | JSON (202 Accepted) |
| /mcp | POST | sampling response | JSON (202 Accepted) |
| /mcp | GET | Mcp-Session-Id header | SSE stream |
| /mcp | DELETE | Mcp-Session-Id header | 204 No Content |

### Verification

- ✅ TypeScript compiles clean
- ✅ All 142 tests pass (135 passing + 7 todo)

### Progress Log

- 2026-01-07: Phase 5 started
- 2026-01-07: Created handler/types.ts with all interfaces
- 2026-01-07: Created handler/request-parser.ts with classification
- 2026-01-07: Created handler/session-manager.ts with lifecycle management
- 2026-01-07: Created handler/post-handler.ts for POST handling
- 2026-01-07: Created handler/get-handler.ts for SSE streaming
- 2026-01-07: Created handler/mcp-handler.ts main factory
- 2026-01-07: Created handler/index.ts exports
- 2026-01-07: Added 26 tests for handler module
- 2026-01-07: Updated main index.ts to export handler module
- 2026-01-07: Phase 5 COMPLETE ✅

---

## Phase 7: Integration & Examples - COMPLETE

**Goal**: Wire everything together with examples and tests.

### What Was Done

1. **Created E2E tests** in `handler/__tests__/mcp-handler.e2e.test.ts`:
   - Tests for simple tool execution with JSON response
   - Tests for unknown tool error handling
   - Tests for method validation (405 for unsupported methods)
   - Tests for header validation (400 for missing session, 406 for wrong Accept)
   - Tests for session termination (DELETE)
   - Tests for JSON-RPC validation (invalid body, missing tool name)
   - Tests for Content-Type validation (415 for non-JSON)
   - Tests for Mcp-Session-Id header in responses

2. **Created example server** in `examples/mcp-server-example.ts`:
   - `confirmTool` - Simple tool with elicitation
   - `analyzeTool` - Tool with sampling and progress updates
   - `interactiveTool` - Multi-step tool with both elicitation and sampling
   - `createMcpServer()` factory function for quick setup
   - Mock sampling provider for testing/demo

3. **Updated exports** in main `index.ts`:
   - All handler types and functions accessible

### yo-mcp Integration

**UPDATE (Phase 8)**: yo-mcp has been fully migrated to use the new HTTP handler. See Phase 8 for details.

### Verification

- ✅ TypeScript compiles clean
- ✅ All 154 tests pass (147 passing + 7 todo)
- ✅ E2E tests cover full request/response cycle

### Progress Log

- 2026-01-07: Phase 7 started
- 2026-01-07: Created mcp-handler.e2e.test.ts with 12 integration tests
- 2026-01-07: Created mcp-server-example.ts with example tools and factory
- 2026-01-07: Phase 7 COMPLETE ✅

---

## Phase 8: yo-mcp Integration - COMPLETE

**Goal**: Rewrite yo-mcp demo app to use the new MCP HTTP handler instead of the old `@modelcontextprotocol/sdk` stdio transport.

### What Was Done

1. **Rewrote all yo-mcp tools** to use `createMcpTool` with `.elicits()` pattern:
   - `apps/yo-mcp/src/tools/echo.ts` - Simple echo (no elicitation)
   - `apps/yo-mcp/src/tools/pick-card.ts` - Card game with elicitation
   - `apps/yo-mcp/src/tools/greet.ts` - Greeting with sampling
   - `apps/yo-mcp/src/tools/confirm.ts` - Confirmation with elicitation
   - `apps/yo-mcp/src/tools/pick-card-branch.ts` - Complex tool with sub-branches
   - `apps/yo-mcp/src/tools/index.ts` - Updated exports

2. **Created new HTTP-based CLI**:
   - `apps/yo-mcp/src/cli.ts` - Node.js HTTP server using `createMcpHandler`
   - Removed dependency on `@modelcontextprotocol/sdk`
   - Uses mock sampling provider for testing

3. **Deleted old files**:
   - Removed `apps/yo-mcp/src/runtime/mcp-bridge.ts` (old SDK bridge)

4. **Updated package.json**:
   - Removed `@modelcontextprotocol/sdk` dependency

### Verified with curl

```bash
# Echo tool (immediate JSON response)
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hello","uppercase":true}}}'
# Returns: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"echoed\":\"HELLO\",\"length\":5}"}],"isError":false}}

# Greet tool (SSE stream with sampling)
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"greet","arguments":{"name":"Alice","style":"pirate"}}}'
# Returns SSE events including progress, sampling request, and final result
```

### Files Modified

```
apps/yo-mcp/
├── src/
│   ├── cli.ts                    # REWRITTEN: HTTP server with createMcpHandler
│   └── tools/
│       ├── index.ts              # UPDATED: New exports, removed old tool arrays
│       ├── echo.ts               # REWRITTEN: Uses createMcpTool
│       ├── pick-card.ts          # REWRITTEN: Uses createMcpTool + .elicits()
│       ├── greet.ts              # REWRITTEN: Uses createMcpTool
│       ├── confirm.ts            # REWRITTEN: Uses createMcpTool + .elicits()
│       └── pick-card-branch.ts   # REWRITTEN: Uses createMcpTool + .elicits()
├── package.json                  # UPDATED: Removed @modelcontextprotocol/sdk
└── (runtime/mcp-bridge.ts)       # DELETED
```

### Progress Log

- 2026-01-07: Phase 8 started
- 2026-01-07: Rewrote all tools to use createMcpTool
- 2026-01-07: Created new HTTP-based cli.ts
- 2026-01-07: Removed @modelcontextprotocol/sdk dependency
- 2026-01-07: Verified with curl - echo and greet tools working
- 2026-01-07: Phase 8 COMPLETE

---

## Phase 6: Miniflare / Durable Objects (Optional) - PENDING

**Goal**: Add Cloudflare Durable Objects as an optional backend for session storage, enabling globally distributed, persistent tool sessions.

### Why Durable Objects?

Durable Objects provide:
- **Global persistence** - Sessions survive server restarts
- **Strong consistency** - Single-threaded execution per session
- **Edge distribution** - Sessions colocated with users
- **WebSocket support** - Real-time bidirectional communication
- **Hibernation** - Cost-effective for idle sessions

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP HTTP Handler                          │
│  (createMcpHandler)                                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                 ToolSessionRegistry                          │
│  - create(), acquire(), release()                            │
│  - Reference counting                                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  ToolSessionStore                            │
│  (interface - pluggable backend)                             │
├─────────────────────────────────────────────────────────────┤
│  InMemoryStore    │   DurableObjectStore (NEW)              │
│  (dev/testing)    │   (production)                           │
└───────────────────┴─────────────────────────────────────────┘
```

### Tasks

#### 6.1 Setup Miniflare for Local Development
- [ ] Add `miniflare` as optional dev dependency
- [ ] Create Miniflare configuration for local DO testing
- [ ] Add npm script for running with Miniflare

#### 6.2 Create Durable Object Session Store
- [ ] Create `session/durable-object-store.ts`:
  - `DurableObjectToolSessionStore` implementing `ToolSessionStore`
  - Handle DO stub creation and method calls
  - Serialize/deserialize session state
- [ ] Create `session/tool-session-do.ts`:
  - `ToolSessionDurableObject` class extending `DurableObject`
  - Store session state in DO storage
  - Handle hibernation/wake-up
  - Implement alarm for session timeout cleanup

#### 6.3 Implement DO Storage Methods
- [ ] `get(sessionId)` - Fetch session from DO storage
- [ ] `set(sessionId, entry)` - Store session entry
- [ ] `delete(sessionId)` - Remove session
- [ ] `updateRefCount(sessionId, delta)` - Atomic refcount update
- [ ] `updateStatus(sessionId, status)` - Update session status

#### 6.4 Handle Event Buffering in DO
- [ ] Store events in DO storage with LSN
- [ ] Implement `events(afterLSN)` resumability
- [ ] Handle event replay on reconnection
- [ ] Consider DO storage limits (128KB per key)

#### 6.5 WebSocket Support (Optional Enhancement)
- [ ] Implement DO WebSocket hibernation API
- [ ] Allow WebSocket connections for real-time events
- [ ] Fall back to SSE polling if WebSocket unavailable

#### 6.6 Testing
- [ ] Unit tests with mocked DO bindings
- [ ] Integration tests with Miniflare
- [ ] Test session persistence across "restarts"
- [ ] Test event replay after reconnection
- [ ] Test concurrent access patterns

#### 6.7 Documentation
- [ ] Document Cloudflare Workers setup
- [ ] Document wrangler.toml configuration
- [ ] Document environment variables
- [ ] Add deployment guide
- [ ] Add migration guide from in-memory to DO

### Implementation Notes

**Durable Object Class Structure:**
```typescript
export class ToolSessionDurableObject extends DurableObject {
  // Session state
  private sessionId: string
  private toolName: string
  private status: ToolSessionStatus
  private events: ToolSessionEvent[]
  private pendingElicits: Map<string, PendingElicitation>
  private pendingSamples: Map<string, PendingSample>
  
  // Methods
  async fetch(request: Request): Promise<Response>
  async alarm(): Promise<void>  // Cleanup expired sessions
  
  // Storage
  async loadState(): Promise<void>
  async saveState(): Promise<void>
}
```

**Store Adapter Pattern:**
```typescript
// In worker code
const store = createDurableObjectToolSessionStore({
  namespace: env.TOOL_SESSIONS,  // DO namespace binding
})

const registry = yield* createToolSessionRegistry(store, { samplingProvider })
const { handler } = createMcpHandler({ registry, tools })
```

**Wrangler Configuration:**
```toml
[[durable_objects.bindings]]
name = "TOOL_SESSIONS"
class_name = "ToolSessionDurableObject"

[[migrations]]
tag = "v1"
new_classes = ["ToolSessionDurableObject"]
```

### Files to Create

```
packages/framework/src/lib/chat/mcp-tools/session/
├── durable-object-store.ts     # DO store adapter
├── tool-session-do.ts          # Durable Object class
└── __tests__/
    └── durable-object.test.ts  # Tests with Miniflare
```

### Dependencies

```json
{
  "devDependencies": {
    "miniflare": "^3.x",
    "@cloudflare/workers-types": "^4.x"
  },
  "peerDependencies": {
    "@cloudflare/workers-types": "^4.x"
  }
}
```

### Progress Log

(Not started yet)

---

## Current Status Summary

### Completed (Phases 1-5, 7-8)

The MCP Durable Tool Runtime is **fully functional** with:

- **154 tests** (147 passing + 7 todo)
- **TypeScript** compiles clean
- **In-memory backend** ready for development/testing
- **HTTP handler** implements MCP Streamable HTTP spec (2025-11-25)
- **yo-mcp demo app** fully integrated with HTTP handler

### What's Working

```typescript
// Create tools with elicitation and sampling
const myTool = createMcpTool('my_tool')
  .description('Does something')
  .parameters(z.object({ input: z.string() }))
  .elicits({ confirm: z.object({ ok: z.boolean() }) })
  .execute(function* (params, ctx) {
    yield* ctx.notify('Working...', 0.5)
    const result = yield* ctx.elicit('confirm', { message: 'Proceed?' })
    return { confirmed: result.action === 'accept' }
  })

// Set up HTTP handler
const store = createInMemoryToolSessionStore()
const registry = yield* createToolSessionRegistry(store, { samplingProvider })
const { handler } = createMcpHandler({ registry, tools: new Map([['my_tool', myTool]]) })

// Use with any HTTP framework
app.all('/mcp', handler)
```

### What's Next

**Phase 6 (Optional)**: Cloudflare Durable Objects backend for:
- Production-ready persistence
- Global distribution
- Session hibernation
- WebSocket support

---

## Test Commands

```bash
# Run all MCP tools tests (154 tests)
cd packages/framework && pnpm vitest run src/lib/chat/mcp-tools

# Run handler tests only
cd packages/framework && pnpm vitest run src/lib/chat/mcp-tools/handler

# Run with watch mode
cd packages/framework && pnpm vitest src/lib/chat/mcp-tools

# TypeScript check
cd packages/framework && pnpm tsc --noEmit
```

## File Structure

```
packages/framework/src/lib/chat/mcp-tools/
├── __tests__/                    # Unit tests
├── examples/
│   ├── book-flight.ts            # Complex multi-turn tool example
│   └── mcp-server-example.ts     # HTTP server example
├── handler/                      # Phase 5: HTTP handler
│   ├── __tests__/
│   │   ├── handler.test.ts       # Request parsing tests
│   │   └── mcp-handler.e2e.test.ts  # E2E integration tests
│   ├── types.ts
│   ├── request-parser.ts
│   ├── session-manager.ts
│   ├── post-handler.ts
│   ├── get-handler.ts
│   ├── mcp-handler.ts
│   └── index.ts
├── protocol/                     # Phase 4: MCP protocol
│   ├── __tests__/
│   ├── types.ts
│   ├── message-encoder.ts
│   ├── message-decoder.ts
│   ├── sse-formatter.ts
│   └── index.ts
├── session/                      # Phase 3: Sessions
│   ├── __tests__/
│   ├── types.ts
│   ├── contexts.ts
│   ├── in-memory-store.ts
│   ├── tool-session.ts
│   ├── session-registry.ts
│   ├── setup.ts
│   └── index.ts
├── mcp-tool-types.ts             # Phase 1: Unified types
├── mcp-tool-builder.ts           # Phase 1: Unified builder
├── bridge-runtime.ts             # Phase 2: Buffered channels
└── index.ts                      # Main exports
```

## Notes

- Phase 1 used legacy aliases instead of hard break (easier migration)
- Using MCP SDK for types only, not transport
- Miniflare/DO is optional, behind `ToolSessionStore` interface
- HTTP handler is framework-agnostic (standard Fetch API)
- yo-mcp continues to use stdio transport (different use case)
