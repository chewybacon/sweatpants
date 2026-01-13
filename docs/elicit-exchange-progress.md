# ElicitResult Exchange - Implementation Progress

## Status: In Progress

## Tasks

### Phase 1: Core Types
- [ ] Add extended message types to `mcp-tool-types.ts`
- [ ] Add `ElicitExchange` interface
- [ ] Update `ElicitResult` to two type params with exchange
- [ ] Update `ElicitConfig` if needed
- [ ] Update context interfaces (`McpToolContext`, `McpToolContextWithElicits`)

### Phase 2: Runtime Implementations
- [ ] Update `bridge-runtime.ts` - construct exchange in elicit handling
- [ ] Update `branch-runtime.ts` - construct exchange
- [ ] Update `session-manager.ts` - construct exchange in handleElicitResponse

### Phase 3: Session Layer
- [ ] Update `session/types.ts`
- [ ] Update `session/tool-session.ts`
- [ ] Update `session/worker-types.ts`
- [ ] Update `session/worker-runner.ts`
- [ ] Update `session/worker-tool-session.ts`

### Phase 4: Durable Handler
- [ ] Update `handler/durable/plugin-session-manager.ts`
- [ ] Update `handler/durable/chat-engine.ts`

### Phase 5: Mocks and Tests
- [ ] Update `mock-runtime.ts`
- [ ] Update `branch-mock.ts`
- [ ] Update test files
- [ ] Fix any type errors

### Phase 6: Legacy Types
- [ ] Update `types.ts` (legacy mirror)
- [ ] Update `plugin.ts` types
- [ ] Update `plugin-executor.ts`

### Phase 7: Validation
- [ ] Run `pnpm typecheck`
- [ ] Run tests
- [ ] Manual verification with tictactoe demo

## Notes

- Breaking change: `ElicitResult<T>` → `ElicitResult<TContext, TResponse>`
- No backward compatibility needed per user request
