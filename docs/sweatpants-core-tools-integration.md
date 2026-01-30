# @sweatpants/core Tools Integration into Framework

## Overview

This document describes the design for integrating `@sweatpants/core` tools into the existing `@sweatpants/framework` chat system. The goal is gradual migration: keep the existing framework working while allowing core tools to be registered and executed alongside isomorphic tools.

## Background

### Two Tool Systems

The Sweatpants monorepo currently has two tool systems:

1. **`@sweatpants/framework` Isomorphic Tools** (production-ready)
   - `createIsomorphicTool()` with server/client handoff
   - Patch-based state management
   - HTTP/NDJSON streaming
   - React hooks (`useChat`, `useChatSession`)

2. **`@sweatpants/core` Tools** (new architecture)
   - `createTool()` with middleware via Effection's `createApi`
   - Protocol layer (`createProtocol`, `createImplementation`, `serveProtocol`)
   - Principal/Operative communication model
   - Transport layer (WebSocket, SSE, in-memory pairs)
   - Core primitives: `elicit()`, `notify()`, `sample()` that route through TransportContext

### Integration Goal

Allow core tools to be registered with the framework's tool registry and executed by the chat engine. Tools can opt into the new model while existing isomorphic tools continue working unchanged.

## Architecture

```
+------------------------------------------------------------------+
|                    Framework Chat Engine                          |
|                                                                   |
|  +--------------------------------------------------------------+ |
|  |                 Unified Tool Registry                        | |
|  |                                                              | |
|  |  Core Tools ------> adaptCoreTool() ---+                     | |
|  |                                        +---> AnyIsomorphicTool |
|  |  Isomorphic Tools ---------------------+                     | |
|  +--------------------------------------------------------------+ |
|                              |                                    |
|                              v                                    |
|  +--------------------------------------------------------------+ |
|  |  Core Tool Execution                                         | |
|  |                                                              | |
|  |  yield* notify()  ----> NotifyBridge ----> Patch Channel     | |
|  |                              |                               | |
|  |                              v                               | |
|  |                   ClientToolProgressPatch                    | |
|  |                              |                               | |
|  |                              v                               | |
|  |                     NDJSON Stream to Client                  | |
|  |                                                              | |
|  |  yield* elicit()  ----> ElicitBridge ----> Elicit Patch      | |
|  |                              |                               | |
|  |                              v                               | |
|  |                     Wait for HTTP Response                   | |
|  |                              |                               | |
|  |                              v                               | |
|  |                     Resume with Result                       | |
|  +--------------------------------------------------------------+ |
+-------------------------------------------------------------------+
```

## Key Design Decisions

### 1. Tool Coexistence

**Decision**: Layer the current isomorphic tool API on top of core. Only alter current API where incompatible.

Both tool types coexist in the same registry. The registry detects core tool factories via `isCoreToolFactory()` and wraps them with `adaptCoreTool()` to produce an `AnyIsomorphicTool` interface.

### 2. Schema Exposure

**Decision**: Add `schemas` property to core tool factories.

Core tools don't currently expose their input/output schemas on the factory. The framework needs these to:
- Generate JSON schemas for LLM tool definitions
- Validate inputs/outputs

Solution: Modify `createTool()` to expose schemas:

```typescript
Object.defineProperty(factory, "schemas", {
  value: {
    input: config.input,
    output: config.output,
    progress: config.progress,
  },
  writable: false,
});
```

### 3. Notify/Progress Bridge

**Decision**: Start with notify bridge to learn the integration pattern, then build elicit bridge.

Core `notify()` calls route through TransportContext. The framework's bridge intercepts these and converts them to `ClientToolProgressPatch` patches that flow to the client via NDJSON streaming.

```
Core Tool                    Framework Bridge              Client
---------                    ----------------              ------

yield* notify({              FrameworkTransport           
  message: "Step 1...",      intercepts TransportRequest  
  progress: 0.25             |                            
})                           v                            
                             ClientToolProgressPatch {    
                               type: 'client_tool_progress',
                               id: callId,                
                               message: "Step 1..."       
                             }                            
                             |                            
                             v                            
                             NDJSON Stream -------------> UI updates
```

### 4. Elicit Bridge

**Decision**: Build after notify bridge is working.

Core `elicit()` calls are more complex - they suspend tool execution, wait for user interaction, and resume with results. The bridge:

1. Intercepts elicit request
2. Emits elicit patch to client
3. Suspends tool execution
4. Waits for HTTP response with elicit result
5. Resumes tool with result

### 5. Middleware Separation

**Decision**: Keep middleware systems separate.

- Core `decorate()` for core tool middleware
- Framework transforms for patches

This avoids coupling the systems and allows each to evolve independently.

## Components

### New Files

| File | Purpose |
|------|---------|
| `packages/framework/src/lib/chat/core-tools/adapter.ts` | `adaptCoreTool()` and `isCoreToolFactory()` |
| `packages/framework/src/lib/chat/core-tools/notify-bridge.ts` | Bridge core `notify()` to patches |
| `packages/framework/src/lib/chat/core-tools/elicit-bridge.ts` | Bridge core `elicit()` to patches (Phase 2) |
| `packages/framework/src/lib/chat/core-tools/framework-transport.ts` | Transport implementation that emits patches |
| `packages/framework/src/lib/chat/core-tools/index.ts` | Barrel export |

### Modified Files

| File | Changes |
|------|---------|
| `packages/core/src/tool/types.ts` | Add `schemas` to factory interfaces |
| `packages/core/src/tool/create.ts` | Expose schemas on factory |
| `packages/framework/src/lib/chat/isomorphic-tools/registry.ts` | Accept core tools, use adapter |

## Type Definitions

### Core Tool Factory Schemas

```typescript
// packages/core/src/tool/types.ts

export interface ToolFactoryWithImpl<
  TInput extends ZodSchema,
  TOutput extends ZodSchema,
> {
  (): Operation<Tool<TInput, TOutput>>;
  decorate(middleware: ToolMiddleware<TInput, TOutput>): Operation<void>;
  withContext<T>(context: Context<T>, value: T): ToolFactoryWithImpl<TInput, TOutput>;
  readonly name: string;
  readonly description: string;
  readonly schemas: {
    readonly input: TInput;
    readonly output: TOutput;
  };
}

export interface ToolFactoryWithoutImpl<
  TInput extends ZodSchema,
  TProgress extends ZodSchema | undefined,
  TOutput extends ZodSchema,
> {
  (impl?: ToolImplFn<TInput, TProgress, TOutput>): Operation<Tool<TInput, TOutput>>;
  decorate(middleware: ToolMiddleware<TInput, TOutput>): Operation<void>;
  withContext<T>(context: Context<T>, value: T): ToolFactoryWithoutImpl<TInput, TProgress, TOutput>;
  readonly name: string;
  readonly description: string;
  readonly schemas: {
    readonly input: TInput;
    readonly output: TOutput;
    readonly progress: TProgress;
  };
}
```

### Core Tool Adapter

```typescript
// packages/framework/src/lib/chat/core-tools/adapter.ts

import type { Operation } from 'effection'
import type { ZodSchema } from 'zod'
import type { AnyIsomorphicTool, ServerToolContext } from '../isomorphic-tools/types.ts'

/**
 * Union type for any core tool factory.
 */
export type CoreToolFactory = {
  (...args: unknown[]): Operation<unknown>;
  decorate: (...args: unknown[]) => Operation<void>;
  withContext: <T>(context: unknown, value: T) => CoreToolFactory;
  readonly name: string;
  readonly description: string;
  readonly schemas: {
    readonly input: ZodSchema;
    readonly output: ZodSchema;
    readonly progress?: ZodSchema;
  };
}

/**
 * Detect if a value is a @sweatpants/core tool factory.
 */
export function isCoreToolFactory(value: unknown): value is CoreToolFactory {
  return (
    typeof value === 'function' &&
    'decorate' in value &&
    'withContext' in value &&
    'schemas' in value &&
    typeof (value as CoreToolFactory).name === 'string' &&
    typeof (value as CoreToolFactory).description === 'string'
  )
}

/**
 * Wrap a @sweatpants/core tool to work with the framework registry.
 * 
 * - Maps `input` schema to `parameters`
 * - Sets up FrameworkTransport so core notify()/elicit() calls work
 * - Produces a server-authority isomorphic tool
 */
export function adaptCoreTool(coreToolFactory: CoreToolFactory): AnyIsomorphicTool {
  return {
    name: coreToolFactory.name,
    description: coreToolFactory.description,
    parameters: coreToolFactory.schemas.input,
    authority: 'server',
    contextMode: 'headless',
    
    *server(params: unknown, ctx: ServerToolContext): Operation<unknown> {
      // Set up FrameworkTransport in context
      // This bridges notify()/elicit() to framework patches
      return yield* withFrameworkTransport(ctx, function*() {
        const tool = yield* coreToolFactory()
        return yield* tool(params)
      })
    },
    
    // Core tools don't have a separate client phase
    client: undefined,
  }
}
```

### Framework Transport

```typescript
// packages/framework/src/lib/chat/core-tools/framework-transport.ts

import type { Operation } from 'effection'
import type { Channel } from 'effection'
import { TransportContext } from '@sweatpants/core'
import type { CorrelatedTransport, TransportRequest } from '@sweatpants/core'
import type { ChatPatch } from '../patches/index.ts'
import type { ServerToolContext } from '../isomorphic-tools/types.ts'

/**
 * Create a transport that bridges core operations to framework patches.
 * 
 * This allows core tools (using notify, elicit, sample) to work
 * within the framework's patch-based streaming system.
 */
export function createFrameworkTransport(
  ctx: ServerToolContext,
  emitPatch: (patch: ChatPatch) => Operation<void>,
): CorrelatedTransport {
  return {
    request<TProgress, TResponse>(request: TransportRequest): Operation<AsyncGenerator<TProgress, TResponse>> {
      return {
        *[Symbol.iterator]() {
          if (request.kind === 'notify') {
            // Convert notify to progress patch
            yield* emitPatch({
              type: 'client_tool_progress',
              id: ctx.callId,
              message: typeof request.payload === 'object' && request.payload !== null && 'message' in request.payload
                ? String((request.payload as { message: unknown }).message)
                : String(request.payload),
            })
            
            // Return immediately with success
            return (async function* () {
              return { ok: true } as TResponse
            })()
          }
          
          if (request.kind === 'elicit') {
            // Elicit requires suspension - will be implemented in Phase 2
            throw new Error('Core tool elicit() not yet supported in framework bridge')
          }
          
          throw new Error(`Unknown request kind: ${request.kind}`)
        }
      }
    }
  }
}

/**
 * Run an operation with FrameworkTransport in context.
 */
export function* withFrameworkTransport<T>(
  ctx: ServerToolContext,
  operation: () => Operation<T>,
): Operation<T> {
  const transport = createFrameworkTransport(ctx, function* (patch) {
    yield* ctx.emitPatch(patch)
  })
  
  return yield* TransportContext.with(transport, operation)
}
```

### Registry Updates

```typescript
// packages/framework/src/lib/chat/isomorphic-tools/registry.ts

import { adaptCoreTool, isCoreToolFactory, type CoreToolFactory } from '../core-tools/adapter.ts'

/**
 * Input types accepted by the registry.
 */
export type ToolInput = AnyIsomorphicTool | CoreToolFactory

/**
 * Create an isomorphic tool registry.
 *
 * Accepts both isomorphic tools and @sweatpants/core tools.
 */
export function createIsomorphicToolRegistry(
  tools: ToolInput[]
): IsomorphicToolRegistry {
  const map = new Map<string, AnyIsomorphicTool>()

  for (const tool of tools) {
    // Normalize core tools to isomorphic interface
    const normalized = isCoreToolFactory(tool)
      ? adaptCoreTool(tool)
      : tool

    if (map.has(normalized.name)) {
      throw new Error(`Duplicate tool name: ${normalized.name}`)
    }
    map.set(normalized.name, normalized)
  }

  // ... rest unchanged
}
```

## Implementation Phases

### Phase 1: Schema Exposure (Core Package)

**Goal**: Expose schemas on core tool factories so the framework can generate LLM tool definitions.

**Files**:
- `packages/core/src/tool/types.ts` - Add `schemas` to factory interfaces
- `packages/core/src/tool/create.ts` - Attach schemas via `Object.defineProperty`

**Changes**:

```typescript
// In createTool() after attaching name and description:

Object.defineProperty(factory, "schemas", {
  value: {
    input: config.input,
    output: config.output,
    progress: config.progress,
  },
  writable: false,
});
```

Same change needed in `createToolWithBindings()`.

**Tests**: Update existing tests to verify schemas are exposed.

### Phase 2: Core Tool Adapter (Framework Package)

**Goal**: Create adapter that wraps core tools as `AnyIsomorphicTool`.

**Files**:
- `packages/framework/src/lib/chat/core-tools/adapter.ts` - `isCoreToolFactory()` and `adaptCoreTool()`
- `packages/framework/src/lib/chat/core-tools/index.ts` - Barrel export

**Tests**: Unit tests for adapter.

### Phase 3: Notify Bridge (Framework Package)

**Goal**: Bridge core `notify()` calls to framework patches.

**Files**:
- `packages/framework/src/lib/chat/core-tools/framework-transport.ts` - Transport that emits patches
- `packages/framework/src/lib/chat/core-tools/notify-bridge.ts` - Helper functions

**Tests**: 
- Unit tests for transport
- Integration test with mock patch channel

### Phase 4: Registry Integration (Framework Package)

**Goal**: Update registry to accept and adapt core tools.

**Files**:
- `packages/framework/src/lib/chat/isomorphic-tools/registry.ts` - Accept `ToolInput` union type

**Tests**: Registry tests with mixed tool types.

### Phase 5: End-to-End Test

**Goal**: Verify core tools work in real chat engine execution.

**Test Scenario**:
1. Define a core tool with `notify()` calls
2. Register it with framework registry
3. Execute via chat engine
4. Verify progress patches are emitted correctly

### Phase 6: Elicit Bridge (Future)

**Goal**: Bridge core `elicit()` calls to framework elicitation.

This is more complex because elicit suspends tool execution. Will be designed after notify bridge is proven.

**Considerations**:
- Session management for suspended tools
- Correlation of elicit requests with HTTP responses
- Timeout handling
- Cancellation

## Testing Strategy

### Unit Tests

| Test File | Coverage |
|-----------|----------|
| `packages/core/src/tool/__tests__/schemas.test.ts` | Schema exposure on factories |
| `packages/framework/src/lib/chat/core-tools/__tests__/adapter.test.ts` | `isCoreToolFactory()`, `adaptCoreTool()` |
| `packages/framework/src/lib/chat/core-tools/__tests__/framework-transport.test.ts` | Transport patch emission |
| `packages/framework/src/lib/chat/isomorphic-tools/__tests__/registry.test.ts` | Mixed tool type registration |

### Integration Tests

| Test File | Coverage |
|-----------|----------|
| `packages/framework/src/lib/chat/__tests__/core-tool-execution.test.ts` | Full tool execution with patches |

### E2E Tests

After Phase 5, add Playwright tests in `apps/yo-chat/e2e/` that:
- Send messages that trigger core tool execution
- Verify progress updates appear in UI
- Verify tool results are displayed

## Example Usage

After implementation, users can register core tools alongside isomorphic tools:

```typescript
import { createTool, notify } from '@sweatpants/core'
import { createIsomorphicToolRegistry } from '@sweatpants/framework/chat/isomorphic-tools'
import { z } from 'zod'

// Define a core tool with progress notifications
const ProcessData = createTool({
  name: 'process_data',
  description: 'Process data with progress updates',
  input: z.object({ dataId: z.string() }),
  output: z.object({ result: z.string() }),
  impl: function* ({ dataId }) {
    yield* notify({ message: 'Loading data...', progress: 0.1 })
    
    // ... do work
    
    yield* notify({ message: 'Processing...', progress: 0.5 })
    
    // ... more work
    
    yield* notify({ message: 'Finalizing...', progress: 0.9 })
    
    return { result: 'done' }
  },
})

// Register alongside isomorphic tools
const registry = createIsomorphicToolRegistry([
  ProcessData,        // Core tool - automatically adapted
  myIsomorphicTool,   // Existing isomorphic tool
])

// Use registry in chat engine as normal
```

## Open Questions

### 1. ServerToolContext Extension

The framework's `ServerToolContext` needs an `emitPatch` method for the transport to use. Options:

a. Add to `ServerToolContext` interface
b. Pass patch channel separately to adapter
c. Use a separate context for patch emission

**Current leaning**: Option (a) - cleanest API.

### 2. Progress Percentage

Core `notify()` supports a `progress` percentage (0-1). The framework's `ClientToolProgressPatch` only has a `message` string. Options:

a. Extend `ClientToolProgressPatch` to include progress percentage
b. Format progress into message string
c. Add new patch type `ClientToolProgressPercentPatch`

**Current leaning**: Option (a) - minimal change, maximum utility.

### 3. Notify Acknowledgment

Core `notify()` waits for acknowledgment from the transport. In the framework, patches are fire-and-forget. Options:

a. Return immediately (no acknowledgment)
b. Add acknowledgment mechanism to patch system
c. Wait for patch to be written to stream

**Current leaning**: Option (a) for v1 - simpler, matches current behavior.

## Progress Tracking

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1: Schema Exposure | Not Started | |
| Phase 2: Core Tool Adapter | Not Started | |
| Phase 3: Notify Bridge | Not Started | |
| Phase 4: Registry Integration | Not Started | |
| Phase 5: End-to-End Test | Not Started | |
| Phase 6: Elicit Bridge | Future | Design after Phase 5 |

## Related Documents

- [Architecture](./architecture.md) - Core architecture vision
- [Protocol Layer Plan](./protocol-layer-plan.md) - Implementation status of core
- [Simplified Agents API](./simplified-agents-api.md) - API design rationale
- [MCP Plugin Bridge Design](./mcp-plugin-bridge-design.md) - Similar integration pattern

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2026-01-28 | Claude | Initial design document |
