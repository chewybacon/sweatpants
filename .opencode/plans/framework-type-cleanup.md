# Framework Type Cleanup — Phase 2

**Branch:** `integration/new-workers`
**Last Updated:** 2025-07-15
**Overall Status:** 🔄 IN PROGRESS
**Prerequisite:** Phase 1 plan (`fix-tool-call-message-pipeline.md`) ✅ COMPLETE
**Skill:** Use the `typescript-expert` skill before writing any code.

---

## Overview

Phase 2 eliminates systemic type unsafety across the framework. An exhaustive audit found **63 `as any` casts** (25 production, 33 test, 4 test infra) and **50+ guarded expansion patterns** clustering around 5 root causes. This plan addresses all 5 root causes plus ancillary findings, ordered by dependency and risk.

### Strategy

**Full sweep** scope with **unify ApiMessage into Message** as the primary structural change.

### Dependency Graph

```
A (ToolSessionEvent narrowing)  ← independent, zero risk
B (Streamer type fix)           ← independent, zero risk
C (ApiMessage elimination)      ← highest impact, enables D
D (ToolCall canonicalization)   ← depends on C
E (StreamEvent unification)     ← independent
F (Zod/JSON Schema cleanup)    ← independent
G (Provider + misc)             ← independent, lowest priority
```

---

## Root Causes

### Root Cause 1: `ApiMessage` vs `Message` duplication
- `ApiMessage` (`session/streaming.ts:17`) and `Message` (`chat/types.ts:128`) are nearly identical
- `Message` is a **superset** — `ApiMessage` has no unique fields
- Only differences: `Message` adds `id?: string`, `partial?: boolean`, and `tool_calls[].type: 'function'` (required vs absent)
- Conversion copy-pasted **3 times** in `create-session.ts` with `as any` casts each time
- `toApiMessages()` in `stream-chat.ts:361` converts Message→ApiMessage (trivial strip)
- **Fix:** Eliminate `ApiMessage`. Use `Message` everywhere.

### Root Cause 2: `ToolSessionEvent` doesn't narrow through switch
- `ToolSessionEvent` IS a proper discriminated union with `type` field on every variant
- TypeScript narrows it correctly — verified by removing all casts with zero `tsc` errors
- 8 `(event as any).field` casts + 1 `event as SampleRequestEvent` cast are unnecessary
- **Fix:** Delete all casts. Pure deletion, no new types needed.

### Root Cause 3: `Streamer` type too narrow for extended options
- `Streamer` (`options.ts:21`) accepts `Omit<SessionOptions, 'streamer'>` as 3rd param
- `streamChatOnce` actually accepts `StreamChatOptions extends SessionOptions` (adds `isomorphicToolSchemas`, `isomorphicClientOutputs`, `elicitResponses`)
- Both call sites in `create-session.ts` cast the entire options object `as any`
- **Fix:** Change `Streamer` to use `StreamChatOptions` instead of `SessionOptions`.

### Root Cause 4: Zod → JSON Schema casts (~20 locations)
- Every `z.toJSONSchema()` cast `as Record<string, unknown>` (8 occurrences)
- Every `zodToJsonSchema()` library call uses `as any` input + `as Record<string, unknown>` output
- Two duplicate local `zodToJsonSchema` wrapper functions
- `ElicitRequest.schema.zod` stubbed as `{} as any` on client side
- **Fix:** Shared `toJsonSchema()` utility with branded `JsonSchema` type. Split `ElicitRequest` server/client variants.

### Root Cause 5: ToolCall type fragmentation (3 competing shapes)
1. **OpenAI nested:** `{ id, type: 'function', function: { name, arguments } }` — `Message.tool_calls`, `ToolCall` in `types.ts`, `ToolCallMessageToolCall`
2. **Flat:** `{ id, name, arguments }` — `ToolCallInfo`, `SamplingToolCall`, `WorkerToolCall`, `StreamEvent.tool_calls.calls[]`
3. **Durable engine:** same as #1 but `arguments: unknown` instead of `Record<string, unknown>` — `ToolCall` in `durable/types.ts`, forces 4 casts in `chat-engine.ts`
- `ApiMessage.tool_calls` is a 4th shape that omits `type` entirely
- **Fix:** Named canonical types. Fix `durable/types.ts` arguments to `Record<string, unknown>`.

---

## Additional Findings

### `StreamEvent` duplication
- `handler/types.ts:125` and `session/streaming.ts:171` define **separate `StreamEvent` unions**
- Three semantic drift bugs: `complete.usage` (camelCase vs snake_case), `isomorphic_handoff.usesHandoff` (optional vs required), `tool_session_status` vs `plugin_session_status` (discriminant string diverged)
- **Fix:** Single source of truth — delete handler's `StreamEvent`, re-export from session layer.

### Provider layer casts (lower priority)
- `openai.ts:236`, `ollama.ts:90`: `response.body as any` — Node→Web ReadableStream
- `openai.ts:313,324,355`: `(delta as any)?.text` — untyped SSE event bag
- **Fix:** Extract `toWebReadableStream()` utility; define SSE event discriminated union.

### Isomorphic tool builder casts (intentional — won't fix)
- `builder.ts:422,452,483,498`: `_types: undefined as any` — **phantom type pattern**, intentional
- `tool-handlers.ts:333`: `handlerFn as any` — **heterogeneous collection contravariance**, intentional (type safety enforced at `.add()`)
- **Won't fix.** Could change to `undefined!` for marginal clarity but no type safety improvement.

### `session-registry.ts:159` — `ContextEntry as any`
- `Context<T>` contravariance vs `ContextEntry<unknown>`. **Fix:** Accept `ContextEntry<any>[]` in `useBackgroundTask`.

### `ChatMessage` name collision (documentation only — won't fix this phase)
Three different things named `ChatMessage`:
1. `handler/types.ts:42`: `= Message` (alias)
2. `types/chat-message.ts:252`: Parts-based UI message
3. `react/chat/useChat.ts:92`: `= BaseChatMessage<React.ComponentType>`

---

## Tasks

### Task A: ToolSessionEvent narrowing — delete `as any` casts ⬜

**Risk:** Zero — TypeScript already narrows the discriminated union correctly.
**Files:** `packages/framework/src/handler/durable/plugin-session-manager.ts`

Delete 8 `(event as any).field` casts and 1 `event as SampleRequestEvent` cast in the switch block (lines ~326-478). The `ToolSessionEvent` union type discriminates on `type`, so after `case 'elicit_request':`, TypeScript knows `event` is `ElicitRequestEvent` with `.elicitId`, `.key`, `.message`, `.schema`.

Changes:
- [x] `case 'elicit_request'`: remove 4 `(event as any)` → use `event.elicitId`, `event.key`, `event.message`, `event.schema`
- [x] `case 'sample_request'`: remove `event as SampleRequestEvent` cast → use `event` directly (already narrows to `SampleRequestEvent`)
- [x] `case 'result'`: remove `(event as any).result` → use `event.result`
- [x] `case 'error'`: remove `(event as any).name`, `(event as any).message` → use `event.name`, `event.message`
- [x] `case 'cancelled'`: remove `(event as any).reason` → use `event.reason`

### Task B: Fix Streamer type ⬜

**Risk:** Zero — widens a type parameter.
**Files:** `packages/framework/src/lib/chat/session/options.ts`

Change `Streamer` type's 3rd parameter from `Omit<SessionOptions, 'streamer'>` to `Omit<StreamChatOptions, 'streamer'>`. Then delete both `as any` casts on the streamer call sites in `create-session.ts` (~lines 375, 864).

Changes:
- [ ] Update `Streamer` type in `options.ts`
- [ ] Add `StreamChatOptions` import
- [ ] Delete 2 `as any` casts in `create-session.ts`

### Task C: Eliminate `ApiMessage` — unify into `Message` ⬜

**Risk:** Medium — touches 6+ production files. Must verify all `ApiMessage` consumers accept the superset fields.
**Files:** `streaming.ts`, `stream-chat.ts`, `create-session.ts`, `options.ts`, `types.ts`, `react/chat/types/index.ts`, `isomorphic-tools/runtime/types.ts`, test files

Steps:
1. Delete `ApiMessage` interface from `streaming.ts`
2. Replace all `ApiMessage` references with `Message` (from `chat/types.ts`)
3. Delete `toApiMessages()` from `stream-chat.ts`
4. Delete the 3 copy-pasted `ApiMessage → Message` conversion blocks in `create-session.ts` (the ones with `as any` casts for `tc.name`/`tc.arguments` fallback)
5. Update `Streamer` type (if not already done in Task B) — `ApiMessage[]` → `Message[]`
6. Update `ConversationState.messages` — `ApiMessage[]` → `Message[]`
7. Remove `ApiMessage` re-exports from `types.ts`, `react/chat/types/index.ts`, `isomorphic-tools/runtime/types.ts`

Changes:
- [ ] Delete `ApiMessage` interface
- [ ] Delete `toApiMessages()` function
- [ ] Delete 3 conversion blocks in `create-session.ts`
- [ ] Replace all `ApiMessage` references with `Message`
- [ ] Update re-exports

### Task D: Canonicalize ToolCall types ⬜

**Risk:** Low — mostly naming/aliasing.
**Depends on:** Task C (eliminating `ApiMessage` removes its anonymous `tool_calls` shape)
**Files:** `types.ts`, `durable/types.ts`, `chat-engine.ts`, `mcp-tool-types.ts`

Steps:
1. Make `ToolCall` in `chat/types.ts` require `type: 'function'` (currently optional) — already matches all actual usage
2. Fix `ToolCall` in `durable/types.ts` — change `arguments: unknown` → `arguments: Record<string, unknown>`
3. Delete the 4 `as any` casts in `chat-engine.ts` that bridge the `unknown` → `Record<string, unknown>` gap
4. Make `Message.tool_calls` reference the named `ToolCall` type instead of inline anonymous type
5. Verify `ToolCallMessageToolCall` (from Phase 1) aligns with canonical `ToolCall`

Changes:
- [ ] `ToolCall.type` required in `types.ts`
- [ ] `ToolCall.function.arguments` → `Record<string, unknown>` in `durable/types.ts`
- [ ] Delete `as any` casts in `chat-engine.ts`
- [ ] `Message.tool_calls` references `ToolCall[]`
- [ ] Reconcile `ToolCallMessageToolCall` with `ToolCall`

### Task E: Unify duplicate `StreamEvent` types ✅ COMPLETE

**Risk:** Medium — must reconcile 3 semantic drift bugs.
**Files:** `handler/types.ts`, `handler/durable/chat-engine.ts`, `session/streaming.ts`

Steps:
1. Audit both `StreamEvent` union definitions side by side
2. Reconcile the 3 drift bugs:
   - `complete.usage`: decide camelCase vs snake_case, required vs optional
   - `isomorphic_handoff.usesHandoff`: decide optional vs required
   - `tool_session_status` vs `plugin_session_status`: pick one discriminant
3. Delete handler's `StreamEvent`, re-export from session layer
4. Update all imports

Changes:
- [x] Reconcile usage field naming — changed `chat-engine.ts` to emit camelCase `TokenUsage` directly (was converting to snake_case for no reason; session layer already uses `TokenUsage`)
- [x] Reconcile usesHandoff optionality — session layer already has `usesHandoff?: boolean` (optional), which is the correct superset
- [x] Reconcile session status discriminant — changed `chat-engine.ts` to emit `'tool_session_status'` (was `'plugin_session_status'`, which silently dropped by client's switch; consistent with `'tool_session_error'`)
- [x] Delete duplicate, add re-export — deleted ~100 lines of inline `StreamEvent` from `handler/types.ts`, replaced with re-export from `session/streaming.ts` (also re-exports named sub-interfaces: `ConversationState`, `ConversationStateStreamEvent`, `IsomorphicHandoffStreamEvent`, `ElicitRequestStreamEvent`, `ToolSessionStatusStreamEvent`, `ToolSessionErrorStreamEvent`)
- [x] Zero import changes needed — all consumers already imported from `handler/types.ts` which now re-exports

### Task F: Zod/JSON Schema boundary cleanup ⬜

**Risk:** Low — mostly utility extraction.
**Files:** `bridge-runtime.ts`, `registry.ts`, `worker-runner.ts`, `core-context.ts`, `handler.ts`, `mcp-handler.ts`, `mcp-tool-types.ts`, `useElicitExecutor.ts`

Steps:
1. Create `JsonSchema` branded type: `type JsonSchema = Record<string, unknown> & { readonly __brand: 'JsonSchema' }`
2. Create shared `toJsonSchema(schema: z.ZodType): JsonSchema` utility (consolidate 2 duplicate wrappers)
3. Replace all `z.toJSONSchema() as Record<string, unknown>` with `toJsonSchema(schema)`
4. Replace all `zodToJsonSchema() as any` calls with the shared utility
5. Split `ElicitRequest` into server (`schema: { zod: TSchema; json: JsonSchema }`) and client (`schema: { json: JsonSchema }`) variants — eliminates `{} as any` stub

Changes:
- [ ] Create `JsonSchema` branded type
- [ ] Create shared `toJsonSchema()` utility
- [ ] Eliminate duplicate wrappers in `bridge-runtime.ts` and `registry.ts`
- [ ] Replace all cast sites
- [ ] Split `ElicitRequest` server/client variants

### Task G: Provider layer + misc casts ⬜

**Risk:** Low.
**Files:** `openai.ts`, `ollama.ts`, `session-registry.ts`

Steps:
1. Extract `toWebReadableStream()` utility for `response.body as any` in provider files
2. Define SSE event types for OpenAI streaming (eliminate `(delta as any)?.text`)
3. Fix `session-registry.ts:159` — accept `ContextEntry<any>[]` in `useBackgroundTask`

Changes:
- [ ] `toWebReadableStream()` utility
- [ ] SSE event discriminated union
- [ ] `ContextEntry<any>[]` parameter

### Won't Fix (Intentional Patterns)

| Location | Pattern | Justification |
|----------|---------|---------------|
| `builder.ts:422,452,483,498` | `undefined as any` | Phantom type pattern — enables type-level API without runtime cost |
| `tool-handlers.ts:333` | `handlerFn as any` | Heterogeneous collection contravariance — type safety enforced at `.add()` call site |
| `ChatMessage` name collision | 3 different meanings | Documentation-only issue, renaming would be API-breaking |

---

## Files Modified

| Task | Files | What Changed |
|------|-------|-------------|
| **A** | `plugin-session-manager.ts` | Deleted 9 `as any` casts |
| **B** | `options.ts`, `create-session.ts` | Widened `Streamer` type, deleted 2 casts |
| **C** | `streaming.ts`, `stream-chat.ts`, `create-session.ts`, `options.ts`, `types.ts`, `react/chat/types/index.ts`, `isomorphic-tools/runtime/types.ts`, tests | Eliminated `ApiMessage`, deleted `toApiMessages()`, deleted 3 conversion blocks |
| **D** | `types.ts`, `durable/types.ts`, `chat-engine.ts`, `mcp-tool-types.ts` | Canonical `ToolCall` types |
| **E** | `handler/types.ts`, `handler/durable/chat-engine.ts` | Deleted ~100-line duplicate `StreamEvent`, re-export from `session/streaming.ts`; fixed 3 drift bugs (usage camelCase, tool_session_status discriminant, usesHandoff optionality) |
| **F** | `bridge-runtime.ts`, `registry.ts`, `worker-runner.ts`, `core-context.ts`, `handler.ts`, `mcp-handler.ts`, `mcp-tool-types.ts`, `useElicitExecutor.ts` | `JsonSchema` branded type, shared utility |
| **G** | `openai.ts`, `ollama.ts`, `session-registry.ts` | `toWebReadableStream()`, SSE types, `ContextEntry` fix |
