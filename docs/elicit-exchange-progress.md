# ElicitResult Exchange - Implementation Progress

## Status: COMPLETE

All tasks completed. TypeScript compiles successfully and all tests pass.

## Tasks

### Phase 1: Core Types
- [x] Add extended message types to `mcp-tool-types.ts`
- [x] Add `ElicitExchange` interface
- [x] Update `ElicitResult` to two type params with exchange
- [x] Add `RawElicitResult` for handlers/transport (without exchange)
- [x] Update context interfaces (`McpToolContext`, `McpToolContextWithElicits`)

### Phase 2: Runtime Implementations
- [x] Update `bridge-runtime.ts` - construct exchange in elicit handling
- [x] Update `branch-runtime.ts` - type signatures updated
- [x] Update `session-manager.ts` - placeholder exchange helper added

### Phase 3: Session Layer
- [x] Update `session/types.ts`
- [x] Update `session/tool-session.ts`
- [x] Update `session/worker-types.ts`
- [x] Update `session/worker-runner.ts`
- [x] Update `session/worker-tool-session.ts`

### Phase 4: Durable Handler
- [x] Update `handler/durable/plugin-session-manager.ts`

### Phase 5: Mocks and Protocol
- [x] Update `mock-runtime.ts`
- [x] Update `branch-mock.ts`
- [x] Update `protocol/message-decoder.ts`

### Phase 6: Legacy Types & Plugin System
- [x] Update `types.ts` (legacy mirror) - re-export `RawElicitResult`
- [x] Update `plugin.ts` - `ElicitHandler` returns `RawElicitResult`
- [x] Update `plugin.ts` - `PluginClientRegistrationInput` handlers return `RawElicitResult`
- [x] Update `plugin-executor.ts` - return types changed to `RawElicitResult`
- [x] Export `RawElicitResult` from `index.ts`

### Phase 7: Test Updates
- [x] Update `plugin.test.ts` - satisfies assertions use `RawElicitResult`
- [x] Update `builder.test.ts` - `ElicitResult` type expectations updated to two params

### Phase 8: Validation
- [x] Run `pnpm tsc --noEmit` - passes
- [x] Run tests - all 13 tests pass

## Summary of Changes

### Two-layer result types
- `RawElicitResult<TResponse>` - For handlers/transport (action + content only)
- `ElicitResult<TContext, TResponse>` - For tool context (includes exchange)

### Key design decisions
1. **Exchange constructed at bridge-runtime**: The layer that calls `ctx.elicit()` has context
2. **Safe by default**: `exchange.messages` has empty tool call arguments
3. **Opt-in context**: `withArguments((ctx) => {...})` for explicit context in messages
4. **Placeholder exchanges**: Transport/handler layers create minimal placeholder exchanges

### Files modified
- `packages/framework/src/lib/chat/mcp-tools/mcp-tool-types.ts`
- `packages/framework/src/lib/chat/mcp-tools/types.ts`
- `packages/framework/src/lib/chat/mcp-tools/index.ts`
- `packages/framework/src/lib/chat/mcp-tools/plugin.ts`
- `packages/framework/src/lib/chat/mcp-tools/plugin-executor.ts`
- `packages/framework/src/lib/chat/mcp-tools/bridge-runtime.ts`
- `packages/framework/src/lib/chat/mcp-tools/branch-runtime.ts`
- `packages/framework/src/lib/chat/mcp-tools/mock-runtime.ts`
- `packages/framework/src/lib/chat/mcp-tools/branch-mock.ts`
- `packages/framework/src/lib/chat/mcp-tools/session/types.ts`
- `packages/framework/src/lib/chat/mcp-tools/session/tool-session.ts`
- `packages/framework/src/lib/chat/mcp-tools/session/worker-types.ts`
- `packages/framework/src/lib/chat/mcp-tools/session/worker-runner.ts`
- `packages/framework/src/lib/chat/mcp-tools/session/worker-tool-session.ts`
- `packages/framework/src/lib/chat/mcp-tools/session-manager.ts`
- `packages/framework/src/lib/chat/mcp-tools/protocol/message-decoder.ts`
- `packages/framework/src/handler/durable/plugin-session-manager.ts`
- `packages/framework/src/lib/chat/mcp-tools/__tests__/plugin.test.ts`
- `packages/framework/src/lib/chat/mcp-tools/__tests__/builder.test.ts`
