# Elicit Exchange Accumulation - Progress

## Status: Complete

## Overview

Implemented conversation history accumulation using elicit exchanges in the tictactoe tool as a showcase. The model now sees the full game progression when making decisions.

## Tasks

### Phase 1: Enable ExtendedMessage in Sample Config
- [x] Update `SampleConfigMessagesMode.messages` type to `ExtendedMessage[]`
- [x] Update `bridge-runtime.ts` type annotations
- [x] Update `branch-runtime.ts` type annotations
- [x] Update session types (`RawElicitResult` for transport layer)
- [x] Update worker types and runner
- [x] Update durable handler types
- [x] Verify downstream compatibility

### Phase 2: Unit Tests
- [x] Add exchange accumulation test to `bridge-runtime.test.ts`
- [x] Test `withArguments()` produces correct message format
- [x] Test extended messages flow through to sampling provider
- [x] Test declined elicits don't include exchange
- [x] Run tests to verify (all 722 tests pass)

### Phase 3: Update TicTacToe Tool
- [x] Export `ExtendedMessage` from `@sweatpants/framework/chat`
- [x] Add `conversationHistory: ExtendedMessage[]` accumulator
- [x] Capture model sampling turns in history
- [x] Capture elicit exchanges using `withArguments()`
- [x] Pass history to sample calls

### Phase 4: E2E Validation
- [x] Run existing framework tests (722 passed)
- [x] TypeScript compilation passes for yo-chat

### Phase 5: Cleanup
- [x] Update progress documentation
- [x] Update design documentation with Outcome section

## Summary

### Files Modified

**Type System Updates:**
- `packages/framework/src/lib/chat/mcp-tools/bridge-runtime.ts` - ExtendedMessage in sample, RawElicitResult for transport
- `packages/framework/src/lib/chat/mcp-tools/branch-runtime.ts` - ExtendedMessage support
- `packages/framework/src/lib/chat/mcp-tools/session/types.ts` - RawElicitResult
- `packages/framework/src/lib/chat/mcp-tools/session/tool-session.ts` - RawElicitResult
- `packages/framework/src/lib/chat/mcp-tools/session/worker-tool-session.ts` - RawElicitResult
- `packages/framework/src/lib/chat/mcp-tools/session/worker-types.ts` - RawElicitResult
- `packages/framework/src/lib/chat/mcp-tools/session/worker-runner.ts` - Exchange construction
- `packages/framework/src/handler/durable/plugin-session-manager.ts` - RawElicitResult
- `packages/framework/src/handler/durable/plugin-tool-executor.ts` - ExtendedMessage

**Exports:**
- `packages/framework/src/lib/chat/index.ts` - Export ExtendedMessage, AssistantToolCallMessage, ToolResultMessage, ToolCall

**Tests:**
- `packages/framework/src/lib/chat/mcp-tools/__tests__/bridge-runtime.test.ts` - Exchange accumulation tests

**Showcase:**
- `apps/yo-chat/src/tools/tictactoe/tool.ts` - Full implementation with history accumulation

### Key Design Decisions

1. **RawElicitResult for transport**: Transport layers (workers, durable handlers) return just `{ action, content }`. The bridge-runtime constructs the full `ElicitResult` with exchange since it has access to the original context.

2. **ExtendedMessage type**: Union of `Message | AssistantToolCallMessage | ToolResultMessage` - allows mixing regular chat messages with tool interactions in conversation history.

3. **withArguments() pattern**: Opt-in context exposure. By default, exchanges have empty arguments. Tool authors explicitly derive what context to expose to the model.

4. **Mixed message formats**: Model sampling uses plain user/assistant messages (MCP standard). Elicit exchanges use tool-call format. Both work together in the accumulated history.

## Notes

- Using test-first approach for fast feedback
- TicTacToe is the showcase tool for this feature
- Model sampling uses plain messages (MCP standard), elicit exchanges use tool-call format
- All 722 framework tests pass
