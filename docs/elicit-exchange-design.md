# ElicitResult Exchange Design

## Overview

Add an `exchange` property to `ElicitResult` that captures the elicitation as a request/response message pair. This enables tools to accumulate elicitation exchanges as conversation history for sampling.

## Problem

When building multi-turn sampling flows (like the tictactoe demo), tools need to represent elicitation exchanges as messages. Currently:

1. The `Message` type only supports `role: 'user' | 'assistant' | 'system'` with string content
2. No support for `tool_calls`, `tool_call_id`, or `role: 'tool'`
3. Tools use `as any` to work around type limitations
4. No way to capture the context passed to `elicit()` for later use

## Solution

### Extended Message Types (MCP++)

The official MCP spec for `sampling/createMessage` only supports `TextContent | ImageContent | AudioContent`. We extend this with tool calling support (MCP++):

```typescript
export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

export interface AssistantToolCallMessage {
  role: 'assistant'
  content: string | null
  tool_calls: ToolCall[]
}

export interface ToolResultMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

export type ExtendedMessage = 
  | Message                    // Existing text messages
  | AssistantToolCallMessage   // Assistant with tool calls
  | ToolResultMessage          // Tool results
```

### ElicitExchange Type

```typescript
export interface ElicitExchange<TContext, TResponse> {
  /** The captured context from the elicit call */
  context: TContext
  
  /** The elicitation request (assistant message with tool_call) */
  request: AssistantToolCallMessage
  
  /** The user's response (tool result message) */
  response: ToolResultMessage
  
  /** Messages tuple [request, response] with empty arguments (safe default) */
  messages: [AssistantToolCallMessage, ToolResultMessage]
  
  /** 
   * Build messages with custom arguments derived from captured context.
   * Context is fully typed based on what was passed to elicit().
   */
  withArguments(
    fn: (context: TContext) => Record<string, unknown>
  ): [AssistantToolCallMessage, ToolResultMessage]
}
```

### Updated ElicitResult

```typescript
export type ElicitResult<TContext, TResponse> =
  | { 
      action: 'accept'
      content: TResponse
      exchange: ElicitExchange<TContext, TResponse>
    }
  | { action: 'decline' }
  | { action: 'cancel' }
```

## Design Decisions

### 1. Two Type Parameters

`ElicitResult<TContext, TResponse>` now requires both type parameters. This is a breaking change but provides full type safety.

### 2. Safe by Default

`exchange.messages` has empty tool call arguments - no accidental context leakage or sensitive data exposure.

### 3. Opt-in Context

`withArguments((ctx) => {...})` lets you explicitly derive what goes into the tool call arguments. The callback receives the fully typed context.

### 4. Monadic Pattern

The elicit result encapsulates everything it was called with - the context is captured on the exchange.

### 5. Tool Call ID Format

`elicit_${callId}_${seq}` - combines the tool call ID with the sequence number for uniqueness.

### 6. Function Name

Just the elicit key (e.g., `'pickMove'`), not the full tool name.

## Usage Example

```typescript
const result = yield* ctx.elicit('pickMove', { 
  message: "Your turn!", 
  board,        // Board type
  moveHistory,  // GameMove[] type
})

if (result.action === 'accept') {
  // Safe default - no context in arguments
  history.push(...result.exchange.messages)
  
  // Or with explicit derived context (fully typed)
  history.push(...result.exchange.withArguments((ctx) => ({
    moveNumber: ctx.moveHistory.length,
    boardState: formatBoard(ctx.board),
  })))
  
  // Access the raw context
  console.log('Board state:', result.exchange.context.board)
}
```

## Files to Modify

| File | Changes |
|------|---------|
| `packages/framework/src/lib/chat/mcp-tools/mcp-tool-types.ts` | Add extended message types, ElicitExchange, update ElicitResult |
| `packages/framework/src/lib/chat/mcp-tools/types.ts` | Mirror changes (legacy types file) |
| `packages/framework/src/lib/chat/mcp-tools/bridge-runtime.ts` | Construct exchange object in elicit handling |
| `packages/framework/src/lib/chat/mcp-tools/handler/session-manager.ts` | Construct exchange in handleElicitResponse |
| `packages/framework/src/lib/chat/mcp-tools/mock-runtime.ts` | Update mock to handle new type |
| `packages/framework/src/lib/chat/mcp-tools/branch-mock.ts` | Update mock to handle new type |
| `packages/framework/src/lib/chat/mcp-tools/branch-runtime.ts` | Update branch context elicit |
| `packages/framework/src/lib/chat/mcp-tools/session/*.ts` | Update session types and implementations |
| `packages/framework/src/handler/durable/*.ts` | Update durable handler types |
| Test files | Update fixtures and assertions |

## Breaking Changes

1. `ElicitResult<T>` → `ElicitResult<TContext, TResponse>` (two type params)
2. Accept variant now has required `exchange` property
3. Consumer code accessing `result.content` still works, but type inference may need updates
