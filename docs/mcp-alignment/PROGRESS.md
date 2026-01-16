# MCP Spec Alignment - Implementation Progress

## Status: Planning Complete

Last Updated: 2025-01-16

---

## Phases

### Phase 1: Core Type Changes
- [ ] Update `McpMessage` and content block types in `protocol/types.ts`
- [ ] Remove `AssistantToolCallMessage`, `ToolResultMessage`, `ToolCall` from `mcp-tool-types.ts`
- [ ] Update `ExtendedMessage` to use `McpMessage`
- [ ] Add `SampleExchange` type
- [ ] Update `ElicitExchange` to use MCP format

### Phase 2: Protocol Layer
- [ ] Update `message-encoder.ts` - encode tool_use/tool_result content blocks
- [ ] Update `message-encoder.ts` - add URL elicitation guard
- [ ] Update `message-encoder.ts` - remove `metadata.responseSchema` path
- [ ] Update `message-decoder.ts` - decode tool_use/tool_result content blocks

### Phase 3: Runtime Layer
- [ ] Update `bridge-runtime.ts` - `__schema__` transformation
- [ ] Update `bridge-runtime.ts` - `SampleExchange` construction
- [ ] Update `bridge-runtime.ts` - `ElicitExchange` to MCP format
- [ ] Update `branch-runtime.ts` - same changes as bridge-runtime
- [ ] Update `session/worker-runner.ts` - message format
- [ ] Update `handler/session-manager.ts` - message format

### Phase 4: Plugin/Handler Layer
- [ ] Update `handler/durable/plugin-tool-executor.ts`
- [ ] Update `handler/durable/plugin-session-manager.ts`

### Phase 5: Re-exports
- [ ] Update `mcp-tools/types.ts`
- [ ] Update `lib/chat/index.ts`

### Phase 6: Tests
- [ ] Update `__tests__/bridge-runtime.test.ts`
- [ ] Update `protocol/__tests__/protocol.test.ts`
- [ ] Update `__tests__/sampling-structured.test.ts`
- [ ] Update other affected test files

### Phase 7: Apps
- [ ] Update `apps/yo-chat/src/tools/tictactoe/tool.ts`
- [ ] Verify all apps compile and tests pass

### Phase 8: Documentation
- [ ] Add inline documentation to types
- [ ] Update any existing docs

---

## Files to Change

### Package: `packages/framework/src/lib/chat/mcp-tools/`

| File | Status | Changes |
|------|--------|---------|
| `mcp-tool-types.ts` | ⬜ | Update types, add `SampleExchange`, add docs |
| `protocol/types.ts` | ⬜ | Already has MCP types ✓ |
| `protocol/message-encoder.ts` | ⬜ | URL guard, message encoding, remove schema metadata |
| `protocol/message-decoder.ts` | ⬜ | Handle tool_use/tool_result content blocks |
| `bridge-runtime.ts` | ⬜ | `__schema__`, `SampleExchange`, message format |
| `branch-runtime.ts` | ⬜ | Same as bridge-runtime |
| `session/types.ts` | ⬜ | May need updates |
| `session/worker-runner.ts` | ⬜ | Message format |
| `handler/session-manager.ts` | ⬜ | Message format |
| `types.ts` | ⬜ | Update re-exports |

### Package: `packages/framework/src/lib/chat/`

| File | Status | Changes |
|------|--------|---------|
| `index.ts` | ⬜ | Update re-exports |

### Package: `packages/framework/src/handler/durable/`

| File | Status | Changes |
|------|--------|---------|
| `plugin-tool-executor.ts` | ⬜ | ExtendedMessage handling |
| `plugin-session-manager.ts` | ⬜ | tool_calls handling |

### Tests

| File | Status | Changes |
|------|--------|---------|
| `__tests__/bridge-runtime.test.ts` | ⬜ | Message format assertions |
| `protocol/__tests__/protocol.test.ts` | ⬜ | Encoding/decoding tests |
| `__tests__/sampling-structured.test.ts` | ⬜ | Schema sampling tests |
| Other test files | ⬜ | TBD based on failures |

### Apps

| File | Status | Changes |
|------|--------|---------|
| `apps/yo-chat/src/tools/tictactoe/tool.ts` | ⬜ | ExtendedMessage usage |

---

## Verification Checklist

- [ ] All TypeScript compiles without errors
- [ ] All unit tests pass
- [ ] All e2e tests pass
- [ ] Manual testing with yo-chat app
- [ ] Manual testing with yo-mcp app

---

## Notes

- This is a breaking change - no deprecation warnings, clean break
- The `__schema__` tool name uses dunder convention to avoid collision with user tools
- Wire format is always MCP-compliant
- Exchanges are "faked" to represent correct data flow for context history
