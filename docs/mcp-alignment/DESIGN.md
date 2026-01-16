# MCP Spec Alignment - Design Document

## Overview

This document describes the design for aligning sweatpants with the MCP 2025-11-25 specification, including breaking changes to message format, adding the `__schema__` meta-tool pattern for structured output, and introducing `SampleExchange` for history accumulation.

## Goals

1. **Message format alignment** - Switch from OpenAI-style to MCP content blocks
2. **URL elicitation guard** - Throw clear error if `mode: 'url'` is attempted
3. **`__schema__` meta-tool pattern** - Convert `ctx.sample({ schema })` to a reserved tool
4. **`SampleExchange` type** - Parallel to `ElicitExchange`, captures sampling as accumulate-able exchanges

## Non-Goals

1. **Handoff pattern changes** - Stays as-is (sweatpants invention, no MCP equivalent)
2. **MCP Tasks integration** - Future work, not part of this change
3. **Full URL elicitation support** - Just error handling for now

---

## MCP Standard vs Sweatpants Extensions

### Standard MCP Features (`ctx.*`)

| Feature | MCP Method | Notes |
|---------|-----------|-------|
| `ctx.sample()` | `sampling/createMessage` | Standard sampling |
| `ctx.sample({ tools, toolChoice })` | `sampling/createMessage` | Tool calling in sampling (new in 2025-11-25) |
| `ctx.elicit()` | `elicitation/create` | Form mode only |
| `ctx.log()` | `notifications/message` | Standard logging |
| `ctx.notify()` | `notifications/progress` | Standard progress |

### Sweatpants Extensions

| Feature | Description |
|---------|-------------|
| `ctx.branch()` | Structured concurrency (sub-branches) |
| `ctx.sampleTools()` | Guaranteed tool calls with retry |
| `ctx.sampleSchema()` | Guaranteed parsed output with retry |
| `ctx.sample({ schema })` | Uses `__schema__` meta-tool pattern |
| Keyed elicits | `.elicits({ key: schema })` - Type-safe UI bridging |
| `ElicitExchange` | History accumulation for elicitation context |
| `SampleExchange` | History accumulation for sampling context (new) |
| Handoff pattern | `before/client/after` phases for tool execution |

### Reserved Tool Names

| Name | Purpose |
|------|---------|
| `__schema__` | Structured output meta-tool (clients implement per-provider) |

---

## Part 1: Message Format Alignment

### Current Format (OpenAI-style)

```typescript
// Assistant with tool calls
{ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments } }] }

// Tool result
{ role: 'tool', tool_call_id: 'xxx', content: '...' }
```

### Target Format (MCP content blocks)

```typescript
// Assistant with tool use
{ role: 'assistant', content: [{ type: 'tool_use', id: 'xxx', name: '...', input: {...} }] }

// Tool result (in user message)
{ role: 'user', content: [{ type: 'tool_result', toolUseId: 'xxx', content: [...] }] }
```

### Key Differences

| Aspect | OpenAI Style | MCP Style |
|--------|--------------|-----------|
| Tool calls | `tool_calls` array on message | `tool_use` content blocks |
| Tool results | `role: 'tool'` | `role: 'user'` with `tool_result` content |
| Tool call ID | `tool_call_id` | `toolUseId` |

---

## Part 2: URL Elicitation Guard

MCP 2025-11-25 introduces URL mode elicitation for sensitive data flows (OAuth, payments, etc.). Sweatpants does not currently support this.

### Implementation

Add validation in the elicitation encoder:

```typescript
export function encodeElicitationRequest(event, requestId) {
  if ((event as any).mode === 'url') {
    throw new Error(
      'URL elicitation mode is not supported by sweatpants. ' +
      'Use form mode (default) instead. ' +
      'See: https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation'
    )
  }
  // ... rest of encoding
}
```

---

## Part 3: `__schema__` Meta-Tool Pattern

### Problem

MCP doesn't have a native `schema` parameter for sampling. Different providers implement structured output differently:

- **OpenAI**: Native `response_format.json_schema` (streaming structured output)
- **Anthropic**: Tool-calling workaround
- **Ollama**: Native `format` parameter

### Solution

Use a reserved tool name `__schema__` that clients can implement optimally per provider.

### Server Side (Tool Author)

When `ctx.sample({ schema })` is called:

1. Convert schema to `__schema__` tool
2. Send sampling request with `tools: [__schema__]`, `toolChoice: 'required'`
3. Receive response (tool_use with data in `input`)
4. Extract, validate, and construct `SampleExchange`

### Wire Format (MCP Compliant)

**Request:**
```typescript
{
  method: 'sampling/createMessage',
  params: {
    messages: [...],
    tools: [{
      name: '__schema__',
      description: 'Respond with structured data matching this schema.',
      inputSchema: { /* JSON Schema */ }
    }],
    toolChoice: { mode: 'required' }
  }
}
```

**Response (always 1 message over wire):**
```typescript
{
  role: 'assistant',
  content: [{
    type: 'tool_use',
    id: 'call_xxx',
    name: '__schema__',
    input: { /* parsed data */ }
  }],
  stopReason: 'toolUse'
}
```

### Client Side (MCP Host)

When a client sees `__schema__` in tools:

- **Smart client (sweatpants)**: Use best provider implementation, return as tool_use
- **Naive client**: Pass through as normal tool, model calls it, works anyway

The server code works identically either way. The only difference is efficiency on the client side.

---

## Part 4: `SampleExchange` Type

### Design Principles

The exchange is a **representation of the interaction for context history**. It's not a pedantic record of what went over the wire. It models the data flow correctly so the context window makes sense.

### Exchange Model

An exchange is always conceptually `[request, response]`:

- **Raw sampling**: `[userMessage, assistantMessage]` = 2 messages
- **Structured output**: `[userMessage, assistantToolUse, toolResult]` = 3 messages

For structured output, the "response" is split into 2 messages (tool_use + tool_result) to be MCP-compliant (tool_use MUST be followed by tool_result).

### Type Definition

```typescript
interface SampleExchange<TParsed = undefined> {
  /** The request message we sent */
  request: McpMessage
  
  /** The assistant's response message */
  response: McpMessage
  
  /** All messages for history accumulation (2 for raw, 3 for structured) */
  messages: McpMessage[]
  
  /** Parsed structured data (only present when schema was used) */
  parsed?: TParsed
}
```

### Field Semantics

| Field | Raw Sample | Structured Output |
|-------|------------|-------------------|
| `request` | User message | User message |
| `response` | Assistant text message | Assistant tool_use message |
| `messages` | `[request, response]` (2) | `[request, toolUse, toolResult]` (3) |
| `parsed` | `undefined` | Extracted/validated data |

### Consumer Patterns

```typescript
// Accumulate into history (most common)
conversationHistory.push(...result.exchange.messages)

// Get structured data
const move = result.exchange.parsed

// Edge case: only want request/response
const { request, response } = result.exchange
```

### Comparison with ElicitExchange

| Aspect | ElicitExchange | SampleExchange |
|--------|----------------|----------------|
| **Purpose** | Capture elicitation interaction | Capture sampling interaction |
| **request** | Assistant's elicit tool_call | User message sent to model |
| **response** | User's form response | Assistant's response |
| **messages** | Always 2 | 2 (raw) or 3 (structured) |
| **parsed** | Via `result.content` | Via `exchange.parsed` |

---

## Wire Format Summary

### Raw Sampling

```
Request:  [user message]  →  sampling/createMessage
Response: [assistant message]  ←  1 message over wire
Exchange: [request, response]  =  2 messages for history
```

### Structured Output (`__schema__`)

```
Request:  [user message + __schema__ tool]  →  sampling/createMessage
Response: [assistant tool_use]  ←  1 message over wire
Exchange: [request, toolUse, toolResult]  =  3 messages for history
          (we construct toolResult as ack)
```

---

## Breaking Changes

This is a **breaking change** affecting:

1. **`ExtendedMessage` type** - Now uses MCP content blocks
2. **`AssistantToolCallMessage`** - Removed, use `McpMessage` with `tool_use` content
3. **`ToolResultMessage`** - Removed, use `McpMessage` with `tool_result` content
4. **Exchange message format** - All exchanges use MCP format

### Migration

Users of `ExtendedMessage` will need to update their code to use MCP content block format instead of OpenAI-style `tool_calls` arrays.
