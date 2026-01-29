# MCP Tool Runtime Rebuild on @sweatpants/core

## Overview

Rebuild the internal implementation of the MCP tool runtime using `@sweatpants/core` primitives while preserving the external API and MCP++ extensions.

## Key Principles

1. **Bridge INTO core** - Don't replace what works, enhance it with core primitives
2. **Preserve external API** - E2E tests (tic-tac-toe, pick-a-card, book-a-flight) must pass unchanged
3. **Workers are essential** - Session durability requires worker isolation (future: Durable Objects, serverless)
4. **Transport over postMessage** - Workers are a serialization boundary, design for distributed compute

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    UNCHANGED (External API)                              │
│  createMcpTool().parameters().elicits().execute()                       │
│  makePlugin().onElicit().build()                                         │
│  useChat hook, durable stream handler                                    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         WORKER (Principal)                               │
│                                                                          │
│  Tool executes here with McpToolContext:                                 │
│    ctx.elicit(key) → transport.request({ kind: 'elicit', ... })         │
│    ctx.sample()    → transport.request({ kind: 'sample', ... })         │
│    ctx.notify()    → transport.request({ kind: 'notify', ... })         │
│                                                                          │
│  TransportContext.set(correlatedPrincipalTransport)                      │
│  Requests go OUT, responses come BACK                                    │
│                                                                          │
│  Transport: postMessage-based PrincipalTransport                         │
└─────────────────────────────────────────────────────────────────────────┘
                           │ postMessage │
                           │ (serialize) │
                           ▼             ▲
┌─────────────────────────────────────────────────────────────────────────┐
│                          HOST (Operative)                                │
│                                                                          │
│  Receives requests from worker, dispatches to handlers:                  │
│    elicit → forward to UI via session events                            │
│    sample → forward to LLM provider                                     │
│    notify → emit progress/log event                                     │
│                                                                          │
│  When UI/LLM responds, sends response back through transport             │
│                                                                          │
│  Transport: postMessage-based OperativeTransport                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    PRESERVED (Framework Value-Add)                       │
│  Session registry and lifecycle                                          │
│  Exchange construction for conversation history                          │
│  Elicit-context support                                                  │
│  Durable streams handler                                                 │
│  useChat hook                                                            │
└─────────────────────────────────────────────────────────────────────────┘
```

## Transport Flow

### Principal (Worker) Side
```
Tool code:
  yield* ctx.elicit('pickFlight', { flights: [...] })
  
McpToolContext.elicit():
  const transport = yield* TransportContext.expect()
  const stream = transport.request({
    id: generateId(),
    kind: 'elicit',
    type: 'pickFlight',
    payload: { context: { flights: [...] } }
  })
  const subscription = yield* stream
  const result = yield* subscription.next()
  return result.value  // { action: 'accept', content: {...} }
```

### Operative (Host) Side
```
Host receives TransportRequest via postMessage:
  { id: 'req_123', kind: 'elicit', type: 'pickFlight', payload: {...} }

Host handler:
  - Emits session event: { type: 'elicit_request', id: 'req_123', key: 'pickFlight', ... }
  - UI renders elicit component
  - User responds
  - Host sends response via postMessage:
    { type: 'response', id: 'req_123', response: { action: 'accept', content: {...} } }
```

## Implementation Phases

### Phase 1: PostMessage Transport Adapters ✅ COMPLETE
Create adapters that implement core's Transport interface over postMessage.

**Files**:
- `packages/framework/src/lib/chat/mcp-tools/session/postmessage-transport.ts`

**Implemented**:
- `bridgeToTransport()` - Converts `SessionWorkerTransport` to core's `Transport` interface
- `mapElicitActionToStatus()` / `mapStatusToElicitAction()` - Status conversion helpers
- Tests: `__tests__/postmessage-transport.test.ts`

### Phase 2: Core-Based McpToolContext ✅ COMPLETE
Reimplement McpToolContext to use core builtins via TransportContext.

**Files**:
- `packages/framework/src/lib/chat/mcp-tools/session/core-context.ts`

**Implemented**:
- `createContextFromTransport()` - Creates `McpToolContext` backed by `CorrelatedTransport`
- `createContextWithElicitsFromTransport()` - Creates keyed elicitation context
- `createCoreContext()` / `createCoreContextWithElicits()` - Convenience wrappers
- Full support for: `sample()`, `sampleTools()`, `sampleSchema()`, `elicit()`, `branch()`, `log()`, `notify()`
- Exchange construction in MCP format
- Tests: `__tests__/core-context.test.ts` (15 tests)

### Phase 3: Worker Runner Adaptation ⚠️ PARTIAL
Update worker runner to:
- Set up TransportContext with postMessage transport
- Run tool with core-based context

**Files**:
- `packages/framework/src/lib/chat/mcp-tools/session/worker-runner-core.ts` (new file, experimental)

**Status**:
- Simple tools (no sample/elicit) work correctly
- Sample/elicit backchannel has issues due to transport bridging complexity
- Recommendation: Continue using original `worker-runner.ts` for production
- Tests: `__tests__/core-integration.test.ts` (6 passing, 5 todo for known limitations)

### Phase 4: Host Handler Adaptation ✅ COMPLETE
Update tool session to:
- Set up operative transport
- Handle requests from worker
- Forward to UI/LLM and send responses back

**Files**:
- `packages/framework/src/lib/chat/mcp-tools/session/tool-session-core.ts` (new file)

**Implemented**:
- `createCoreToolSession()` - Host-side session that receives worker messages as events
- Full support for: sample_request, elicit_request, log, progress, result, error, cancelled
- `respondToSample()` / `respondToElicit()` to send responses back to worker
- Tests: `__tests__/tool-session-core.test.ts` (18 tests)

### Phase 5: E2E Validation 🔜 PENDING
Run existing E2E tests to validate the rewrite:
- `apps/yo-chat/e2e/tictactoe.spec.ts`
- Other MCP tool E2E tests

**Note**: E2E validation blocked on Phase 3 worker-runner-core sample/elicit issues.
The existing `runWorker()` + `createWorkerToolSession()` continues to work for production.

## What's Removed

- `ctx.branch()` - Core has better story with direct agent calling
- Custom channel/signal patterns in bridge-runtime.ts - Replaced by core transport
- Buffered channels for event streaming - Replaced by transport streams

## What's Preserved

- `createMcpTool()` builder API
- `makePlugin()` pattern  
- `.elicits({})` finite UI surface
- `.handoff()` pattern (before/client/after)
- Exchange construction for conversation history
- Elicit-context support
- Session registry and lifecycle
- Worker isolation for durability
- Durable streams handler
- useChat hook

## Success Criteria

1. All existing E2E tests pass without modification
2. External API unchanged
3. Workers still provide session durability
4. Exchanges correctly constructed for history
5. Internal implementation uses core primitives

## Future Considerations

- Workers could run on Durable Objects (Cloudflare)
- Workers could run on serverless lambdas
- Transport abstraction enables distributed compute
- Core protocol enables cross-process tool execution

## Current Status Summary (Updated: Jan 2026)

### What's Complete
| Component | File | Tests | Status |
|-----------|------|-------|--------|
| PostMessage Transport | `postmessage-transport.ts` | 3 tests | ✅ Production ready |
| Core Context | `core-context.ts` | 15 tests | ✅ Production ready |
| Core Tool Session | `tool-session-core.ts` | 18 tests | ✅ Production ready |
| Signal Correlated Transport | `signal-correlated-transport.ts` | 14 tests | ✅ Production ready |
| Core Worker Runner | `worker-runner-core.ts` | 11 tests | ✅ Production ready |

### Test Coverage
- **Total new tests added**: 61 tests (core-context: 15, tool-session-core: 18, signal-correlated-transport: 14, core-integration: 11, postmessage-transport: 3)
- **All framework tests**: 801 passing, 7 todo

### Architecture Decision: Signal-Based CorrelatedTransport

See [ADR: Signal-Based Transport](./adr-signal-based-transport.md) for full details.

**Summary**: Core's `createCorrelation` assumes a live, bidirectional connection (WebSocket, SSE).
Our worker scenario uses callback-based message passing where responses can take arbitrarily long.
The signal-based pattern from `worker-runner.ts` handles this correctly.

**Decision**: Implement `CorrelatedTransport` interface using Effection signals instead of 
bridging to core's `createCorrelation`. This gives us:
- Standard interface (tools work unchanged)
- Proven signal pattern (no timing issues)
- Direct message mapping (no double-bridging)
- Future flexibility (can add `createApi` middleware later)

```
WorkerTransport ──► SignalCorrelatedTransport ──► CorrelatedTransport interface
                         │
                         ├─ pendingRequests Map<id, Signal>
                         ├─ request() creates signal, sends mapped message
                         └─ subscribe() routes responses to signals
```

### Completed Steps
1. ✅ Create architecture decision doc (`adr-signal-based-transport.md`)
2. ✅ Fix `signal-correlated-transport.ts` to use `message.id` from requests
3. ✅ Update `worker-runner-core.ts` to use `createSignalCorrelatedTransport`
4. ✅ Write tests for signal-correlated-transport (14 tests)
5. ✅ Run integration tests - sample/elicit now works (11 tests)
6. ✅ Export from session/index.ts

### Remaining Steps
7. ⏳ Run E2E tests
8. ⏳ Migrate production code to use core-based implementations
