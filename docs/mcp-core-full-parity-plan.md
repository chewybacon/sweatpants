# MCP Core Full Parity Implementation Plan

## Overview

This document tracks the implementation of full MCP feature parity in the core-based worker runtime. The goal is to enable `runWorkerCore` + `createCoreToolSession` to support all MCP sampling and elicitation features, then switch the framework to use it.

**Status:** Implementation Complete, E2E Validation Pending  
**Started:** January 2026  
**Implementation Completed:** January 2026

---

## Background

### What We Have

The signal-based `CorrelatedTransport` implementation is complete and working:
- `signal-correlated-transport.ts` - Implements `CorrelatedTransport` using Effection signals
- `worker-runner-core.ts` - Worker runner using signal transport
- `tool-session-core.ts` - Host-side session adapter
- All basic sample/elicit flows tested and passing (11 integration tests)

See `docs/adr-signal-based-transport.md` for architecture details.

### What's Missing

The current implementation has a **limited sample interface**:

```typescript
// Current WorkerToolContext.sample()
sample(
  messages: Message[],
  options?: { systemPrompt?: string; maxTokens?: number }
): Operation<RawSampleResult>
```

The full MCP runtime supports:

| Feature | Current Worker | Full MCP Runtime |
|---------|----------------|------------------|
| `prompt: string` | No | Yes |
| `messages: Message[]` | Yes (simple) | Yes |
| `messages: ExtendedMessage[]` (McpMessage) | No | Yes |
| `systemPrompt` | Yes | Yes |
| `maxTokens` | Yes | Yes |
| `modelPreferences` | No | Yes |
| `schema: z.ZodType` | No | Yes |
| `tools: SamplingToolDefinition[]` | No | Yes |
| `toolChoice` | No | Yes |
| `sampleTools()` helper | No | Yes |
| `sampleSchema()` helper | No | Yes |
| Result: `parsed`, `parseError` | No | Yes |
| Result: `toolCalls` | No | Yes |
| Result: `exchange` | Yes (basic) | Yes (full) |

### E2E Test Requirements

| Tool | Test File | Needs |
|------|-----------|-------|
| `tictactoe` | `tictactoe.spec.ts` | `messages[]` sampling |
| `book_flight` | `book-flight.spec.ts` | `prompt` + `maxTokens`, multi-elicit |
| `play_ttt` | `play-ttt.spec.ts` | `sampleTools()`, `sampleSchema()`, retries |
| `pick_card` | `pick-card.spec.ts` | Uses `ctx.render()` (different pattern) |

---

## Implementation Plan

### Phase 1: Extend Sample Types and Interfaces

**Goal:** Define the full sample config and result types for workers

#### 1.1 Update `worker-types.ts`

- [ ] Add `WorkerSampleConfig` type supporting all options
- [ ] Add `ExtendedMessage` support (McpMessage with content blocks)
- [ ] Update `WorkerToolContext.sample()` signature
- [ ] Add `sampleTools()` and `sampleSchema()` to interface
- [ ] Update `SampleRequestMessage` to include all fields (already has most)

**Types to add:**
```typescript
interface WorkerSampleConfig {
  // Message input (one required)
  prompt?: string
  messages?: ExtendedMessage[]
  
  // Options
  systemPrompt?: string
  maxTokens?: number
  modelPreferences?: ModelPreferences
  
  // Structured output (mutually exclusive with tools)
  schema?: z.ZodType<unknown>
  
  // Tool calling (mutually exclusive with schema)
  tools?: SamplingToolDefinition[]
  toolChoice?: SamplingToolChoice
}
```

### Phase 2: Update Worker Runner Core

**Goal:** Implement full sample support in the worker context

#### 2.1 Update `worker-runner-core.ts`

- [ ] Rewrite `createWorkerContextFromTransport()` sample implementation
- [ ] Handle `prompt` → `messages` conversion
- [ ] Serialize Zod schemas to JSON schema
- [ ] Build correct result type based on response (`parsed`, `toolCalls`)
- [ ] Build proper exchange for all result types
- [ ] Implement `sampleTools()` helper with retry logic
- [ ] Implement `sampleSchema()` helper with retry logic
- [ ] Add `SampleValidationError` for retry failures

**Key implementation details:**

1. **Prompt to messages conversion:**
   ```typescript
   const messages = config.messages ?? [{ role: 'user', content: config.prompt! }]
   ```

2. **Schema serialization:**
   ```typescript
   const jsonSchema = config.schema ? z.toJSONSchema(config.schema) : undefined
   ```

3. **Result parsing (done by host, returned in response):**
   - Host receives `sample_request` with `schema`
   - Host sends to LLM and parses response
   - Host returns `RawSampleResultWithParsed` with `parsed` and `parseError`

4. **Exchange building:**
   - Plain sample: 2-message exchange (user prompt, assistant response)
   - Schema sample: 3-message exchange (includes parsed output)
   - Tool sample: exchange includes tool_use content blocks

### Phase 3: Update Signal Transport

**Goal:** Ensure transport handles all sample config fields

#### 3.1 Update `signal-correlated-transport.ts`

- [ ] Verify `sendRequest()` maps all sample config fields
- [ ] Handle `ExtendedMessage` in messages array
- [ ] Handle extended response types (`parsed`, `parseError`, `toolCalls`)

**Current `sendRequest` already handles most fields - need to verify completeness.**

### Phase 4: Update Tool Adapter

**Goal:** Pass through full MCP context to worker context

#### 4.1 Update `create-worker-session.ts`

- [ ] Update `adaptToolForWorker()` to pass through full sample config
- [ ] Add `sampleTools()` and `sampleSchema()` to adapted context
- [ ] Remove branch context (will be redesigned with core)

**Before:**
```typescript
*sample(config: { prompt: string; maxTokens?: number }) {
  const messages = [{ role: 'user', content: config.prompt }]
  return yield* ctx.sample(messages, { maxTokens: config.maxTokens })
}
```

**After:**
```typescript
*sample(config: McpToolSampleConfig) {
  return yield* ctx.sample(config)
}

*sampleTools(config: SampleToolsConfig) {
  return yield* ctx.sampleTools(config)
}

*sampleSchema<T>(config: SampleSchemaConfig<T>) {
  return yield* ctx.sampleSchema(config)
}
```

### Phase 5: Switch Framework to Core Runtime

**Goal:** Replace old runtime with core-based runtime

#### 5.1 Update `create-worker-session.ts` imports

- [ ] Change imports from `worker-runner.ts` to `worker-runner-core.ts`
- [ ] Change imports from `worker-tool-session.ts` to `tool-session-core.ts`
- [ ] Update `runWorker()` to `runWorkerCore()`
- [ ] Send `start` message manually before creating session
- [ ] Update `createWorkerToolSession()` to `createCoreToolSession()`

### Phase 6: Tests and Validation

#### 6.1 Unit Tests

- [ ] Add tests for full sample config in `signal-correlated-transport.test.ts`
- [ ] Add tests for `sampleTools()` and `sampleSchema()` in `core-integration.test.ts`
- [ ] Add tests for retry logic
- [ ] Add tests for `ExtendedMessage` handling
- [ ] Ensure all existing tests still pass

#### 6.2 E2E Tests

- [ ] Run `tictactoe.spec.ts` - verify `messages[]` sampling works
- [ ] Run `book-flight.spec.ts` - verify `prompt` + elicit flow works
- [ ] Run `play-ttt.spec.ts` - verify `sampleTools()` and `sampleSchema()` work
- [ ] Run full E2E suite

---

## Progress Tracking

### Completed

- [x] Architecture decision doc (`adr-signal-based-transport.md`)
- [x] Signal-based `CorrelatedTransport` implementation
- [x] Basic worker runner with signal transport
- [x] Core tool session adapter
- [x] Basic sample/elicit integration tests (11 passing)
- [x] Full framework tests passing (801 tests)

### In Progress

- [ ] Phase 6: Tests and E2E validation

### Phase Completion Status

- [x] **Phase 1: Extend sample types and interfaces**
  - Added `WorkerSampleConfig` union type with all variants
  - Added `WorkerSampleToolsConfig`, `WorkerSampleSchemaConfig` for helpers
  - Updated `WorkerToolContext.sample()` with overloads for all config types
  - Added `sampleTools()` and `sampleSchema()` to interface
  - Updated `SampleRequestMessage` to support `ExtendedMessage`
  - Added `modelPreferences` to message protocol
  - Re-exported all needed types from `mcp-tool-types.ts`

- [x] **Phase 2: Update worker runner core**
  - Rewrote `createWorkerContextFromTransport()` with full sample support
  - Implemented `sampleImpl()` handling prompt/messages, schema, and tools
  - Implemented `sampleToolsImpl()` helper with retry logic
  - Implemented `sampleSchemaImpl()` helper with retry logic
  - Added proper exchange building for all result types
  - Uses `createRawSampleExchange()` and `createStructuredSampleExchange()`
  - All 11 integration tests pass

- [x] **Phase 3: Update signal transport**
  - Updated `sendRequest()` to handle `modelPreferences`
  - Updated types to use `ExtendedMessage` instead of `Message`
  - All 14 signal transport tests pass

- [x] **Phase 4: Update tool adapter**
  - Updated `adaptToolForWorker()` to pass through full sample config
  - Added `sampleTools()` and `sampleSchema()` to adapted context
  - Now passes all config through to worker context

- [x] **Phase 5: Switch framework to core runtime**
  - Changed imports to use `runWorkerCore` and `createCoreToolSession`
  - Added manual `start` message sending
  - All 801 framework tests pass

### Pending (requires external setup)
- [ ] Phase 6: E2E validation with yo-chat tests
  - Requires: `pnpm dev` running in yo-chat
  - Requires: Ollama or LLM provider configured
  - Run: `cd apps/yo-chat && pnpm test:e2e`
  - Key tests: `tictactoe.spec.ts`, `book-flight.spec.ts`, `play-ttt.spec.ts`

---

## Design Decisions

### 1. Schema Parsing Location

**Decision:** Host parses, worker receives `parsed`/`parseError` in response

**Rationale:** This matches the current MCP runtime architecture where the bridge-runtime (host) handles parsing. The host has access to the full schema and can return structured results.

### 2. Retry Logic Location

**Decision:** Worker implements retry logic in `sampleTools()`/`sampleSchema()` helpers

**Rationale:** Retry logic involves modifying prompts and making multiple requests. This is easier to implement in the worker where the context exists.

### 3. Branch Context

**Decision:** Removed/not implemented in worker runtime

**Rationale:** Branch context will be redesigned with core in mind. The current implementation adds complexity without clear benefit for the worker pattern.

### 4. Message Types

**Decision:** Full `ExtendedMessage` support including `McpMessage` with content blocks

**Rationale:** Tools like `play_ttt` use tool call messages in conversation history. Full support is needed for feature parity.

---

## Files Modified

| File | Phase | Status |
|------|-------|--------|
| `worker-types.ts` | 1 | Complete |
| `worker-runner-core.ts` | 2 | Complete |
| `signal-correlated-transport.ts` | 3 | Complete |
| `create-worker-session.ts` | 4, 5 | Complete |
| `signal-correlated-transport.test.ts` | 6 | Existing tests pass |
| `core-integration.test.ts` | 6 | Existing tests pass |

---

## References

- `docs/adr-signal-based-transport.md` - Signal transport architecture
- `docs/mcp-core-rebuild-plan.md` - Original rebuild plan
- `packages/framework/src/lib/chat/mcp-tools/mcp-tool-types.ts` - Full MCP types
- `packages/framework/src/lib/chat/mcp-tools/session/core-context.ts` - Reference implementation
