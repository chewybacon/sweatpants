# Sampling Tools & Structured Output - Progress

## Status: ✅ COMPLETE

## Overview

Adding `tools`, `toolChoice`, and `schema` support to `ctx.sample()` for structured output and tool calling within MCP tools.

See [sampling-tools-design.md](./sampling-tools-design.md) for full design.

---

## Phases

### Phase 1: Types & Core - COMPLETE
- [x] Add `zod-to-json-schema` dependency
- [x] `mcp-tool-types.ts` - Add types with overloads
- [x] `protocol/types.ts` - MCP types complete (McpToolDefinition, McpToolChoice, etc.)

### Phase 2: Encoder/Decoder - COMPLETE
- [x] `protocol/message-encoder.ts` - Encode tools/schema in requests
- [x] `protocol/message-decoder.ts` - Decode tool calls from content, extract tool_use blocks

### Phase 3: Runtime Flow - COMPLETE
- [x] `session/types.ts` - Added tools/toolChoice/schema to SampleRequestEvent
- [x] `bridge-runtime.ts` - Full implementation with Zod to JSON Schema conversion
- [x] `branch-runtime.ts` - Full implementation with Zod to JSON Schema conversion
- [x] `handler/durable/plugin-session-manager.ts` - Complete handler for sample_request with tool/schema support

### Phase 4: Provider Integration - COMPLETE
- [x] Provider layer - Tools passed as isomorphicToolSchemas with server authority
- [x] Schema passed in streamOptions for structured output
- [x] Response parsing for JSON structured output

### Phase 5: Testing & Validation - COMPLETE
- [x] Unit tests (`sampling-structured.test.ts`)
  - [x] Schema parsing and error handling
  - [x] Tool calling and multi-turn messages
  - [x] Retry loop pattern
- [x] `play_ttt` agentic tool
  - [x] 2-level decision tree (tools -> schema)
  - [x] Full game loop with elicit for user moves
  - [x] Before/after handoff for X/O assignment
- [x] Playwright E2E (`play-ttt.spec.ts`)
  - [x] Complete game to conclusion
  - [x] User cancellation handling
  - [x] 8 tests all passing

---

## Files Modified (Phases 1-4)

| File | Status | Notes |
|------|--------|-------|
| `package.json` | Done | Added zod-to-json-schema |
| `mcp-tool-types.ts` | Done | Types + overloads for sample() |
| `bridge-runtime.ts` | Done | Full implementation with Zod conversion |
| `branch-runtime.ts` | Done | Full implementation with Zod conversion |
| `protocol/types.ts` | Done | McpToolDefinition, McpToolChoice, McpToolUseContent |
| `protocol/message-encoder.ts` | Done | Encode tools/toolChoice/schema |
| `protocol/message-decoder.ts` | Done | Extract tool calls from response |
| `session/types.ts` | Done | SampleRequestEvent with tools/schema |
| `plugin-session-manager.ts` | Done | sample_request handler with full flow |

## Files to Create (Phase 5) - DONE

| File | Purpose | Status |
|------|---------|--------|
| `packages/framework/.../sampling-structured.test.ts` | Unit tests for schema/tools | ✅ |
| `apps/yo-chat/src/tools/play-ttt/tool.ts` | Agentic tool with decision tree | ✅ |
| `apps/yo-chat/src/tools/play-ttt/plugin.ts` | Client elicit handlers | ✅ |
| `apps/yo-chat/src/tools/play-ttt/index.ts` | Barrel exports | ✅ |
| `apps/yo-chat/src/routes/chat/play-ttt/index.tsx` | Route for E2E | ✅ |
| `apps/yo-chat/e2e/play-ttt.spec.ts` | Playwright E2E tests | ✅ |

---

## Decisions Made

1. **Mutual exclusivity**: `schema` and `tools` cannot both be specified
2. **Type safety**: Full generic typing at `ctx.sample<T>()` level via overloads
3. **Error handling**: Parse errors returned in result (not thrown) - `parseError?: { message, rawText }`
4. **Schema format**: Accept Zod at API, convert to JSON Schema internally using `zod-to-json-schema`
5. **Provider mapping**: Tools passed as `isomorphicToolSchemas` with `authority: 'server'`
6. **Runtime signatures**: Use type assertions (`as McpToolContext['sample']`) to satisfy overloaded interface
7. **Tool calling use case**: LLM-driven flow control / decision trees, not external tool execution
8. **Validation approach**: `play_ttt` agentic tool as integration test vehicle

---

## Tool Calling Pattern: Decision Trees

The primary use case for `ctx.sample({ tools })` is LLM-driven decision trees:

```typescript
// Level 1: Strategy decision (tools)
const strategy = yield* ctx.sample({
  prompt: `Board:\n${board}\nChoose your strategy.`,
  tools: [
    { name: 'play_offensive', inputSchema: z.object({ reasoning: z.string() }) },
    { name: 'play_defensive', inputSchema: z.object({ threat: z.string() }) },
  ],
  toolChoice: 'required',
})

// Level 2: Move selection (schema) with tool result context
const move = yield* ctx.sample({
  messages: [
    ...previousMessages,
    { role: 'assistant', tool_calls: [...] },
    { role: 'tool', content: `Playing ${strategy}. Pick your cell.`, tool_call_id: ... },
  ],
  schema: z.object({ cell: z.number().min(0).max(8) }),
})
```

This leverages:
- Model's tool-calling training for decisions
- Multi-turn context for coherent reasoning
- Schema for final structured output

---

## Testing Strategy

### Unit Tests (Fast Iteration)

Mock sampling provider, test the plumbing:
- Schema passed correctly, parsed correctly, errors handled
- Tools passed correctly, toolCalls returned
- Multi-turn message accumulation

### Playwright E2E (Acceptance)

Real LLM, test tip-to-tail:
- Game starts, moves made, game completes
- Decision tree pattern works with real model
- User interaction via elicit works

---

## Commands

```bash
# Type check
cd packages/framework && pnpm exec tsc --noEmit

# Run unit tests
cd packages/framework && pnpm test src/lib/chat/mcp-tools

# Run E2E tests
cd apps/yo-chat && pnpm playwright test e2e/play-ttt.spec.ts
```

---

## Final Results

### Unit Tests (9 passing)
```
packages/framework/src/lib/chat/mcp-tools/__tests__/sampling-structured.test.ts
 ✓ schema parsing - valid JSON
 ✓ schema parsing - invalid JSON
 ✓ schema parsing - validation failure
 ✓ schema parsing - retry loop
 ✓ tool calling - pass tools/toolChoice
 ✓ tool calling - return toolCalls
 ✓ decision tree - L1 tools → L2 schema
 ✓ decision tree - multi-turn context
 ✓ decision tree - tool result messages
```

### E2E Tests (8 passing)
```
apps/yo-chat/e2e/play-ttt.spec.ts
 ✓ game starts and board appears (1.9s)
 ✓ handles both X and O assignment for user (1.9s)
 ✓ user can click a cell to make a move (5.0s)
 ✓ board highlights last move (5.7s)
 ✓ board shows correct player marks with colors (9.6s)
 ✓ handles game cancellation gracefully (4.7s)
 ✓ model uses strategy before making moves (17.4s)
 ✓ full game: multiple moves until game ends (24.7s)
```

### Key Implementation Notes

1. **Real Sampling Provider**: `api.chat.ts` now includes a real sampling provider that calls the configured LLM (Ollama/OpenAI), converts `SamplingToolDefinition[]` to `IsomorphicToolSchema[]`, and extracts `toolCalls` from `ChatResult`.

2. **Safe Optional Chaining**: `strategy.toolCalls?.[0]` with graceful fallback when tools aren't returned.

3. **Type Exports**: Added to `packages/framework/src/lib/chat/index.ts`:
   - `SampleResultBase`
   - `SampleResultWithParsed`
   - `SampleResultWithToolCalls`
   - `SamplingToolCall`
   - `SamplingToolDefinition`
   - `SamplingToolChoice`
