# ADR: Signal-Based CorrelatedTransport for Worker Communication

## Status

**Accepted** - January 2026

## Context

We're rebuilding the MCP tool runtime to use `@sweatpants/core` primitives. The goal is to have
tools use core's `CorrelatedTransport` interface for request/response communication, enabling
future portability to Durable Objects, serverless, etc.

### The Problem

Core's `createCorrelation()` function wraps a `PrincipalTransport` to provide request/response
correlation. It works by:

1. Spawning a background task that continuously consumes the transport stream
2. Routing incoming `progress` and `response` messages to pending channels by ID
3. Each `request()` call creates a channel and returns it as a stream

```typescript
// Core's createCorrelation pattern
yield* spawn(function* () {
  const subscription = yield* transport;  // Transport is a Stream
  let result = yield* subscription.next();
  while (!result.done) {
    // Route messages to pending channels...
    result = yield* subscription.next();
  }
});
```

This works well for **live, bidirectional connections** (WebSocket, SSE) where:
- The connection stays open
- Messages flow continuously
- The background consumer can route them in real-time

### Our Scenario is Different

The MCP tool worker uses **message-passing over postMessage**:

1. **Callback-based API**: `transport.subscribe(callback)` not an Effection `Stream`
2. **Different message format**: `sample_response`, `elicit_response` vs core's `response`
3. **Stateless operatives**: Requests can take minutes, hours, or days (user closes tab, returns later)
4. **No persistent connection**: Workers are isolated, communicate via serialized messages

### Initial Approach: Double-Bridging

Our first attempt (`worker-runner-core.ts`) tried to:

1. Convert `WorkerTransport` to a wrapped transport with message mapping
2. Bridge that to core's `PrincipalTransport` via `bridgeToTransport()`
3. Apply `createCorrelation()` on top

```
WorkerTransport → wrappedTransport → bridgeToTransport() → PrincipalTransport → createCorrelation()
```

**This failed** for sample/elicit flows due to timing and lifecycle issues:
- The background consumer needed precise timing
- Channel registration had to happen before responses arrived
- The double-bridging introduced subtle race conditions

### What Already Works

The original `worker-runner.ts` uses a **signal-based pattern** that works correctly:

```typescript
// Create signal for response
const responseSignal = createSignal<RawSampleResult, void>()
sampleSignals.set(sampleId, responseSignal)

// Send request
transport.send({ type: 'sample_request', sampleId, ... })

// Wait for response (blocks until signal.send() is called)
const subscription = yield* responseSignal
const result = yield* subscription.next()

// --- In the message handler ---
transport.subscribe((msg) => {
  if (msg.type === 'sample_response') {
    const signal = sampleSignals.get(msg.sampleId)
    signal.send(msg.response)
  }
})
```

This pattern:
- Has no background consumer
- No channel lifecycle issues  
- No timing problems
- Signals just wait until `send()` is called

## Decision

**Implement a signal-based `CorrelatedTransport`** that:

1. Implements core's `CorrelatedTransport` interface (tools work unchanged)
2. Uses Effection signals internally for request/response correlation
3. Maps directly between worker messages and core transport messages
4. No double-bridging through `bridgeToTransport` or `createCorrelation`

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Worker (runs tool)                                    │
│                                                                              │
│  Tool code:                                                                  │
│    yield* ctx.sample(messages)                                               │
│    yield* ctx.elicit('confirm', {...})                                       │
│                                                                              │
│  McpToolContext (core-context.ts):                                           │
│    Uses transport.request() from TransportContext                            │
│                                                                              │
│  SignalCorrelatedTransport:                                                  │
│    ┌──────────────────────────────────────────────────────────────────────┐ │
│    │ request(message: TransportRequest) → Stream<Progress, Response>      │ │
│    │                                                                      │ │
│    │   1. Create signal for message.id                                    │ │
│    │   2. Store in pendingRequests Map                                    │ │
│    │   3. Map to worker format, send via transport                        │ │
│    │   4. Return Stream that yields from signal                           │ │
│    └──────────────────────────────────────────────────────────────────────┘ │
│                           │                          ▲                       │
│                           │ send()                   │ subscribe()           │
│                           ▼                          │                       │
│    ┌──────────────────────────────────────────────────────────────────────┐ │
│    │                    WorkerTransport (postMessage)                     │ │
│    └──────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │ postMessage
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Host (manages session)                             │
│                                                                              │
│  Receives: sample_request, elicit_request, log, progress                     │
│  Sends: sample_response, elicit_response                                     │
│                                                                              │
│  ToolSession emits events, UI responds, session sends response back          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Message Flow Example

```
1. Tool calls: yield* ctx.sample([{role: 'user', content: 'Hello'}])

2. McpToolContext.sample():
   - Calls transport.request({ id: 'req_1', kind: 'elicit', type: 'sample', payload: {...} })

3. SignalCorrelatedTransport.request():
   - Creates signal, stores in pendingRequests['req_1']
   - Sends: { type: 'sample_request', sampleId: 'req_1', messages: [...] }
   - Returns Stream backed by signal

4. Host receives sample_request:
   - Forwards to LLM provider
   - Gets response
   - Sends: { type: 'sample_response', sampleId: 'req_1', response: {...} }

5. SignalCorrelatedTransport receives sample_response:
   - Looks up signal for 'req_1'
   - Calls signal.send({ status: 'accepted', content: response })
   - Signal resumes the waiting generator

6. Tool receives SampleResult, continues execution
```

## Alternatives Considered

### Alternative 1: Use `decorate` Pattern from Inspector

We considered using effection's `decorate` pattern (as seen in `effectionx/inspector`) to
implement transport middleware:

```typescript
scope.decorate(TransportApi, {
  *request([message], next) {
    // Transform message format
    // Use signals for correlation
    // Call next() or handle directly
  }
})
```

**Rejected because:**
- Would still need to convert callback-based `subscribe()` to a Stream first
- Adds complexity without clear benefit for this use case
- The decoration pattern is better suited for intercepting existing APIs, not implementing new transports

### Alternative 2: Fix the Double-Bridging Timing Issues

We considered debugging and fixing the timing issues in the original `worker-runner-core.ts`.

**Rejected because:**
- Root cause is architectural mismatch, not a bug
- Core's `createCorrelation` assumes continuous stream consumption
- Fixing would require significant changes to core or complex workarounds
- The signal pattern is simpler and proven to work

### Alternative 3: Modify Core to Support Callback-Based Transports

We considered adding a new correlation mode to core that works with callbacks.

**Rejected because:**
- Increases core complexity for a specific use case
- Core's current design is correct for its primary use cases (WebSocket, SSE)
- Better to adapt at the framework layer

## Consequences

### Positive

1. **Interface conformance**: Tools use standard `CorrelatedTransport` interface
2. **Proven pattern**: Reuses signal approach from working `worker-runner.ts`
3. **Simple implementation**: ~100 lines of code, easy to understand
4. **Future flexibility**: Can wrap with `createApi` for middleware if needed
5. **No core changes**: Works with existing `@sweatpants/core`

### Negative

1. **Framework-specific implementation**: Not using core's `createCorrelation`
2. **Parallel code paths**: `signal-correlated-transport.ts` vs core's `correlation.ts`
3. **Testing burden**: Need to test signal transport separately

### Neutral

1. **Future migration path**: If we move to Durable Objects with WebSocket, could switch to core's `createCorrelation`
2. **Middleware story**: Can add `createApi` layer later if we need logging, retry, tracing

## Implementation

### Files

- `packages/framework/src/lib/chat/mcp-tools/session/signal-correlated-transport.ts` - Signal-based CorrelatedTransport
- `packages/framework/src/lib/chat/mcp-tools/session/worker-runner-core.ts` - Updated to use signal transport

### Key Code

```typescript
// signal-correlated-transport.ts
export function* createSignalCorrelatedTransport(
  transport: WorkerTransport,
  sessionId: string
): Operation<CorrelatedTransport> {
  const pendingRequests = new Map<string, Signal<ElicitResponse | NotifyResponse, void>>()

  // Subscribe to incoming messages and route to signals
  const unsubscribe = transport.subscribe((msg) => {
    if (msg.type === 'sample_response') {
      const signal = pendingRequests.get(msg.sampleId)
      if (signal) {
        signal.send({ status: 'accepted', content: msg.response })
        pendingRequests.delete(msg.sampleId)
      }
    }
    // ... handle elicit_response similarly
  })

  const correlatedTransport: CorrelatedTransport = {
    request(message: TransportRequest): Stream<TProgress, TResponse> {
      return resource(function* (provide) {
        const signal = createSignal<TResponse, void>()
        pendingRequests.set(message.id, signal)
        
        // Map and send via worker transport
        sendWorkerMessage(transport, message)
        
        // Provide subscription backed by signal
        yield* provide(yield* signal)
      })
    }
  }

  return yield* resource(function* (provide) {
    try {
      yield* provide(correlatedTransport)
    } finally {
      unsubscribe()
    }
  })
}
```

```typescript
// worker-runner-core.ts (updated)
async function executeToolWithCore(...) {
  await run(function* () {
    // Direct: WorkerTransport → SignalCorrelatedTransport
    const correlatedTransport = yield* createSignalCorrelatedTransport(transport, sessionId)
    yield* TransportContext.set(correlatedTransport)
    
    // Create context and execute tool...
  })
}
```

## References

- `packages/core/src/transport/correlation.ts` - Core's createCorrelation
- `packages/framework/src/lib/chat/mcp-tools/session/worker-runner.ts` - Original signal pattern
- `.btca/effectionx/inspector/` - Effection's decorate/createApi patterns
- `docs/mcp-core-rebuild-plan.md` - Overall rebuild plan
