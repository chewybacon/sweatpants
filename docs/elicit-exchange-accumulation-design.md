# Elicit Exchange Accumulation Design

## Overview

This document describes the design for accumulating elicit exchanges as conversation history in MCP tools, enabling models to see the full context of prior interactions when making decisions.

## Motivation

The `ElicitExchange` feature captures elicitations as request/response message pairs. The next step is to **use these exchanges** by passing them to sampling calls, giving the model visibility into game/conversation history.

### Use Case: TicTacToe

The tictactoe tool alternates between:
1. **Model turns**: `ctx.sample()` to get the model's move
2. **User turns**: `ctx.elicit()` to get the user's move

Currently, each sample call is stateless - the model doesn't see prior moves. By accumulating exchanges, the model can:
- See what moves were made
- Reason about game state over multiple turns
- Make more informed decisions

## Design

### Core Concept

Accumulate all message history within a tool's execution:
1. **Elicit exchanges**: Use `result.exchange.withArguments()` to build rich context messages
2. **Sample turns**: Add prompt/response as user/assistant messages
3. **Pass to sample**: Include accumulated history in `ctx.sample({ messages: [...history, newPrompt] })`

### Message Flow

```
Turn 1 (Model):
  sample({ messages: [prompt1] }) -> response1
  history = [prompt1, response1]

Turn 2 (User):
  elicit('pickMove', context) -> result
  exchangeMessages = result.exchange.withArguments(fn)
  history = [...history, ...exchangeMessages]

Turn 3 (Model):
  sample({ messages: [...history, prompt2] }) -> response2
  history = [...history, prompt2, response2]

... and so on
```

### Type Changes

#### `SampleConfigMessagesMode` (mcp-tool-types.ts)

Change from:
```typescript
interface SampleConfigMessagesMode {
  messages: Message[]  // Basic messages only
}
```

To:
```typescript
interface SampleConfigMessagesMode {
  messages: ExtendedMessage[]  // Includes tool_calls and tool results
}
```

This allows passing elicit exchanges (which are `AssistantToolCallMessage` + `ToolResultMessage`) to sample calls.

### `withArguments` Usage

The `ElicitExchange.withArguments(fn)` method builds messages with derived arguments:

```typescript
if (result.action === 'accept') {
  const messages = result.exchange.withArguments((context) => ({
    // Derive arguments from the captured context
    board: formatBoard(context.board),
    userSymbol: context.userSymbol,
    userSelectedPosition: result.content.position,
    moveNumber: context.moveHistory.length + 1,
  }))
  
  conversationHistory.push(...messages)
}
```

This produces:
1. `AssistantToolCallMessage` with the derived arguments in `tool_calls[0].function.arguments`
2. `ToolResultMessage` with the user's response content

### TicTacToe Implementation

```typescript
*client(handoff, ctx) {
  const { modelSymbol, userSymbol } = handoff
  let board: Board = [...EMPTY_BOARD]
  const conversationHistory: ExtendedMessage[] = []

  while (true) {
    const isModelTurn = currentPlayer === modelSymbol

    if (isModelTurn) {
      // Sample with full conversation history
      const prompt = `Your turn as ${modelSymbol}. Board:\n${formatBoard(board)}\n...`
      
      const response = yield* ctx.sample({
        messages: [
          ...conversationHistory,
          { role: 'user', content: prompt }
        ],
      })

      // Add to history
      conversationHistory.push(
        { role: 'user', content: prompt },
        { role: 'assistant', content: response.text }
      )
      
      // ... parse and apply move ...
      
    } else {
      // Elicit user's move
      const result = yield* ctx.elicit('pickMove', {
        message: `Your turn as ${userSymbol}`,
        board,
        moveHistory,
        modelSymbol,
        userSymbol,
      })

      if (result.action === 'accept') {
        // Capture exchange in history
        const messages = result.exchange.withArguments((ctx) => ({
          board: formatBoard(ctx.board),
          userSymbol: ctx.userSymbol,
          userSelectedPosition: result.content.position,
          moveNumber: ctx.moveHistory.length + 1,
        }))
        conversationHistory.push(...messages)
        
        // ... apply move ...
      }
    }
  }
}
```

### Downstream Compatibility

The `Message` type in `lib/chat/types.ts` already supports:
- `tool_calls?: Array<{...}>`
- `tool_call_id?: string`
- `role: 'tool'`

So providers (OpenAI, Ollama) should handle extended messages transparently.

## Testing Strategy

### Unit Test (bridge-runtime.test.ts)

Test that:
1. Exchange is captured correctly after elicit
2. `withArguments()` produces correct message format
3. Extended messages can be passed to sample
4. Sampling provider receives the full history

### E2E Test (tictactoe.spec.ts)

Verify:
1. Game still works correctly
2. Multiple moves progress without errors
3. (Optionally) Model behavior shows awareness of history

## Files to Modify

1. `packages/framework/src/lib/chat/mcp-tools/mcp-tool-types.ts`
   - Update `SampleConfigMessagesMode.messages` to `ExtendedMessage[]`

2. `packages/framework/src/lib/chat/mcp-tools/bridge-runtime.ts`
   - Update type annotations for extended messages

3. `packages/framework/src/lib/chat/mcp-tools/__tests__/bridge-runtime.test.ts`
   - Add exchange accumulation tests

4. `apps/yo-chat/src/tools/tictactoe/tool.ts`
   - Implement conversation history accumulation

## Non-Goals

- **MCP++ for model sampling**: We intentionally use plain user/assistant messages for model turns (MCP standard), not tool-call format
- **Automatic history tracking**: The tool author explicitly manages history accumulation
- **System prompt changes**: Keep prompts simple; let the history speak for itself

## Outcome

The feature is now implemented and working. Here's a simplified version of how exchange accumulation works in the TicTacToe tool.

### Simplified Tool Pattern

```typescript
import { type ExtendedMessage } from '@sweatpants/framework/chat'

*client(handoff, ctx) {
  const conversationHistory: ExtendedMessage[] = []
  
  while (gameOngoing) {
    if (isModelTurn) {
      // Model samples with full history
      const prompt = `Pick a move. Board:\n${formatBoard(board)}`
      const response = yield* ctx.sample({
        messages: [...conversationHistory, { role: 'user', content: prompt }],
      })
      
      // Accumulate this exchange
      conversationHistory.push(
        { role: 'user', content: prompt },
        { role: 'assistant', content: response.text }
      )
    } else {
      // User elicit
      const result = yield* ctx.elicit('pickMove', { board, moveHistory, ... })
      
      if (result.action === 'accept') {
        // Capture exchange with enriched arguments
        conversationHistory.push(
          ...result.exchange.withArguments((ctx) => ({
            boardState: formatBoard(ctx.board),
            userMove: result.content.position,
          }))
        )
      }
    }
  }
}
```

### Resulting Conversation History

After 3 turns (model, user, model), the accumulated history looks like:

```
[0] { role: 'user', content: 'Pick a move. Board:\n0 | 1 | 2\n---------\n3 | 4 | 5\n...' }
[1] { role: 'assistant', content: '4' }
[2] { role: 'assistant', content: null, tool_calls: [{ 
       id: 'elicit_1', 
       type: 'function',
       function: { 
         name: 'pickMove', 
         arguments: { boardState: '0 | 1 | 2\n...\n3 | X | 5\n...', userMove: 0 } 
       }
     }] 
   }
[3] { role: 'tool', tool_call_id: 'elicit_1', content: '{"position":0}' }
[4] { role: 'user', content: 'Pick a move. Board:\nX | 1 | 2\n---------\n3 | X | 5\n...' }
[5] { role: 'assistant', content: '2' }
```

### Key Benefits

1. **Full context**: The model sees all previous moves - both its own (as user/assistant pairs) and the user's (as tool-call exchanges)

2. **Explicit control**: Tool authors decide exactly what context to expose via `withArguments()`. No automatic leaking of internal state.

3. **Mixed formats work**: Plain messages and tool-call messages interleave naturally. LLM providers handle both.

4. **Type-safe**: `ExtendedMessage[]` is properly typed, `withArguments()` callback receives fully typed context.

### Implementation Details

See `apps/yo-chat/src/tools/tictactoe/tool.ts` for the full implementation.

Key changes from the original tool:
- Added `conversationHistory: ExtendedMessage[]` accumulator
- Model turns use `messages` mode instead of `prompt` mode
- User turns capture exchanges with `withArguments()`
- Both add to the same history array
