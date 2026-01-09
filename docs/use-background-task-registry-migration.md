# Session Registry Migration to useBackgroundTask

## Goal

Refactor `createSessionRegistry` to use `useBackgroundTask` for managing the buffer writer task, eliminating:
1. The `writerScope` option from `CreateSessionOptions`
2. The `sleep(0)` hack in the spawn fallback path
3. Manual scope management in `handler.ts`

## Background

The durable chat handler works in tests (39 passing) but hangs in TanStack Start dev server. We've traced the issue to the buffer writer lifecycle. Instead of continuing to debug scope interactions, we're refactoring to use the well-tested `useBackgroundTask` hook.

## Design

### Key Insight

The `BackgroundTaskHandle` should be **internal** to the registry - not exposed on `SessionHandle`. The registry manages writer lifecycle; clients just acquire/release sessions.

### Changes

#### 1. Internal tasks storage (not in SessionEntry)

`SessionEntry` must remain serializable for pluggable stores (Redis, etc). Tasks are stored in a separate internal map:

```typescript
// Inside createSessionRegistry()
const sessionTasks = new Map<string, Map<string, BackgroundTaskHandle<void>>>()

const TASK_KEYS = {
  WRITER: 'writer',
} as const
```

#### 2. `acquire()` uses useBackgroundTask

```typescript
// Get logger factory for context handoff
const loggerFactory = yield* LoggerFactoryContext.get()

const writerTask = yield* useBackgroundTask(writerOperation, {
  name: `writer:${sessionId}`,
  contexts: loggerFactory 
    ? [{ context: LoggerFactoryContext, value: loggerFactory }]
    : [],
})

// Store in internal map
const tasks = new Map<string, BackgroundTaskHandle<void>>()
tasks.set(TASK_KEYS.WRITER, writerTask)
sessionTasks.set(sessionId, tasks)
```

#### 3. `release()` uses task handle for cleanup decision

```typescript
if (newRefCount === 0) {
  const tasks = sessionTasks.get(sessionId)
  const writerTask = tasks?.get(TASK_KEYS.WRITER)
  
  if (writerTask?.isDone()) {
    // Clean up immediately
    yield* cleanup(sessionId)
    sessionTasks.delete(sessionId)
  } else {
    // Fire and forget - wait for writer then cleanup
    yield* fireAndForget(function* () {
      if (writerTask) {
        yield* writerTask.waitForDone()
      }
      // Re-check refCount (client might have reconnected)
      const current = yield* registryStore.get(sessionId)
      if (current?.refCount === 0) {
        yield* cleanup(sessionId)
        sessionTasks.delete(sessionId)
      }
    })
  }
}
```

#### 4. Handler simplification

```typescript
// BEFORE:
const [writerScope, destroyWriter] = createScope()
destroyWriterScope = destroyWriter
session = yield* registry.acquire(sessionId, { source, writerScope })

// cleanup:
if (destroyWriterScope) {
  yield* call(() => destroyWriterScope())
}

// AFTER:
session = yield* registry.acquire(sessionId, { source })

// cleanup:
yield* registry.release(sessionId)
```

## Files to Modify

| File | Changes |
|------|---------|
| `packages/framework/src/lib/chat/durable-streams/types.ts` | Remove `writerScope` from `CreateSessionOptions` |
| `packages/framework/src/lib/chat/durable-streams/session-registry.ts` | Refactor to use `useBackgroundTask`, add internal tasks map |
| `packages/framework/src/handler/durable/handler.ts` | Remove manual scope management |

## Tests That Must Pass

All existing tests should continue to pass. No new tests needed - this is an internal refactor.

### Session Registry Tests
```bash
cd packages/framework && pnpm vitest run src/lib/chat/durable-streams/__tests__/session-registry.test.ts
```

Key scenarios:
- `should create new session on first acquire`
- `should return same session on second acquire with incremented refCount`
- `should cleanup when last release AND session complete`
- `should NOT cleanup if session still streaming after release`
- `should keep LLM writer alive when client disconnects mid-stream`
- `should allow reconnect to resume reading from last LSN`
- `should cleanup after reconnected client finishes reading`
- `should set error status when LLM stream fails`
- Full E2E: connect → read → disconnect → reconnect → finish → cleanup

### Durable Handler Tests
```bash
cd packages/framework && pnpm vitest run src/handler/durable/__tests__/handler.test.ts
```

Key scenarios:
- `should stream a simple text response with session info`
- `should include LSN in correct order`
- `should execute server-side tools and emit results`
- `should emit error event when provider throws`

### useBackgroundTask Tests
```bash
cd packages/framework && pnpm vitest run src/lib/effection/__tests__/use-background-task.test.ts
```

These should already pass and remain unchanged.

### HTTP Smoke Tests
```bash
cd packages/framework && pnpm vitest run src/handler/durable/__tests__/http-smoke.test.ts
```

### Full Framework Test Suite
```bash
cd packages/framework && pnpm vitest run
```

## Manual Testing

After all unit tests pass, test in TanStack Start:

```bash
# Start yo-chat dev server
cd apps/yo-chat && pnpm dev

# Test durable endpoint (should NOT hang anymore)
curl -X POST http://localhost:8000/api/chat-durable \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hi"}],"provider":"ollama"}'

# Test regular endpoint (should still work)
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hi"}],"provider":"ollama"}'
```

## Future Work

### `abort()` method on registry

For the edge case where we need to abort a session from a different request:

```typescript
interface SessionRegistry<T> {
  acquire(...): Operation<SessionHandle<T>>
  release(sessionId: string): Operation<void>
  abort(sessionId: string): Operation<void>  // NEW
}
```

Not exposing `abort()` on `SessionHandle` - it's dangerous and the registry should control lifecycle.

## Progress

- [x] Update `CreateSessionOptions` in types.ts (remove `writerScope`)
- [x] Add task key constants to session-registry.ts
- [x] Add internal `sessionTasks` map to `createSessionRegistry`
- [x] Refactor `acquire()` to use `useBackgroundTask`
- [x] Refactor `release()` to use `fireAndForget` for deferred cleanup
- [x] Update cleanup logic to clean `sessionTasks` map
- [x] Update `handler.ts` to remove manual scope management
- [x] Run session-registry tests (14 passed)
- [x] Run durable handler tests (39 passed)
- [x] Run HTTP smoke tests (included in durable handler tests)
- [x] Run full framework test suite (498 passed)
- [ ] Manual test in TanStack Start dev server

## Manual Testing Results

### Express Server Test: PASSED

Tested with a simple Express server (`apps/yo-chat/test-durable-express.mts`):

```bash
curl -X POST http://localhost:3456/api/chat-durable \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hello in 3 words"}]}'
```

**Result:** Full streaming response with 330 events including session_info, thinking, text, and complete events. All LSNs sequential and correct.

### TanStack Start Vite Dev Server: HANGS

The hang in TanStack Start persists. Root cause analysis:

### Trace Output
```
[streaming-handler] TRACE: starting scope.run for setup
[streaming-handler] TRACE: inside scope.run, setting context
[streaming-handler] TRACE: context set, calling setup()
[durable-hook] Setting up in-memory durable streams...
[durable-hook] Durable streams setup complete
[durable-hook] Provider set: ollama
[handler] TRACE: about to acquire session
[session-registry] TRACE: about to call useBackgroundTask
[session-registry] TRACE: useBackgroundTask returned        <-- useBackgroundTask works!
[handler] TRACE: session acquired
[handler] TRACE: about to create durable event stream
[handler] TRACE: about to subscribe to durable stream
[session-registry] TRACE: writer operation started
[handler] TRACE: subscribed to durable stream
[streaming-handler] TRACE: setup() returned                 <-- Setup function returns!
                                                            <-- scope.run() NEVER completes
```

### Root Cause

The issue is **NOT** in `useBackgroundTask` or the session registry. Our migration works correctly.

The issue is in `createStreamingHandler` architecture:
1. `scope.run()` awaits the setup function AND waits for all resources to be cleaned up
2. Setup creates `resource()` instances (pull streams) that stay alive until scope is destroyed
3. `scope.run()` hangs because resources are still active
4. The Response is never returned because we're still awaiting `scope.run()`

This is a fundamental mismatch between:
- Effection's `scope.run()` semantics (waits for all resources to complete)
- The streaming handler's need to return a Response before resources are cleaned up

### Why Tests Pass

Tests run in a different environment where this interaction doesn't cause a hang. The tests use the same code but:
1. They run the handler directly (not through TanStack Start middleware)
2. Something about how TanStack Start/Vite handles the async handler differs

### Next Steps Options

1. **Refactor `createStreamingHandler`** to use the same pattern as `createChatHandler`:
   - Don't await `scope.run()` for setup
   - Run setup inside the stream's `start()` callback
   - Handle errors differently

2. **Investigate TanStack Start specific behavior**
   - Why does the same code work in tests but not in TanStack Start?
   - Is there something about how TanStack Start awaits the handler?

3. **Alternative architecture**
   - Don't use Effection resources for the pull streams
   - Create plain subscription objects that don't hold scope alive
