# Sampling with Tools and Structured Output

## Overview

This document describes the design for adding tools and structured output support to MCP sampling (`ctx.sample()`). This enables tool authors to get structured responses from LLM calls within their tools, supporting both one-shot structured output and multi-turn tool-calling patterns.

## Motivation

Currently, `ctx.sample()` only returns unstructured text. For tools like TicTacToe that need structured moves, or agentic tools that need to call sub-tools, authors must parse text with regex or hope the model follows instructions. This is fragile.

**Problems with current approach:**
- No guaranteed structure - model might not output valid JSON
- No type safety - parsed results are untyped
- No tool calling - can't implement agentic loops within a tool

**Solution:**
- Add `schema` for one-shot structured output (parsed and validated)
- Add `tools` + `toolChoice` for multi-turn tool calling patterns
- Type-safe end-to-end with generics

## Design

### Two Modes (Mutually Exclusive)

| Mode | Config | Use Case | Provider Feature |
|------|--------|----------|------------------|
| **Structured Output** | `schema: z.ZodType` | One-shot structured response | OpenAI `response_format`, Anthropic tool trick |
| **Tool Calling** | `tools: [...], toolChoice` | Multi-turn with call/result/continue | Native tool calling |

If both `schema` and `tools` are provided, the implementation will throw an error.

### API Surface

#### Tool Definition

```typescript
interface ToolDefinition {
  name: string
  description?: string
  inputSchema: z.ZodType | Record<string, unknown>
}

interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}
```

#### Sample Config (Mutually Exclusive Variants)

```typescript
interface SampleConfigBase {
  systemPrompt?: string
  maxTokens?: number
  modelPreferences?: ModelPreferences
}

interface SampleConfigWithSchema<T> extends SampleConfigBase {
  schema: z.ZodType<T>
  tools?: never
  toolChoice?: never
}

interface SampleConfigWithTools extends SampleConfigBase {
  tools: ToolDefinition[]
  toolChoice?: 'auto' | 'required' | 'none'
  schema?: never
}

interface SampleConfigPlain extends SampleConfigBase {
  schema?: never
  tools?: never
  toolChoice?: never
}
```

#### Sample Result

```typescript
interface SampleResultBase {
  text: string
  model?: string
  stopReason?: 'endTurn' | 'maxTokens' | 'toolUse' | string
}

interface SampleResultWithParsed<T> extends SampleResultBase {
  parsed: T | null
  parseError?: {
    message: string
    rawText: string
  }
}

interface SampleResultWithToolCalls extends SampleResultBase {
  toolCalls: ToolCall[]
}
```

#### ctx.sample() Overloads

```typescript
interface McpToolContext {
  // Plain sample - just text
  sample(config: SampleConfigPlain & { prompt: string }): Operation<SampleResultBase>
  sample(config: SampleConfigPlain & { messages: Message[] }): Operation<SampleResultBase>
  
  // With schema - returns parsed (type-safe)
  sample<T>(config: SampleConfigWithSchema<T> & { prompt: string }): Operation<SampleResultWithParsed<T>>
  sample<T>(config: SampleConfigWithSchema<T> & { messages: Message[] }): Operation<SampleResultWithParsed<T>>
  
  // With tools - returns toolCalls
  sample(config: SampleConfigWithTools & { prompt: string }): Operation<SampleResultWithToolCalls>
  sample(config: SampleConfigWithTools & { messages: Message[] }): Operation<SampleResultWithToolCalls>
}
```

### Usage Examples

#### Structured Output (TicTacToe)

```typescript
const MoveSchema = z.object({ 
  cell: z.number().min(0).max(8),
  reasoning: z.string().optional(),
})

const response = yield* ctx.sample({
  messages,
  schema: MoveSchema,
})

if (response.parseError) {
  // Handle invalid response
  console.log('Raw:', response.parseError.rawText)
  return { error: 'Invalid move from model' }
}

// response.parsed is typed as { cell: number, reasoning?: string }
const cell = response.parsed!.cell
board[cell] = 'X'
```

#### Tool Calling (LLM-Driven Flow Control)

The primary use case for tool calling within `ctx.sample()` is **LLM-driven decision trees**. 
Rather than asking the LLM for a JSON enum, we leverage the model's tool-calling training to 
make structured decisions with branch-specific arguments.

**Why this works better than schema for decisions:**
1. **Leverages tool-calling training** - Models are extensively trained on when to call which tool
2. **Richer per-decision context** - Each branch can have its own argument schema
3. **Multi-turn continuation** - Can walk decision trees by swapping tools at each level

```typescript
// Level 1: High-level strategy decision
const strategy = yield* ctx.sample({
  prompt: `Board:\n${formatBoard(board)}\nChoose your strategy.`,
  tools: [
    { name: 'play_offensive', inputSchema: z.object({ reasoning: z.string() }) },
    { name: 'play_defensive', inputSchema: z.object({ threat: z.string() }) },
  ],
  toolChoice: 'required',
})

const strategyCall = strategy.toolCalls[0]

// Level 2: Specific move based on strategy (multi-turn with tool result)
const move = yield* ctx.sample({
  messages: [
    { role: 'user', content: `Board:\n${formatBoard(board)}` },
    { role: 'assistant', tool_calls: [{ id: strategyCall.id, type: 'function', function: { name: strategyCall.name, arguments: strategyCall.arguments } }] },
    { role: 'tool', tool_call_id: strategyCall.id, content: `Playing ${strategyCall.name}. Now pick your cell.` },
  ],
  schema: z.object({ cell: z.number().min(0).max(8) }),
})

const cell = move.parsed!.cell
```

This pattern enables:
- **Decision tree traversal** - L1 tools → L2 tools → final schema
- **Dynamic tool swapping** - Different tools available based on previous decision
- **Hybrid approach** - Tools for decisions, schema for final structured output
```

### Error Handling

#### Schema Validation Errors

When using `schema`, if the model returns invalid JSON or the response doesn't match the schema:

```typescript
{
  text: "Here's my move: {invalid json",
  parsed: null,
  parseError: {
    message: "Unexpected token 'i' at position 0",
    rawText: "Here's my move: {invalid json"
  }
}
```

The tool author decides how to handle:
- Retry with corrective prompt
- Return error to user
- Fall back to regex parsing

#### Mutual Exclusivity Error

If both `schema` and `tools` are provided:

```typescript
throw new Error('Cannot specify both schema and tools in sample config - they are mutually exclusive')
```

### Provider Mapping

#### Structured Output (`schema`)

| Provider | Implementation |
|----------|----------------|
| OpenAI | `response_format: { type: 'json_schema', json_schema: {...} }` |
| Anthropic | Tool-as-schema trick (define tool, force call, extract) |
| Ollama | `format: 'json'` with schema in prompt |

#### Tool Calling (`tools`)

| Provider | Implementation |
|----------|----------------|
| OpenAI | `tools` array, `tool_choice` parameter |
| Anthropic | `tools` array, `tool_choice` parameter |
| Ollama | `tools` array (if supported) |

### MCP Spec Considerations

The official MCP `sampling/createMessage` spec does **not** include `tools`, `toolChoice`, or `schema`. This implementation is an extension beyond the spec.

**Our position:**
- Tool calling is a fundamental LLM capability
- Sampling without structured output is severely limited
- We'll advocate for adding this to the MCP spec

**Compatibility:**
- Our protocol types already define `McpToolDefinition`, `McpToolChoice`, `McpToolUseContent`
- We use these for our implementation
- Not interoperable with other MCP clients/servers (yet)

### Implementation Layers

```
┌─────────────────────────────────────────────────────────────┐
│  ctx.sample({ schema: z.object({...}) })                    │  Tool Author
├─────────────────────────────────────────────────────────────┤
│  McpToolContext.sample() - type-safe overloads              │  mcp-tool-types.ts
├─────────────────────────────────────────────────────────────┤
│  Bridge Runtime - flow config through                       │  bridge-runtime.ts
├─────────────────────────────────────────────────────────────┤
│  Message Encoder - add tools/schema to MCP request          │  message-encoder.ts
├─────────────────────────────────────────────────────────────┤
│  Session Layer - transmit to server                         │  session/types.ts
├─────────────────────────────────────────────────────────────┤
│  Plugin Tool Executor - invoke sampling provider            │  plugin-tool-executor.ts
├─────────────────────────────────────────────────────────────┤
│  Sampling Provider - map to LLM provider format             │  Provider layer
├─────────────────────────────────────────────────────────────┤
│  Message Decoder - extract toolCalls, parse structured      │  message-decoder.ts
└─────────────────────────────────────────────────────────────┘
```

### Dependencies

- `zod-to-json-schema` - Convert Zod schemas to JSON Schema for provider APIs

## Out of Scope

- Auto-executing tool calls (tool author handles)
- Helper functions like `ctx.appendToolExchange()`
- Auto-looping `ctx.sampleUntilComplete()`

## Validation: `play_ttt` Agentic Tool

The new `play_ttt` tool validates both `schema` and `tools` patterns:

### Design

Single agentic tool that encapsulates an entire tic-tac-toe game:
- Uses `before/after` handoff for random X/O assignment
- Uses `ctx.sample({ tools })` for strategy decisions (L1)
- Uses `ctx.sample({ schema })` for move selection (L2)
- Uses `ctx.elicit()` for user moves
- Includes retry loop for invalid model moves

### Game Flow

```
┌─────────────────────────────────────────────────────────────┐
│  LLM calls play_ttt()                                       │
├─────────────────────────────────────────────────────────────┤
│  before(): Randomly assign X/O                              │
├─────────────────────────────────────────────────────────────┤
│  client(): Game Loop                                        │
│    ┌─────────────────────────────────────────────────────┐  │
│    │  If model's turn:                                   │  │
│    │    L1: ctx.sample({ tools: [offensive, defensive]}) │  │
│    │    L2: ctx.sample({ schema: MoveSchema })           │  │
│    │    Apply move (with retry loop), check win          │  │
│    ├─────────────────────────────────────────────────────┤  │
│    │  If user's turn:                                    │  │
│    │    ctx.elicit('pickMove', { board })                │  │
│    │    Apply move, check win                            │  │
│    ├─────────────────────────────────────────────────────┤  │
│    │  Loop until: win/lose/draw/cancel                   │  │
│    └─────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  after(): Format result                                     │
└─────────────────────────────────────────────────────────────┘
```

### Testing Strategy

1. **Unit tests** (`sampling-structured.test.ts`)
   - Mock sampling provider
   - Test schema parsing, error handling, retry
   - Test tool calling, multi-turn messages

2. **Playwright E2E** (`play-ttt.spec.ts`)
   - Real LLM integration
   - Full game to completion
   - Validates tip-to-tail flow

## References

- [MCP Sampling Spec](https://modelcontextprotocol.io/specification/client/sampling)
- [OpenAI Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [Anthropic Tool Use](https://docs.anthropic.com/en/docs/tool-use)
