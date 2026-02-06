# Fix Tool Call Message Pipeline

**Branch:** `integration/new-workers`
**Last Updated:** 2025-07-14
**Overall Status:** ✅ COMPLETE
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

### Task 1: Add types in `mcp-tool-types.ts` ✅

Added after `ExtendedMessage` definition (~line 510):

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

Widened `ExtendedMessage`:
```typescript
export type ExtendedMessage = Message | McpMessage | ToolCallMessage | ToolResultMessage
```

- [x] Add `ToolCallMessageToolCall` interface
- [x] Add `ToolCallMessage` interface
- [x] Add `ToolResultMessage` interface
- [x] Widen `ExtendedMessage` union

### Task 2: Widen helper config messages in `mcp-tool-types.ts` ✅

- [x] `SampleToolsConfigMessages.messages` (line ~961): `Message[]` -> `ExtendedMessage[]`
- [x] `SampleSchemaConfigMessages.messages` (line ~987): `Message[]` -> `ExtendedMessage[]`

### Task 3: Fix GAP 1 — `toWorkerMessage()` in `worker-runner.ts` ✅

Added type guards (`isToolCallMessage`, `isToolResultMessage`) and conversion logic:
- `ToolCallMessage` → `WorkerMessage` with `tool_use` content blocks
- `ToolResultMessage` → `WorkerMessage` with `tool_result` content block (role `'tool'` → `'user'`)

- [x] Detect `ToolCallMessage` (has `tool_calls` array)
- [x] Convert to `WorkerMessage` with `WorkerToolUseContent` blocks
- [x] Detect `ToolResultMessage` (has `tool_call_id`)
- [x] Convert to `WorkerMessage` with `WorkerToolResultContent` block
- [x] Preserve text content alongside tool_calls

### Task 4: Fix GAP 2 — `handleSampleRequest()` in `worker-session-api.ts` ✅

Added `workerMessageToExtended()` function that reconstructs typed messages from `WorkerMessage` content blocks.

- [x] Detect `WorkerMessage` with `tool_use` content blocks -> `ToolCallMessage`
- [x] Detect `WorkerMessage` with `tool_result` content blocks -> `ToolResultMessage`
- [x] Handle text-only `WorkerMessage` -> `Message` (existing path)
- [x] Handle `McpMessage` passthrough

### Task 5: Fix GAP 3 — `SampleRequestEvent.messages` in `session/types.ts` ✅

- [x] `SampleRequestEvent.messages`: `Message[]` -> `ExtendedMessage[]`
- [x] `ToolSessionOptions.parentMessages`: `Message[]` -> `ExtendedMessage[]`
- [x] `ToolSessionSamplingProvider.sample()`: takes `ExtendedMessage[]`
- [x] Add `ExtendedMessage` to imports

### Task 6: Create shared utility ✅

New file: `packages/framework/src/lib/chat/mcp-tools/message-conversion.ts`

`extendedMessageToProviderMessage(msg: ExtendedMessage): ChatMessage` handles all variants:
- `Message` -> passthrough
- `McpMessage` with `tool_use` blocks -> `{ role: 'assistant', content, tool_calls }`
- `McpMessage` with `tool_result` blocks -> `{ role: 'tool', content, tool_call_id }`
- `McpMessage` text-only -> `{ role, content: joined text }`
- `ToolCallMessage` -> passthrough (already provider format)
- `ToolResultMessage` -> passthrough (already provider format)

Also exports type guards: `isToolCallMessage()`, `isToolResultMessage()`

- [x] Create file
- [x] Implement converter function
- [x] Implement type guards

### Task 7: Fix GAP 4 — `plugin-session-manager.ts` ✅

Replaced manual `as any` casting with `sampleEvent.messages.map(extendedMessageToProviderMessage)`.

- [x] Import `extendedMessageToProviderMessage`
- [x] Replace manual `as any` casting with utility call
- [x] Remove `as any` casts on lines 347-348

### Task 8: Fix `play-ttt/tool.ts` ✅

Removed `as any` cast. Messages array now type-checks directly as `ExtendedMessage[]` since `ToolCallMessage` and `ToolResultMessage` are in the union.

- [x] Remove `as any` cast
- [x] Verify types compile

### Task 9: Fix `create-session.ts` ✅

Removed `as any` casts for tool_calls/tool_call_id in the MCP pipeline path. Used conditional spread for `exactOptionalPropertyTypes` compatibility.

- [x] Remove `as any` casts related to ExtendedMessage/tool_calls/tool_call_id

**Note:** 5 `as any` casts remain in `create-session.ts` but are **unrelated** to this plan:
- 2 casts for extended streamer options (intentional type widening, documented)
- 3 casts for `ApiMessage` → `Message` tool_calls mapping fallback (`tc.name`/`tc.arguments` vs `tc.function`). These are in the chat session runtime's message syncing logic, not the MCP pipeline. Separate cleanup task.

### Task 10: Fix `sampling-structured.test.ts` ✅

Removed both `as any` casts. Tests now use properly typed `ToolCallMessage`/`ToolResultMessage` literals.

- [x] Remove `as any` casts
- [x] Use properly typed `ToolCallMessage` / `ToolResultMessage` literals

### Task 11: Fix `bridge-runtime.ts` ✅

Widened `messages` from `Message[]` to `ExtendedMessage[]` in both `sampleTools` (~line 623) and `sampleSchema` (~line 760) sections. Added `typeof lastMsg.content === 'string'` guards in retry logic — non-string content messages get a new user message appended instead of string concatenation.

Also widened cascading types:
- `WorkerToolSessionOptions.parentMessages` in `worker-tool-session.ts`: `Message[]` -> `ExtendedMessage[]`
- `McpWorkerInitData.parentMessages` in `worker-types.ts`: `Message[]` -> `ExtendedMessage[]`

`getMessageTextContent()` remains in `bridge-runtime.ts` for token estimation only (text-only usage is correct there).

- [x] Widen `sampleTools` messages to `ExtendedMessage[]`
- [x] Widen `sampleSchema` messages to `ExtendedMessage[]`
- [x] Add content type guards in retry logic
- [x] Widen `WorkerToolSessionOptions.parentMessages`
- [x] Widen `McpWorkerInitData.parentMessages`

### Task 12: Fix `plugin-tool-executor.ts` ✅

Replaced lossy `getMessageTextContent()` flattening (which stripped `tool_calls` and `tool_call_id`) with `extendedMessageToProviderMessage()`. Removed the now-unused `getMessageTextContent` function.

- [x] Replace `getMessageTextContent` with `extendedMessageToProviderMessage`
- [x] Remove unused `getMessageTextContent` function
- [x] Update imports

### Task 13: Run tests ✅

- [x] `pnpm test` in `packages/framework` — **712 passing**, 18 failing (all pre-existing)
  - 1 failure in `tool-discovery.test.ts` — worker entry format assertion mismatch (pre-existing)
  - 17 failures in `worker-tool-session.test.ts` — `@effectionx/worker` TS stripping issue (pre-existing)
- [x] `pnpm test` in `packages/core` — **104 passing**, 9 failing (all pre-existing)
  - 1 failure in `host-crash.test.ts` — worker crash timeout (pre-existing)
  - 8 failures in `websocket/transport.test.ts` — WebSocket timeouts (pre-existing)
- [x] `npx tsc --noEmit` — zero errors in both `packages/framework` and `packages/core`

---

## Files Modified

| File | What Changed |
|------|-------------|
| `packages/framework/src/lib/chat/mcp-tools/mcp-tool-types.ts` | Added `ToolCallMessage`, `ToolResultMessage`, `ToolCallMessageToolCall`; widened `ExtendedMessage` union; widened `SampleToolsConfigMessages.messages` and `SampleSchemaConfigMessages.messages` to `ExtendedMessage[]` |
| `packages/framework/src/lib/chat/mcp-tools/session/worker-runner.ts` | Fixed `toWorkerMessage()` with type guards and conversion for all `ExtendedMessage` variants |
| `packages/framework/src/lib/chat/mcp-tools/session/worker-session-api.ts` | Added `workerMessageToExtended()`, replaced lossy `Message[]` mapping |
| `packages/framework/src/lib/chat/mcp-tools/session/types.ts` | Widened `SampleRequestEvent.messages`, `parentMessages`, `sample()` to `ExtendedMessage[]` |
| `packages/framework/src/lib/chat/mcp-tools/message-conversion.ts` | **NEW** — `extendedMessageToProviderMessage()`, `isToolCallMessage()`, `isToolResultMessage()` |
| `packages/framework/src/handler/durable/plugin-session-manager.ts` | Replaced manual `as any` casting with `extendedMessageToProviderMessage` |
| `apps/yo-chat/src/tools/play-ttt/tool.ts` | Removed `as any` cast |
| `packages/framework/src/lib/chat/session/create-session.ts` | Removed `as any` casts for ExtendedMessage, used conditional spread |
| `packages/framework/src/lib/chat/mcp-tools/__tests__/sampling-structured.test.ts` | Removed both `as any` casts |
| `packages/framework/src/lib/chat/mcp-tools/bridge-runtime.ts` | Widened messages to `ExtendedMessage[]` in sampleTools + sampleSchema, added content type guards in retry logic |
| `packages/framework/src/handler/durable/plugin-tool-executor.ts` | Replaced `getMessageTextContent` with `extendedMessageToProviderMessage`, removed unused function |
| `packages/framework/src/lib/chat/mcp-tools/session/worker-tool-session.ts` | Widened `WorkerToolSessionOptions.parentMessages` to `ExtendedMessage[]` |
| `packages/framework/src/lib/chat/mcp-tools/session/worker-types.ts` | Widened `McpWorkerInitData.parentMessages` to `ExtendedMessage[]` |

---

## Notes

- The `WorkerMessage` type in `packages/core/src/transport/worker/types.ts` already supports `WorkerToolUseContent` and `WorkerToolResultContent` content blocks. We didn't need to change core types.
- The `WorkerSampleSchemaConfigMessages.messages` in `worker-types.ts` was already `ExtendedMessage[]`. The worker-side types were ahead of the host-side types.
- The chat provider `Message` type already supports `tool_calls` and `tool_call_id`. The issue was purely in the MCP pipeline between worker and host.
- `getMessageTextContent()` still exists in `bridge-runtime.ts` for token estimation — that's correct since token estimation only needs text content.
- 5 `as any` casts remain in `create-session.ts` but are unrelated to this plan (streamer options widening + `ApiMessage` tool_calls mapping fallback). These would be a separate cleanup task.
