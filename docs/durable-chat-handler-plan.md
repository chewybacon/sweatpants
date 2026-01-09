# Durable Chat Handler Implementation Plan

## Overview

We're building a new pull-based durable chat handler that:
- Buffers all stream events to a durable TokenBuffer
- Supports client reconnection from last LSN (Log Sequence Number)
- Uses a pull-based architecture throughout (proper backpressure)
- Implements a clean protocol for session management

This is a fresh implementation, not a refactor of the existing `createChatHandler`. The old handler will eventually become obsolete.

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                      createDurableChatHandler                          │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Request ──► ModelBinder ──► { sessionId?, lastLSN? }                 │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │                    SessionRegistry.acquire()                      │ │
│  │                                                                   │ │
│  │  NEW SESSION:                                                     │ │
│  │  ┌────────────────────────────────────────────────────────────┐  │ │
│  │  │  ChatEngine (Stream<StreamEvent>)                          │  │ │
│  │  │       │                                                     │  │ │
│  │  │       │ pull                                                │  │ │
│  │  │       ▼                                                     │  │ │
│  │  │  writeFromStreamToBuffer() ──► TokenBuffer                 │  │ │
│  │  │  (spawned writer task)              │                       │  │ │
│  │  └────────────────────────────────────────────────────────────┘  │ │
│  │                                        │                          │ │
│  │  RECONNECT:                            │                          │ │
│  │  (no new writer - buffer already       │                          │ │
│  │   has data or writer still running)    │                          │ │
│  │                                        │                          │ │
│  │                                        ▼                          │ │
│  │  ┌────────────────────────────────────────────────────────────┐  │ │
│  │  │  createPullStream(buffer, startLSN)                        │  │ │
│  │  │       │                                                     │  │ │
│  │  │       │ pull                                                │  │ │
│  │  │       ▼                                                     │  │ │
│  │  │  createWebStreamFromBuffer() ──► Response (NDJSON + LSN)   │  │ │
│  │  └────────────────────────────────────────────────────────────┘  │ │
│  │                                                                   │ │
│  │  SessionRegistry.release() (on response complete)                 │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  Response Headers: X-Session-Id: {sessionId}                          │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

## Protocol

### Request Parameters

Bound from headers (precedence) then query params. Body is not used for protocol params (content negotiation concerns).

| Parameter | Header | Query Param | Description |
|-----------|--------|-------------|-------------|
| sessionId | `X-Session-Id` | `sessionId` | Session ID for reconnect |
| lastLSN | `X-Last-LSN` | `lastLsn` | Resume point (LSN to start from) |

### Response Format

- Content-Type: `application/x-ndjson`
- Header: `X-Session-Id: {sessionId}`
- Each line is a JSON object with LSN:

```json
{"lsn": 1, "event": {"type": "session_info", ...}}
{"lsn": 2, "event": {"type": "text", "text": "Hello"}}
{"lsn": 3, "event": {"type": "text", "text": " world"}}
{"lsn": 4, "event": {"type": "complete", "text": "Hello world"}}
```

### Session Lifecycle

1. **New Session**: No sessionId in request → server generates UUID, creates buffer, runs chat engine
2. **Reconnect**: sessionId + lastLSN provided → server acquires existing session, streams from buffer at offset
3. **Cleanup**: When refCount hits 0 AND session is complete → buffer and session are deleted (handled by SessionRegistry)

## Chat Engine State Machine

Pull-based state machine that yields `StreamEvent` objects.

### States

```
INIT → PROCESS_CLIENT_OUTPUTS → START_ITERATION → STREAMING_PROVIDER
                                       ↑                    │
                                       │                    ▼
                                       │            PROVIDER_COMPLETE
                                       │                    │
                                       │         ┌──────────┴──────────┐
                                       │         │                     │
                                       │    no tools              has tools
                                       │         │                     │
                                       │         ▼                     ▼
                                       │      COMPLETE          EXECUTING_TOOLS
                                       │         │                     │
                                       │         │                     ▼
                                       │         │             TOOLS_COMPLETE
                                       │         │                     │
                                       │         │         ┌───────────┴───────────┐
                                       │         │         │                       │
                                       │         │    has handoffs            no handoffs
                                       │         │         │                       │
                                       │         │         ▼                       │
                                       │         │   HANDOFF_PENDING               │
                                       │         │         │                       │
                                       │         ▼         ▼                       │
                                       │        DONE ◄─────┘                       │
                                       │                                           │
                                       └───────────────────────────────────────────┘
                                              (next iteration)
```

### Pending Events Buffer

When a state transition produces multiple events (e.g., multiple tool results), they go into a `pendingEvents` buffer. Subsequent `next()` calls drain this buffer before advancing the state machine.

```typescript
*next(): Operation<IteratorResult<StreamEvent, void>> {
  // Always drain pending events first
  if (this.pendingEvents.length > 0) {
    return { done: false, value: this.pendingEvents.shift()! }
  }
  
  // Then handle state machine transitions
  switch (this.state.phase) {
    // ...
  }
}
```

### Tool Execution

Tools are executed in parallel using `all()`, results are buffered, then yielded one-by-one via the pending events mechanism.

### Error Handling

- Non-fatal errors (tool execution fails): Yield `tool_error` event, continue
- Fatal errors (provider fails, etc.): Transition to ERROR state, yield `error` event, then DONE

### Abort Signal

Engine checks abort signal periodically and transitions to error state if aborted.

## Files to Create

| File | Description |
|------|-------------|
| `handler/model-binder.ts` | Reusable request parameter binding utility |
| `handler/durable/types.ts` | Types for durable handler, engine, events |
| `handler/durable/chat-engine.ts` | Pull-based chat engine state machine |
| `handler/durable/handler.ts` | Durable chat handler |
| `handler/durable/index.ts` | Public exports |
| `handler/durable/__tests__/vitest-effection.ts` | Test helper (copy from durable-streams) |
| `handler/durable/__tests__/test-utils.ts` | Mock provider, test helpers |
| `handler/durable/__tests__/handler.test.ts` | Black-box handler tests |

## Implementation Order

### Step 1: Model Binder

Small, reusable utility. No dependencies.

```typescript
// handler/model-binder.ts
export interface BindingSource { headers: Headers; searchParams: URLSearchParams }
export type Binder<T> = (source: BindingSource) => T

export function stringParam(headerName: string, queryName: string): Binder<string | undefined>
export function intParam(headerName: string, queryName: string): Binder<number | undefined>
export function bindModel<T>(binders: T): Binder<{ [K in keyof T]: ReturnType<T[K]> }>
export function createBindingSource(request: Request): BindingSource
```

### Step 2: Types

Define types for the durable handler and engine.

```typescript
// handler/durable/types.ts

export type EnginePhase = 
  | 'init' | 'process_client_outputs' | 'start_iteration'
  | 'streaming_provider' | 'provider_complete'
  | 'executing_tools' | 'tools_complete'
  | 'complete' | 'error' | 'handoff_pending' | 'done'

export interface ChatEngineParams { ... }

export interface DurableStreamEvent {
  lsn: number
  event: StreamEvent
}

export interface DurableChatHandlerConfig {
  initializerHooks: InitializerHook[]
  maxToolIterations?: number
}
```

### Step 3: Chat Engine

The pull-based state machine.

```typescript
// handler/durable/chat-engine.ts

export function* createChatEngine(
  params: ChatEngineParams
): Operation<Stream<StreamEvent, void>>
```

### Step 4: Handler

Ties everything together.

```typescript
// handler/durable/handler.ts

export function createDurableChatHandler(
  config: DurableChatHandlerConfig
): (request: Request) => Promise<Response>
```

### Step 5: Tests

Black-box tests following hello-chat-scenario pattern.

```typescript
// handler/durable/__tests__/handler.test.ts

describe('Durable Chat Handler', () => {
  describe('New Session', () => {
    it('should stream complete response with LSN in each event')
    it('should return session ID in response header')
    it('should handle text streaming')
    it('should handle tool calls and results')
    it('should handle complete event')
  })
  
  describe('Reconnect', () => {
    it('should resume from lastLSN')
    it('should get remaining events after reconnect')
    it('should work when reconnecting to completed session')
    it('should work when reconnecting to still-streaming session')
  })
  
  describe('Multi-client', () => {
    it('should allow two clients to read same session')
  })
  
  describe('Error Handling', () => {
    it('should handle provider errors')
    it('should handle tool execution errors')
    it('should continue after non-fatal tool error')
  })
  
  describe('Handoff', () => {
    it('should emit conversation_state and end on handoff')
  })
})
```

## Test Infrastructure

### Mock Provider

```typescript
function createMockProvider(responses: MockResponse[]): ChatProvider {
  // Returns a provider that yields predefined responses
}

interface MockResponse {
  events: ChatEvent[]  // Events to yield during streaming
  result: ChatResult   // Final result
}
```

### Dependencies

Tests will use:
- `setupInMemoryDurableStreams()` for session registry
- `ProviderContext` for mock provider
- `ToolRegistryContext` for mock tools

## Key Design Decisions

1. **Pull-based throughout**: Natural backpressure, cleaner composition
2. **All events buffered**: Full replay capability on reconnect
3. **LSN in every event**: Client can track position without separate mechanism
4. **Parallel tool execution**: Use `all()`, buffer results, yield one-by-one
5. **Pending events buffer**: Simplifies multi-event state transitions
6. **New handler, not refactor**: Too complex to simultaneously refactor existing handler
7. **Black-box testing**: Test the full request/response flow, not internals

## Integration Points

1. **SessionRegistry**: From durable-streams module, accessed via `useSessionRegistry<string>()`
2. **TokenBuffer**: Stores serialized `StreamEvent` objects as strings
3. **Existing Provider interface**: `ChatProvider.stream()` returns `Stream<ChatEvent, ChatResult>`
4. **Existing Tool interfaces**: `IsomorphicTool`, `ToolRegistry`, etc.

## Notes for Future Sessions

- This document should be passed along on context compaction
- The existing `createChatHandler` in `handler/create-handler.ts` is the reference implementation
- The durable-streams module (`lib/chat/durable-streams/`) provides the buffering infrastructure
- Tests should follow the pattern in `durable-streams/__tests__/hello-chat-scenario.test.ts`
