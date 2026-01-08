# MCP Durable Tool Runtime Specification

**Status**: In Progress  
**Started**: 2026-01-07  
**Goal**: Build a first-of-its-kind MCP Streamable HTTP runtime that keeps tool execution generators alive across HTTP requests, supporting elicitation and sampling backchannels.

## Overview

We're implementing a durable tool execution runtime that:

1. **Keeps generators alive** across HTTP requests (no serialization)
2. **Supports MCP elicitation** (`elicitation/create`) mid-tool-execution
3. **Supports MCP sampling** (`sampling/createMessage`) mid-tool-execution
4. **Works over stateless HTTP** with session management (`MCP-Session-Id`)
5. **Is interface-driven** for swappable backends (in-memory → Durable Objects)
6. **Aligns with MCP spec** (2025-11-25) naming and protocol

## Design Principles

1. **In-memory for v1** - Keep generators alive, refcount pattern (like TokenBuffer)
2. **Interface-first** - Abstract storage/runtime behind interfaces, swap backends later
3. **No generator serialization** - Too complex (DB connections, transactions, etc.)
4. **MCP naming** - `createMcpTool`, align with spec for ecosystem benefit
5. **Miniflare/DO optional** - Try it, but behind interface via Effection context
6. **Framework-agnostic** - Build on `createStreamingHandler` pattern

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    McpHttpHandler                                │
│  (Hono/Express route that speaks MCP Streamable HTTP)           │
│  - POST /mcp → tools/call, elicit responses, notifications      │
│  - GET /mcp → SSE stream for server→client messages             │
│  - MCP-Session-Id header management                              │
├─────────────────────────────────────────────────────────────────┤
│                 ToolSessionRegistry                              │
│  (Interface - like SessionRegistry in durable-streams)          │
│  - acquire(sessionId) → ToolSession                             │
│  - release(sessionId)                                            │
│  - create(toolName, params) → ToolSession                       │
├─────────────────────────────────────────────────────────────────┤
│                    ToolSession                                   │
│  (Interface - the durable execution context)                    │
│  - id: string                                                    │
│  - status: 'running' | 'awaiting_elicit' | 'awaiting_sample'... │
│  - eventBuffer: for SSE resumability                            │
│  - respondToElicit / respondToSample                            │
├─────────────────────────────────────────────────────────────────┤
│                 InMemoryToolSession                              │
│  (Implementation - keeps Effection generator alive)             │
│  - Uses Queue for event buffering                               │
│  - Uses Signal for elicit/sample responses                      │
│  - Refcount for lifecycle management                            │
├─────────────────────────────────────────────────────────────────┤
│                  Tool Execution Runtime                          │
│  (Effection-based, Queue + Signal coordination)                 │
│  - ctx.elicit() → MCP elicitation/create                        │
│  - ctx.sample() → MCP sampling/createMessage                    │
│  - ctx.notify() → MCP notifications/progress                    │
├─────────────────────────────────────────────────────────────────┤
│                    createMcpTool()                               │
│  (Unified builder - replaces createBranchTool/createMCPTool)    │
└─────────────────────────────────────────────────────────────────┘
```

## Key Interfaces

### ToolSession

```typescript
type ToolSessionStatus =
  | 'initializing'
  | 'running'
  | 'awaiting_elicit'
  | 'awaiting_sample'
  | 'completed'
  | 'failed'
  | 'cancelled'

interface ToolSession<TResult = unknown> {
  readonly id: string
  readonly toolName: string
  
  status(): Operation<ToolSessionStatus>
  getEvents(afterLSN?: number): Stream<ToolSessionEvent, TResult>
  respondToElicit(elicitId: string, response: ElicitResult): Operation<void>
  respondToSample(sampleId: string, response: SampleResult): Operation<void>
  cancel(): Operation<void>
}
```

### ToolSessionRegistry

```typescript
interface ToolSessionRegistry {
  create<TParams, TResult>(
    tool: FinalizedMcpTool<string, TParams, any, any, TResult, any>,
    params: TParams,
    options?: ToolSessionOptions
  ): Operation<ToolSession<TResult>>
  
  get(sessionId: string): Operation<ToolSession | null>
  acquire(sessionId: string): Operation<ToolSession>
  release(sessionId: string): Operation<void>
}
```

### ToolSessionStore

```typescript
interface ToolSessionStore {
  get(sessionId: string): Operation<ToolSessionEntry | null>
  set(sessionId: string, entry: ToolSessionEntry): Operation<void>
  delete(sessionId: string): Operation<void>
  updateRefCount(sessionId: string, delta: number): Operation<number>
}
```

## MCP Protocol Mapping

| ToolSessionEvent | MCP Message |
|-----------------|-------------|
| `progress` | `notifications/progress` |
| `log` | `notifications/message` |
| `elicit_request` | `elicitation/create` request |
| `sample_request` | `sampling/createMessage` request |
| `result` | Response to `tools/call` |
| `error` | JSON-RPC error response |

## Dependencies

| Package | Purpose | Notes |
|---------|---------|-------|
| `@modelcontextprotocol/sdk` | MCP types | Types only, maybe validation |
| `miniflare` (dev, optional) | Local Durable Objects | Behind interface |
| `effection` | Async runtime | Already using |

## File Structure (Final)

```
packages/framework/src/lib/chat/mcp-tools/
├── index.ts                    # Main exports
├── types.ts                    # Shared types (renamed from branch-types)
├── builder.ts                  # createMcpTool (unified, renamed)
├── runtime.ts                  # Tool execution (renamed from bridge-runtime)
├── mock.ts                     # Mock runtime for testing
├── plugin.ts                   # Plugin bridge (existing)
├── session/
│   ├── index.ts
│   ├── types.ts               # ToolSession interfaces
│   ├── contexts.ts            # Effection DI contexts
│   ├── in-memory-store.ts     # InMemoryToolSessionStore
│   ├── session-registry.ts    # ToolSessionRegistry
│   ├── tool-session.ts        # InMemoryToolSession
│   └── __tests__/
├── protocol/
│   ├── index.ts
│   ├── types.ts               # MCP protocol types
│   ├── message-encoder.ts
│   ├── message-decoder.ts
│   └── sse-formatter.ts
├── handler/
│   ├── index.ts
│   ├── mcp-handler.ts         # createMcpHandler
│   ├── post-handler.ts
│   ├── get-handler.ts
│   ├── session-manager.ts
│   └── __tests__/
└── __tests__/                  # Existing tests (updated)
```

## Naming Changes (Breaking)

| Old | New |
|-----|-----|
| `createBranchTool` | `createMcpTool` |
| `createMCPTool` | Removed |
| `FinalizedBranchTool` | `FinalizedMcpTool` |
| `FinalizedBranchToolWithElicits` | `FinalizedMcpToolWithElicits` |
| `BranchContext` | `McpToolContext` |
| `BranchContextWithElicits` | `McpToolContextWithElicits` |
| `BranchHandoffConfig` | `McpToolHandoffConfig` |
| `BranchOptions` | `McpToolBranchOptions` |
| `BranchLimits` | `McpToolLimits` |
| `BranchDepthError` | `McpToolDepthError` |
| `BranchTokenError` | `McpToolTokenError` |
| `BranchTimeoutError` | `McpToolTimeoutError` |
| `BranchSampleConfig` | `McpToolSampleConfig` |
| `BranchServerContext` | `McpToolServerContext` |

## References

- [MCP Spec 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)
- [MCP Sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)
- [MCP Streamable HTTP Transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
