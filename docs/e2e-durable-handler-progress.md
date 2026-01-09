# Durable Chat Handler - Agent Handoff

## Goal
Get `createDurableChatHandler` working in TanStack Start dev server. All tests pass but it hangs in the actual app.

## Current Status
- **39 unit tests pass** for durable handler
- **30 tests pass** for `useBackgroundTask` hook
- **Handler hangs** when running in TanStack Start dev server
- **Regular `createChatHandler` works** fine in same environment

## The Problem

`scope.run()` never completes in TanStack Start, even though the setup operation returns.

Logs show:
```
[streaming-handler] setup() returned, about to return from scope.run
# ... never reaches "scope.run() completed"
```

## What We Know

1. **The streaming handler pattern works** - `createStreamingHandler` with pull-based ReadableStream works correctly in tests and simple routes
2. **The durable handler logic is correct** - All 39 tests pass including HTTP smoke tests with real Ollama
3. **Something in TanStack Start interferes with Effection** - Same code that completes in tests hangs in TanStack Start
4. **It's not the writer scope** - We already moved the writer to a separate scope via `createScope()` and `writerScope.run()`

## Files

| File | Purpose |
|------|---------|
| `packages/framework/src/handler/durable/handler.ts` | Durable chat handler (uses `createStreamingHandler`) |
| `packages/framework/src/handler/streaming.ts` | Pull-based streaming primitive |
| `packages/framework/src/lib/effection/use-background-task.ts` | Background task utility |
| `packages/framework/src/lib/chat/durable-streams/session-registry.ts` | Session management |
| `apps/yo-chat/src/routes/api.chat-durable.ts` | Test route for durable handler |

## Test Commands

```bash
# Run durable handler tests (all pass)
cd packages/framework && pnpm vitest run --config vitest.config.ts src/handler/durable/__tests__/

# Run useBackgroundTask tests (all pass)
cd packages/framework && pnpm vitest run --config vitest.config.ts src/lib/effection/__tests__/

# Start yo-chat dev server
cd apps/yo-chat && pnpm dev

# Test durable endpoint (HANGS)
curl -X POST http://localhost:8000/api/chat-durable \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hi"}],"provider":"ollama"}'

# Test regular endpoint (WORKS)
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hi"}],"provider":"ollama"}'
```

## Investigation Areas

1. **What's different about TanStack Start's runtime?**
   - Vite dev server middleware?
   - Promise polyfills or patches?
   - async_hooks usage?

2. **What resources keep the scope alive?**
   - Add logging to see what's still running when setup returns
   - Check if contexts or other effects block completion

3. **Minimal reproduction**
   - Create simplest possible handler that hangs in TanStack Start
   - Isolate the exact combination that triggers the issue

## Completed Work

1. **Replaced console.log with Logger** - All debug logging uses pino-based logger (`LOG_LEVEL=debug`)
2. **Created `useBackgroundTask` hook** - Independent scope pattern for background tasks
3. **Fixed client event unwrapping** - `stream-chat.ts` handles durable `{lsn, event}` format
4. **Created `/api/chat-durable` route** - Test route in yo-chat app
