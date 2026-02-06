# Worker-Based Tool Sessions

## Status: Planning

## Overview

Replace in-process BridgeHost-based tool execution with worker-based execution using Node.js `worker_threads`. This provides process-level isolation and forces serialization boundaries during development, matching production behavior on distributed servers.

## Motivation

1. **Production parity** - Tools in production run on distributed servers with serialization boundaries. Worker isolation ensures the same constraints exist in development.
2. **Isolation** - Each tool runs in a separate V8 isolate, preventing memory leaks and state pollution between executions.
3. **Forcing function** - Catches serialization issues early in development rather than in production.

## Current Architecture

```
PluginSessionManager
  └── ToolSessionRegistry
        └── createToolSession()           ← in-process
              └── useBackgroundTask()
                    └── createBridgeHost()
                          └── tool.impl() runs in same V8 heap
```

## Target Architecture

```
PluginSessionManager
  └── ToolSessionRegistry (configured with worker mode)
        └── createWorkerSession()         ← NEW
              └── createWorkerToolSession()
                    └── WorkerSessionApi (createApi)
                          └── createWorkerPrincipal()
                                └── Node.js worker_threads
                                      └── tool.impl() runs in isolated V8
```

## Implementation Phases

### Phase 1: Extend Vite Plugin for Worker Generation

**Goal:** Auto-generate a worker entry script alongside the tool registry.

**Current output:**
```
src/__generated__/
  └── tool-registry.gen.ts
```

**New output:**
```
src/__generated__/
  ├── tool-registry.gen.ts    (unchanged)
  └── tool-worker.gen.ts      (NEW)
```

**Worker script template:**
```typescript
// src/__generated__/tool-worker.gen.ts (auto-generated)
import { runToolWorker } from '@sweatpants/core/transport/worker'

const toolLoaders: Record<string, () => Promise<{ impl: Function }>> = {
  'calculator': () => import('../tools/calculator').then(m => m.calculator),
  'games_start_ttt_game': () => import('../tools/games/tic-tac-toe').then(m => m.startTttGame),
  // ... etc
}

runToolWorker(async function* (initData, ctx) {
  const { toolName, params } = initData
  
  const loader = toolLoaders[toolName]
  if (!loader) {
    throw new Error(`Unknown tool: ${toolName}`)
  }
  
  const tool = await loader()
  return yield* tool.impl(params, ctx)
})
```

**Files changed:**
- `packages/framework/src/vite/types.ts` - Add `generateWorker` option
- `packages/framework/src/vite/tool-discovery.ts` - Add `generateWorkerContent()` function

**Effort:** 3-4 hours | **Risk:** Low

---

### Phase 2: Registry Configuration for Worker Mode

**Goal:** Add worker config option to `createToolSessionRegistry`.

**API:**
```typescript
export interface ToolSessionRegistryOptions {
  samplingProvider: ToolSessionSamplingProvider
  defaultTimeout?: number
  
  // Worker mode (optional - defaults to in-process)
  worker?: {
    workerUrl: string | URL
    isDev?: boolean  // Cache-bust URL for HMR
  }
}
```

**Implementation:** Branch in `registry.create()` based on presence of `worker` config.

**Files changed:**
- `packages/framework/src/lib/chat/mcp-tools/session/session-registry.ts`

**Effort:** 2-3 hours | **Risk:** Low

---

### Phase 3: createApi-Based Request/Response Pattern (BREAKING CHANGE)

**Goal:** Refactor `createWorkerToolSession` to use `createApi` from Effection's experimental module, with channel-per-request pattern for elicit and sample handling.

**Breaking Change:** Remove `onSampleRequest` and `onElicitRequest` callback parameters. Operations now go through `WorkerSessionApi` with context-based channel access.

**Design Rationale:**
- Aligns with core patterns (`createApi` in `@sweatpants/core/builtins/api.ts`)
- Enables middleware decoration at all levels (request handling, response sending, transport)
- Uses context for state access (consistent with `TransportContext` pattern)
- TDD-driven context granularity

**File Organization:**
```
packages/framework/src/lib/chat/mcp-tools/session/
├── worker-tool-session.ts        (existing - major refactor)
├── worker-session-context.ts     (NEW - Effection contexts)
├── worker-session-api.ts         (NEW - createApi definition)
└── __tests__/
    ├── worker-tool-session.test.ts
    └── fixtures/
        └── worker-tool-session-harness.ts
```

**Files changed:**
- `packages/framework/src/lib/chat/mcp-tools/session/worker-tool-session.ts` - Major refactor
- `packages/framework/src/lib/chat/mcp-tools/session/worker-session-context.ts` - NEW
- `packages/framework/src/lib/chat/mcp-tools/session/worker-session-api.ts` - NEW
- `packages/framework/src/lib/chat/mcp-tools/session/__tests__/fixtures/worker-tool-session-harness.ts` - Update tests
- `packages/framework/src/lib/chat/mcp-tools/session/__tests__/worker-tool-session.test.ts` - Update tests

**Effort:** 5-7 hours | **Risk:** Medium (breaking change, but localized)

---

### Phase 4: Error Handling for Worker Crashes

**Goal:** Surface worker-level errors cleanly to the caller.

**Current state:** `createWorkerToolSession` handles `WorkerResult.error` for tool-level errors.

**Enhancement:** Verify/add handling for catastrophic worker crashes (exit code non-zero, uncaught exceptions).

**Files changed:**
- Verify `@effectionx/worker` behavior
- Potentially `packages/core/src/transport/worker/host.ts`

**Effort:** 2-3 hours | **Risk:** Medium

---

### Phase 5: App Integration

**Goal:** Wire worker sessions into yo-chat app.

**Changes:**
1. `vite.config.ts` - Enable `generateWorker: true`
2. Server bootstrap - Add `worker` config to registry creation
3. Verify build output includes worker script

**Effort:** 2-3 hours | **Risk:** Medium

---

### Phase 6: Testing

**Unit:** Registry branching, session factory, API operations, middleware
**Integration:** Existing plugin session tests with worker config
**E2E:** yo-chat with worker mode, multi-step tic-tac-toe

**Effort:** 4-6 hours | **Risk:** Medium

---

## Total Effort

**19-28 hours**

---

## Phase 3 Deep Dive: createApi-Based Design

### Problem Statement

The current `createWorkerToolSession` accepts callback handlers (`onSampleRequest`, `onElicitRequest`) that must return synchronously within the worker's request-response cycle. However, for cross-HTTP-request elicitation:

1. Tool calls `ctx.elicit()` in worker
2. Worker sends elicit request to host
3. Host emits `elicit_request` event
4. **HTTP request ends** - client renders elicit UI
5. User responds in **new HTTP request**
6. `session.respondToElicit()` called
7. Tool execution resumes

The callback in step 3 cannot return until step 6, which happens in a different HTTP request scope.

### Solution: createApi with Context-Based Channels

Following the patterns established in `@sweatpants/core`:
- `createApi` for decoratable operations (like `SweatpantsApi`)
- Context for state access (like `TransportContext`)
- Channel-per-request pattern (like `createCorrelation`)

### Architecture Overview

```
WorkerToolSession (resource)
├── Sets up contexts (channels, event emitter)
├── Creates worker via createWorkerPrincipal
│     └── requestHandler uses WorkerSessionApi.operations.handle*
└── Returns ToolSession interface
      └── Methods delegate to WorkerSessionApi.operations.respondTo*

WorkerSessionApi (createApi)
├── Request side (worker → host)
│   ├── handleElicitRequest - emits event, creates channel, waits
│   └── handleSampleRequest - emits event, creates channel, waits
└── Response side (host → worker)
    ├── respondToElicit - sends to channel via context
    └── respondToSample - sends to channel via context

Contexts (TDD-driven granularity)
└── WorkerSessionStateContext - channels, event emitter, LSN counter
    (May split into finer-grained contexts based on test needs)
```

### API Definition

```typescript
// worker-session-api.ts

import { createApi } from 'effection/experimental'
import type { Operation } from 'effection'
import { WorkerSessionStateContext } from './worker-session-context.ts'
import type { RawElicitResult, RawSampleResult } from '../mcp-tool-types.ts'
import type { WorkerElicitRequest, WorkerSampleRequest } from '@sweatpants/core/transport/worker'

/**
 * API for worker session operations.
 * 
 * Provides middleware-decoratable operations for both request handling
 * (worker → host) and response sending (host → worker).
 * 
 * @example
 * ```typescript
 * // Direct usage
 * yield* WorkerSessionApi.operations.respondToElicit(elicitId, result)
 * 
 * // With middleware
 * yield* WorkerSessionApi.decorate({
 *   *respondToElicit([elicitId, response], next) {
 *     console.log('Responding to elicit:', elicitId, response.action)
 *     return yield* next(elicitId, response)
 *   },
 *   *handleElicitRequest([request], next) {
 *     console.log('Handling elicit request:', request.key)
 *     return yield* next(request)
 *   },
 * })
 * ```
 */
export const WorkerSessionApi = createApi('worker-session', {
  // ==========================================
  // Request side (worker → host)
  // ==========================================

  /**
   * Handle an elicit request from the worker.
   * Emits event, creates channel, waits for response.
   */
  *handleElicitRequest(request: WorkerElicitRequest): Operation<WorkerElicitResponse> {
    const state = yield* WorkerSessionStateContext.expect()
    const elicitId = request.id
    
    // Emit event (goes to stream, HTTP request may end)
    yield* state.emitEvent({
      type: 'elicit_request',
      lsn: state.nextLsn(),
      elicitId,
      key: request.key,
      message: request.message,
      schema: request.schema,
    })
    
    // Create channel and wait for response
    const channel = createChannel<RawElicitResult<unknown>, void>()
    state.pendingElicitChannels.set(elicitId, channel)
    
    const sub = yield* channel
    const result = yield* sub.next()
    
    state.pendingElicitChannels.delete(elicitId)
    
    if (result.done) {
      return { id: elicitId, type: 'elicit', status: 'cancelled' }
    }
    
    const rawResult = result.value
    return {
      id: elicitId,
      type: 'elicit',
      status: rawResult.action === 'accept' ? 'accepted'
        : rawResult.action === 'decline' ? 'declined'
        : 'cancelled',
      ...(rawResult.action === 'accept' && { content: rawResult.content }),
    }
  },

  /**
   * Handle a sample request from the worker.
   * Emits event, creates channel, waits for response.
   */
  *handleSampleRequest(request: WorkerSampleRequest): Operation<WorkerSampleResponse> {
    const state = yield* WorkerSessionStateContext.expect()
    const sampleId = request.id
    
    // Emit event
    yield* state.emitEvent({
      type: 'sample_request',
      lsn: state.nextLsn(),
      sampleId,
      messages: request.messages,
      // ... other fields
    })
    
    // Create channel and wait for response
    const channel = createChannel<RawSampleResult, void>()
    state.pendingSampleChannels.set(sampleId, channel)
    
    const sub = yield* channel
    const result = yield* sub.next()
    
    state.pendingSampleChannels.delete(sampleId)
    
    if (result.done) {
      return { id: sampleId, type: 'sample', status: 'cancelled' }
    }
    
    const rawResult = result.value
    return {
      id: sampleId,
      type: 'sample',
      status: 'accepted',
      text: rawResult.text,
      ...(rawResult.model && { model: rawResult.model }),
      // ... other fields
    }
  },

  // ==========================================
  // Response side (host → worker via channel)
  // ==========================================

  /**
   * Send a response to a pending elicit request.
   * Unblocks the request handler waiting on the elicit channel.
   */
  *respondToElicit(
    elicitId: string,
    response: RawElicitResult<unknown>
  ): Operation<void> {
    const state = yield* WorkerSessionStateContext.expect()
    const channel = state.pendingElicitChannels.get(elicitId)
    if (channel) {
      yield* channel.send(response)
      yield* channel.close()
      state.pendingElicitChannels.delete(elicitId)
    }
  },

  /**
   * Send a response to a pending sample request.
   * Unblocks the request handler waiting on the sample channel.
   */
  *respondToSample(
    sampleId: string,
    response: RawSampleResult
  ): Operation<void> {
    const state = yield* WorkerSessionStateContext.expect()
    const channel = state.pendingSampleChannels.get(sampleId)
    if (channel) {
      yield* channel.send(response)
      yield* channel.close()
      state.pendingSampleChannels.delete(sampleId)
    }
  },
})

// Export individual operations for direct use
export const {
  handleElicitRequest,
  handleSampleRequest,
  respondToElicit,
  respondToSample,
} = WorkerSessionApi.operations
```

### Context Definition (Initial - TDD-Driven)

```typescript
// worker-session-context.ts

import { createContext, type Channel } from 'effection'
import type { RawElicitResult, RawSampleResult } from '../mcp-tool-types.ts'
import type { ToolSessionEvent } from './types.ts'

/**
 * State for a worker session.
 * 
 * Contains all mutable state needed by WorkerSessionApi operations.
 * Granularity may evolve based on testing needs.
 */
export interface WorkerSessionState {
  /** Pending elicit channels, keyed by elicitId */
  pendingElicitChannels: Map<string, Channel<RawElicitResult<unknown>, void>>
  
  /** Pending sample channels, keyed by sampleId */
  pendingSampleChannels: Map<string, Channel<RawSampleResult, void>>
  
  /** Emit an event to the session's event stream */
  emitEvent(event: ToolSessionEvent): Operation<void>
  
  /** Generate next LSN for event ordering */
  nextLsn(): number
}

/**
 * Context for worker session state.
 * 
 * Used by WorkerSessionApi operations to access channels and emit events.
 */
export const WorkerSessionStateContext = createContext<WorkerSessionState>(
  'worker-session.state'
)
```

### Session Implementation

```typescript
// In worker-tool-session.ts

import { resource, createChannel, spawn } from 'effection'
import { WorkerSessionStateContext } from './worker-session-context.ts'
import { WorkerSessionApi } from './worker-session-api.ts'

export function createWorkerToolSession(
  options: WorkerToolSessionOptions
): Operation<ToolSession> {
  return resource<ToolSession>(function* (provide) {
    // Create state
    const pendingElicitChannels = new Map<string, Channel<RawElicitResult<unknown>, void>>()
    const pendingSampleChannels = new Map<string, Channel<RawSampleResult, void>>()
    const eventChannel = createChannel<ToolSessionEvent, void>()
    let lsnCounter = 0

    const state: WorkerSessionState = {
      pendingElicitChannels,
      pendingSampleChannels,
      *emitEvent(event) {
        yield* eventChannel.send(event)
      },
      nextLsn() {
        return ++lsnCounter
      },
    }

    // Set up context
    yield* WorkerSessionStateContext.set(state)

    // Create worker with request handler using API operations
    const { result: workerResult } = yield* createWorkerPrincipal<unknown>({
      workerUrl: options.workerUrl,
      initData: { sessionId: options.sessionId, toolName: options.toolName, params: options.params },
      requestHandler: function* (request, ctx): Operation<WorkerResponse> {
        if (request.type === 'elicit') {
          return yield* WorkerSessionApi.operations.handleElicitRequest(request)
        }
        if (request.type === 'sample') {
          return yield* WorkerSessionApi.operations.handleSampleRequest(request)
        }
        throw new Error(`Unknown request type: ${request.type}`)
      },
    })

    // ... status tracking, event channel monitoring ...

    const session: ToolSession = {
      id: options.sessionId,
      toolName: options.toolName,

      // Delegate to API operations
      *respondToElicit(elicitId: string, response: RawElicitResult<unknown>): Operation<void> {
        yield* WorkerSessionApi.operations.respondToElicit(elicitId, response)
      },

      *respondToSample(sampleId: string, response: RawSampleResult): Operation<void> {
        yield* WorkerSessionApi.operations.respondToSample(sampleId, response)
      },

      // ... other methods
    }

    try {
      yield* provide(session)
    } finally {
      // Cleanup - close all pending channels
      for (const ch of pendingElicitChannels.values()) {
        yield* ch.close()
      }
      for (const ch of pendingSampleChannels.values()) {
        yield* ch.close()
      }
      pendingElicitChannels.clear()
      pendingSampleChannels.clear()
      yield* eventChannel.close()
    }
  })
}
```

### Middleware Examples

#### Logging Middleware (All Levels)

```typescript
// At server startup or in test setup
yield* WorkerSessionApi.decorate({
  // Request side
  *handleElicitRequest([request], next) {
    const log = yield* useLogger('worker-session')
    log.debug({ elicitId: request.id, key: request.key }, 'handling elicit request')
    const result = yield* next(request)
    log.debug({ elicitId: request.id, status: result.status }, 'elicit request handled')
    return result
  },

  *handleSampleRequest([request], next) {
    const log = yield* useLogger('worker-session')
    log.debug({ sampleId: request.id }, 'handling sample request')
    return yield* next(request)
  },

  // Response side
  *respondToElicit([elicitId, response], next) {
    const log = yield* useLogger('worker-session')
    log.debug({ elicitId, action: response.action }, 'responding to elicit')
    return yield* next(elicitId, response)
  },

  *respondToSample([sampleId, response], next) {
    const log = yield* useLogger('worker-session')
    log.debug({ sampleId, hasText: !!response.text }, 'responding to sample')
    return yield* next(sampleId, response)
  },
})
```

#### Validation Middleware

```typescript
yield* WorkerSessionApi.decorate({
  *respondToElicit([elicitId, response], next) {
    if (response.action === 'accept' && response.content === undefined) {
      throw new Error('Accept response must include content')
    }
    return yield* next(elicitId, response)
  },
})
```

#### Metrics Middleware

```typescript
yield* WorkerSessionApi.decorate({
  *handleElicitRequest([request], next) {
    const start = performance.now()
    try {
      return yield* next(request)
    } finally {
      metrics.recordElicitHandling(request.key, performance.now() - start)
    }
  },
})
```

### TDD Approach

Let tests drive the context granularity. Start with `WorkerSessionStateContext` containing all state. If tests reveal need for finer control (e.g., mocking just channels), split into:
- `PendingElicitChannelsContext`
- `PendingSampleChannelsContext`
- `SessionEventChannelContext`

#### Test Progression

1. **API operations with mock context**
   ```typescript
   it('respondToElicit sends to channel from context')
   it('handleElicitRequest creates channel and waits')
   ```

2. **Middleware decoration**
   ```typescript
   it('middleware can intercept respondToElicit')
   it('middleware can intercept handleElicitRequest')
   it('middleware chain executes in order')
   ```

3. **Channel mechanics**
   ```typescript
   it('handleElicitRequest blocks until respondToElicit called')
   it('handleSampleRequest blocks until respondToSample called')
   ```

4. **Full session flow**
   ```typescript
   it('tool elicit suspends and resumes via API')
   it('tool sample suspends and resumes via API')
   ```

5. **Edge cases**
   ```typescript
   it('cancellation closes channels and returns cancelled')
   it('multiple concurrent requests work independently')
   it('cleanup closes all pending channels')
   ```

### API Change (Breaking)

**Before:**
```typescript
export function createWorkerToolSession(
  options: WorkerToolSessionOptions,
  onSampleRequest: SampleRequestHandler,
  onElicitRequest: ElicitRequestHandler
): Operation<ToolSession>
```

**After:**
```typescript
export function createWorkerToolSession(
  options: WorkerToolSessionOptions
): Operation<ToolSession>
```

Callers now:
1. Subscribe to `session.events()` to receive `elicit_request` and `sample_request` events
2. Call `session.respondToElicit()` or `session.respondToSample()` to respond
3. Can optionally decorate `WorkerSessionApi` for middleware

### Test Harness Updates

```typescript
// Before: Handlers provided directly
const session = yield* createWorkerToolSession(
  { sessionId, toolName, params, workerUrl },
  onSampleRequest,
  onElicitRequest
)

// After: Spawn event handler to respond to requests
const session = yield* createWorkerToolSession({
  sessionId,
  toolName,
  params,
  workerUrl,
})

// Spawn handler to process events and respond
yield* spawn(function* () {
  for (const event of yield* each(session.events())) {
    if (event.type === 'sample_request') {
      yield* sleep(25)
      yield* session.respondToSample(event.sampleId, {
        text: 'Hello, Alice!',
        model: 'test-model',
        stopReason: 'endTurn',
      })
    } else if (event.type === 'elicit_request') {
      yield* sleep(25)
      yield* session.respondToElicit(event.elicitId, {
        action: 'accept',
        content: { confirmed: true },
      })
    }
    yield* each.next()
  }
})
```

---

## Future Enhancements (Not in Scope)

1. **Worker pooling** - Reuse workers across executions
   - Add comment: `// TODO: Worker pooling for performance`
   
2. **Full Vite HMR** - Seamless hot reload
   - Current: Cache-bust URL per execution (good enough for MVP)
   
3. **Distributed workers** - HTTP transport for multi-server
   - Foundation for production distributed execution
   - Channel pattern can evolve to external storage (Redis, Durable Objects)

4. **Context splitting** - Finer-grained contexts if TDD reveals need
   - `PendingElicitChannelsContext`
   - `PendingSampleChannelsContext`
   - `SessionEventChannelContext`

---

## References

- `packages/framework/src/lib/chat/mcp-tools/session/worker-tool-session.ts`
- `packages/framework/src/lib/chat/mcp-tools/session/session-registry.ts`
- `packages/core/src/transport/worker/host.ts`
- `packages/core/src/transport/worker/runner.ts`
- `packages/core/src/transport/correlation.ts` - Channel-per-request pattern
- `packages/core/src/builtins/api.ts` - createApi pattern reference
- `packages/core/src/context/transport.ts` - Context pattern reference
- `packages/framework/src/vite/tool-discovery.ts`
