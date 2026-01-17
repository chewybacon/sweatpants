# MCP Spec Alignment - Context Notes

This document captures the full context of our design discussion for future reference.

---

## Background: MCP 2025-11-25 Spec Changes

The MCP specification (2025-11-25) introduced several features that affect our design:

### Tools in Sampling

The spec now supports tools in `sampling/createMessage`:

```typescript
interface CreateMessageRequestParams {
  messages: SamplingMessage[]
  tools?: Tool[]           // NEW in 2025-11-25
  toolChoice?: ToolChoice  // NEW in 2025-11-25
  // ...
}
```

Clients declare support via `sampling.tools` capability.

### Message Content Blocks

MCP uses content blocks instead of OpenAI-style message format:

- `ToolUseContent` - Assistant requesting a tool call
- `ToolResultContent` - Result provided back to assistant

Key constraint from spec:
> every assistant message containing `ToolUseContent` blocks **MUST** be followed by a user message that consists entirely of `ToolResultContent` blocks

### Elicitation Modes

MCP 2025-11-25 adds URL mode elicitation for sensitive data:
- `mode: 'form'` - Standard form-based elicitation
- `mode: 'url'` - Redirect to URL for sensitive interactions (OAuth, payments)

Sweatpants does not support URL mode - we'll throw an error if attempted.

---

## Key Design Decisions

### 1. Message Format: MCP Content Blocks

**Decision**: Switch from OpenAI-style to MCP content blocks.

**Rationale**: 
- Align with MCP spec
- Single format throughout the codebase
- Breaking change is acceptable

**Before (OpenAI-style)**:
```typescript
{ role: 'assistant', content: null, tool_calls: [...] }
{ role: 'tool', tool_call_id: 'xxx', content: '...' }
```

**After (MCP-style)**:
```typescript
{ role: 'assistant', content: [{ type: 'tool_use', ... }] }
{ role: 'user', content: [{ type: 'tool_result', ... }] }
```

### 2. Structured Output: `__schema__` Meta-Tool

**Decision**: Use a reserved tool name `__schema__` for structured output.

**Rationale**:
- MCP doesn't have native schema support
- Different providers implement structured output differently
- Using a tool is the "lowest common denominator" that always works
- Smart clients can intercept `__schema__` and use native provider features
- Dunder naming (`__schema__`) prevents collision with user tools

**How it works**:
1. Server sends `tools: [{ name: '__schema__', inputSchema }]`
2. Client either:
   - Uses native structured output (OpenAI, Ollama) and packages as tool_use
   - Falls through to normal tool calling (works with any client)
3. Server receives tool_use with data in `input` field
4. Server extracts and validates the data

### 3. Exchange Model: Representing Data Flow

**Decision**: Exchanges represent **data flow**, not pedantic wire reality.

**Key insight**: The exchange is faked/constructed to correctly represent the interaction for context history purposes.

**Raw sampling**:
- Wire: 1 message (assistant response)
- Exchange: `[request, response]` = 2 messages

**Structured output**:
- Wire: 1 message (assistant tool_use)
- Exchange: `[request, toolUse, toolResult]` = 3 messages
- We construct the `toolResult` as acknowledgment

**Why 3 messages for structured output**:
- MCP requires tool_use to be followed by tool_result
- If you accumulate just `[request, toolUse]`, the context is malformed
- The 3-message form is "closed" and ready for accumulation

### 4. `SampleExchange` Type Design

**Decision**: Simple, flexible type with `request`, `response`, `messages`, `parsed`.

```typescript
interface SampleExchange<TParsed = undefined> {
  request: McpMessage
  response: McpMessage
  messages: McpMessage[]  // Just an array, not union type
  parsed?: TParsed
}
```

**Rationale**:
- `request` and `response` allow edge case handling
- `messages` is what you spread into history (most common use)
- `parsed` is the structured data (when schema was used)
- Not over-engineering the types - `messages` is just an array

**Consumer patterns**:
```typescript
// Most common: accumulate into history
conversationHistory.push(...result.exchange.messages)

// Get structured data
const move = result.exchange.parsed

// Edge case: custom handling
const { request, response } = result.exchange
```

### 5. Handoff Pattern: Stays As-Is

**Decision**: The handoff pattern (`before/client/after`) is a sweatpants invention and has no MCP equivalent.

**Context**: We explored whether MCP Tasks (new in 2025-11-25) relates to handoff:
- MCP Tasks = async/deferred execution with polling
- Handoff = structured execution phases for client interaction

They solve different problems and could work together (a handoff tool could be a Task), but handoff is purely a sweatpants application-level pattern.

---

## Wire Format Details

### Sampling Request

```typescript
{
  jsonrpc: '2.0',
  id: 1,
  method: 'sampling/createMessage',
  params: {
    messages: [{ role: 'user', content: [{ type: 'text', text: '...' }] }],
    tools: [{ name: '__schema__', inputSchema: {...} }],  // For structured output
    toolChoice: { mode: 'required' },                      // For structured output
    maxTokens: 4096
  }
}
```

### Sampling Response (Always 1 Message)

```typescript
{
  jsonrpc: '2.0',
  id: 1,
  result: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'xxx', name: '__schema__', input: {...} }],
    model: 'claude-3-sonnet',
    stopReason: 'toolUse'
  }
}
```

### Constructed Exchange (3 Messages for Structured Output)

```typescript
[
  // 1. Request (what we sent)
  { role: 'user', content: [{ type: 'text', text: 'Pick your move' }] },
  
  // 2. Response (assistant's tool_use - from wire)
  { role: 'assistant', content: [{ type: 'tool_use', id: 'xxx', name: '__schema__', input: {...} }] },
  
  // 3. Ack (we construct this)
  { role: 'user', content: [{ type: 'tool_result', toolUseId: 'xxx', content: [{ type: 'text', text: 'ok' }] }] }
]
```

---

## Token Efficiency Consideration

**Problem**: If we echo the tool call args into the tool_result, that duplicates tokens.

**Solution**: Use minimal acknowledgment in tool_result:
```typescript
{ type: 'tool_result', toolUseId: 'xxx', content: [{ type: 'text', text: 'ok' }] }
```

The data only appears once (in the tool_use `input`), not duplicated.

---

## Comparison: ElicitExchange vs SampleExchange

| Aspect | ElicitExchange | SampleExchange |
|--------|----------------|----------------|
| **Trigger** | `ctx.elicit()` | `ctx.sample()` |
| **Direction** | Server → User → Server | Server → Model → Server |
| **request** | Assistant's elicit tool_call | User message to model |
| **response** | User's form response | Assistant's response |
| **messages** | Always 2 | 2 (raw) or 3 (structured) |
| **parsed** | Via `result.content` | Via `exchange.parsed` |
| **context** | Captured from elicit args | N/A |
| **withArguments** | Transform context for history | N/A |

---

## Files Affected Summary

### Core Changes
- `mcp-tool-types.ts` - Types, `SampleExchange`
- `protocol/message-encoder.ts` - Encoding, URL guard
- `protocol/message-decoder.ts` - Decoding
- `bridge-runtime.ts` - `__schema__`, exchanges
- `branch-runtime.ts` - Same as bridge

### Supporting Changes
- `session/worker-runner.ts`
- `handler/session-manager.ts`
- `plugin-tool-executor.ts`
- `plugin-session-manager.ts`

### Tests
- All tests asserting on message format
- Structured output tests

### Apps
- `tictactoe/tool.ts` - Uses `ExtendedMessage`

---

## Open Questions (Resolved)

1. **Message format alignment** - Clean break, no deprecation ✓
2. **`__schema__` naming** - Dunder convention to avoid collision ✓
3. **Schema result extraction** - Extract from `toolUse.input`, validate, include in exchange ✓
4. **Exchange type complexity** - Keep simple: `messages: McpMessage[]` ✓
5. **Token duplication** - Minimal "ok" ack, no data echo ✓
