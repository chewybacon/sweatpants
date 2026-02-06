# Fix Tool Call Message Pipeline

**Branch:** `integration/new-workers`
**Last Updated:** 2025-01-XX
**Overall Status:** IN PROGRESS
**Skill:** Use the `typescript-expert` skill before writing any code.

---

## Overview

The `play-ttt` tool uses a 2-level sampling pattern where L1 asks the LLM to pick a strategy via tool calling and L2 asks the LLM to pick a move. L2 passes conversation history that includes L1's tool call result as OpenAI-format messages with `tool_calls` and `tool_call_id` properties. **This is broken because 4 gaps in the message pipeline silently strip the tool call context.**

The fix introduces `ToolCallMessage` and `ToolResultMessage` types to the `ExtendedMessage` union, converts at both boundaries (OpenAI format <-> MCP content blocks), and provides a shared utility for the reverse conversion.

---

## Design Decisions

1. **User-facing API uses OpenAI-compatible message format.** Tool authors should never think about MCP content blocks. They feel like they're using the OpenAI SDK. The framework handles all internal transformations.

2. **Convert at both boundaries.** OpenAI format -> MCP content blocks at the worker ctx boundary, MCP content blocks -> OpenAI format at the provider boundary. The internal pipeline stays in MCP format.

3. **Option C: ExtendedMessage union with new types.** Keep `Message` narrow (`{ role, content: string }`) for internal use. Add two new vendor-neutral types to the `ExtendedMessage` union:
   - `ToolCallMessage` — assistant message with `tool_calls` array
   - `ToolResultMessage` — tool result message with `role: 'tool'` and `tool_call_id`
   - `ExtendedMessage = Message | McpMessage | ToolCallMessage | ToolResultMessage`

4. **Shared utility function** — `extendedMessageToProviderMessage()` converts any `ExtendedMessage` variant to the chat provider's `Message` format (from `chat/types.ts`).

5. **Full cleanup scope** — Fix all 7 `as any` tool call casts across 4 files, not just the pipeline bug.

---

## The Two `Message` Types

| Type | Location | Shape | Used By |
|------|----------|-------|---------|
| **MCP `Message`** | `packages/framework/src/lib/chat/mcp-tools/mcp-tool-types.ts` line ~469 | `{ role: 'user'\|'assistant'\|'system', content: string }` | MCP session pipeline, events, branch state |
| **Chat `Message`** | `packages/framework/src/lib/chat/types.ts` line ~128 | `{ role: 'system'\|'user'\|'assistant'\|'tool', content, tool_calls?, tool_call_id?, id?, partial? }` | `ChatProvider.stream()`, session layer |

---

## The 4 Gaps

- **GAP 1** — `toWorkerMessage()` in `worker-runner.ts` (lines 73-85): When `typeof msg.content === 'string'` it creates `{ role, content }` only, discarding `tool_calls`, `tool_call_id`, and `role: 'tool'`.
- **GAP 2** — `handleSampleRequest()` in `worker-session-api.ts` (lines 74-79): Maps all messages to `Message[]` (`{ role: string, content: string }`), JSON-stringifying content blocks and dropping everything else.
- **GAP 3** — `SampleRequestEvent.messages` in `session/types.ts` (line ~130): Typed as `Message[]` which only supports `{ role: string, content: string }`.
- **GAP 4** — `plugin-session-manager.ts` (lines 347-348): Checks `(msg as any).tool_calls` and `(msg as any).tool_call_id` but these were already stripped in gaps 1-3.

---

## All `as any` Tool Call Sites (7 occurrences)

```
apps/yo-chat/src/tools/play-ttt/tool.ts:202
packages/framework/src/lib/chat/session/create-session.ts:551
packages/framework/src/lib/chat/session/create-session.ts:552
packages/framework/src/handler/durable/plugin-session-manager.ts:347
packages/framework/src/handler/durable/plugin-session-manager.ts:348
packages/framework/src/lib/chat/mcp-tools/__tests__/sampling-structured.test.ts:457
packages/framework/src/lib/chat/mcp-tools/__tests__/sampling-structured.test.ts:557
```

---

## Key Files

- `packages/framework/src/lib/chat/mcp-tools/mcp-tool-types.ts` — Canonical type definitions. `Message`, `ExtendedMessage`, `McpMessage`, sample configs, helper configs, exchange types.
- `packages/framework/src/lib/chat/mcp-tools/session/worker-runner.ts` — Worker-side context creation. `toWorkerMessage()` at line ~73, `buildMessages()` at line ~179, `sampleImpl()` at line ~190.
- `packages/framework/src/lib/chat/mcp-tools/session/worker-session-api.ts` — Host-side request/response handling. `handleSampleRequest()` at line ~70.
- `packages/framework/src/lib/chat/mcp-tools/session/types.ts` — Session event types. `SampleRequestEvent` at line ~125.
- `packages/framework/src/handler/durable/plugin-session-manager.ts` — Host-side LLM caller. Lines ~336-450 handle `sample_request` events.
- `packages/core/src/transport/worker/types.ts` — Core `WorkerMessage` type. Already supports content blocks (`WorkerToolUseContent`, `WorkerToolResultContent`).
- `packages/framework/src/lib/chat/mcp-tools/protocol/types.ts` — MCP protocol types. `McpMessage`, `McpContentBlock`, `McpToolUseContent`, `McpToolResultContent`.
- `packages/framework/src/lib/chat/types.ts` — Chat provider `Message` type at line ~128.
- `packages/framework/src/lib/chat/mcp-tools/session/worker-types.ts` — Worker-side sample config types. `WorkerSampleSchemaConfigMessages.messages` is already `ExtendedMessage[]`.
- `apps/yo-chat/src/tools/play-ttt/tool.ts` — The broken tool. L1->L2 pattern at lines ~138-205.

---

## Tasks

### Task 1: Add types in `mcp-tool-types.ts`

Add after `ExtendedMessage` definition (~line 510):

```typescript
export interface ToolCallMessageToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: Record<string, unknown> }
}
export interface ToolCallMessage {
  role: 'assistant'
  content: string
  tool_calls: [ToolCallMessageToolCall, ...ToolCallMessageToolCall[]]
}
export interface ToolResultMessage {
  role: 'tool'
  content: string
  tool_call_id: string
}
```

Then widen `ExtendedMessage`:
```typescript
export type ExtendedMessage = Message | McpMessage | ToolCallMessage | ToolResultMessage
```

- [ ] Add `ToolCallMessageToolCall` interface
- [ ] Add `ToolCallMessage` interface
- [ ] Add `ToolResultMessage` interface
- [ ] Widen `ExtendedMessage` union

### Task 2: Widen helper config messages in `mcp-tool-types.ts`

- [ ] `SampleToolsConfigMessages.messages` (line ~907): `Message[]` -> `ExtendedMessage[]`
- [ ] `SampleSchemaConfigMessages.messages` (line ~931): `Message[]` -> `ExtendedMessage[]`

### Task 3: Fix GAP 1 — `toWorkerMessage()` in `worker-runner.ts`

Lines 73-85. Add conversion for:
- `ToolCallMessage` -> `WorkerMessage` with `tool_use` content blocks
- `ToolResultMessage` -> `WorkerMessage` with `tool_result` content block (role `'tool'` -> `'user'`)

- [ ] Detect `ToolCallMessage` (has `tool_calls` array)
- [ ] Convert to `WorkerMessage` with `WorkerToolUseContent` blocks
- [ ] Detect `ToolResultMessage` (has `tool_call_id`)
- [ ] Convert to `WorkerMessage` with `WorkerToolResultContent` block
- [ ] Preserve text content alongside tool_calls

### Task 4: Fix GAP 2 — `handleSampleRequest()` in `worker-session-api.ts`

Lines 74-79. Stop flattening content blocks. Preserve structure, output `ExtendedMessage[]` instead of `Message[]`.

- [ ] Detect `WorkerMessage` with `tool_use` content blocks -> `ToolCallMessage`
- [ ] Detect `WorkerMessage` with `tool_result` content blocks -> `ToolResultMessage`
- [ ] Handle text-only `WorkerMessage` -> `Message` (existing path)
- [ ] Handle `McpMessage` passthrough

### Task 5: Fix GAP 3 — `SampleRequestEvent.messages` in `session/types.ts`

Line ~130. Widen from `Message[]` to `ExtendedMessage[]`.

- [ ] Change type annotation
- [ ] Add `ExtendedMessage` to imports

### Task 6: Create shared utility

New file: `packages/framework/src/lib/chat/mcp-tools/message-conversion.ts`

`extendedMessageToProviderMessage(msg: ExtendedMessage): ChatMessage` handles all variants:
- `Message` -> passthrough
- `McpMessage` with `tool_use` blocks -> `{ role: 'assistant', content, tool_calls }`
- `McpMessage` with `tool_result` blocks -> `{ role: 'tool', content, tool_call_id }`
- `McpMessage` text-only -> `{ role, content: joined text }`
- `ToolCallMessage` -> passthrough (already provider format)
- `ToolResultMessage` -> passthrough (already provider format)

- [ ] Create file
- [ ] Implement converter function
- [ ] Export from appropriate index

### Task 7: Fix GAP 4 — `plugin-session-manager.ts`

Lines 341-349. Replace `(msg as any).tool_calls` checks with `sampleEvent.messages.map(extendedMessageToProviderMessage)`.

- [ ] Import `extendedMessageToProviderMessage`
- [ ] Replace manual `as any` casting with utility call
- [ ] Remove `as any` casts on lines 347-348

### Task 8: Fix `play-ttt/tool.ts`

Remove `as any` cast on line ~202. The messages array should now type-check as `ExtendedMessage[]` since `ToolCallMessage` and `ToolResultMessage` are in the union.

- [ ] Remove `as any` cast
- [ ] Verify types compile

### Task 9: Fix `create-session.ts`

Lines 551-552. Remove `(msg as any).tool_calls` / `(msg as any).tool_call_id` casts.

- [ ] Import `extendedMessageToProviderMessage` or use proper type narrowing
- [ ] Remove `as any` casts

### Task 10: Fix `sampling-structured.test.ts`

Lines ~457, ~475, ~557, ~575. Remove `as any` casts on messages arrays.

- [ ] Remove `as any` casts
- [ ] Use properly typed `ToolCallMessage` / `ToolResultMessage` literals

### Task 11: Fix `bridge-runtime.ts`

Replace lossy `getMessageTextContent()` with shared utility where tool call data is being lost.

- [ ] Identify lossy conversion points
- [ ] Replace with `extendedMessageToProviderMessage`

### Task 12: Fix `plugin-tool-executor.ts`

Replace lossy `getMessageTextContent()` with shared utility where tool call data is being lost.

- [ ] Identify lossy conversion points
- [ ] Replace with `extendedMessageToProviderMessage`

### Task 13: Run tests

- [ ] `pnpm test` in `packages/framework` (expect 719 passing)
- [ ] `pnpm test` in `packages/core` (expect 104 pass, 9 pre-existing failures from `@effectionx/worker` TS stripping)
- [ ] Fix any type errors or test failures

---

## Notes

- The `WorkerMessage` type in `packages/core/src/transport/worker/types.ts` already supports `WorkerToolUseContent` and `WorkerToolResultContent` content blocks. We don't need to change core types.
- The `WorkerSampleSchemaConfigMessages.messages` in `worker-types.ts` is already `ExtendedMessage[]`. The worker-side types are ahead of the host-side types.
- The chat provider `Message` type already supports `tool_calls` and `tool_call_id`. The issue is purely in the MCP pipeline between worker and host.
