# Sampling with Tools and Structured Output

## Overview

This document describes the design for adding tools and structured output support to MCP sampling (`ctx.sample()`). This enables tool authors to get structured responses from LLM calls within their tools, supporting both one-shot structured output and multi-turn tool-calling patterns.

Additionally, we provide **guaranteed helper methods** (`ctx.sampleTools()` and `ctx.sampleSchema()`) that handle validation and retries automatically, eliminating the need for manual type assertions and retry loops.

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
- **NEW**: `ctx.sampleTools()` - guaranteed tool calls with retry
- **NEW**: `ctx.sampleSchema()` - guaranteed parsed schema with retry

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
  
  // =========================================================================
  // GUARANTEED HELPERS (with retry logic)
  // =========================================================================
  
  // Guaranteed tool calls - throws SampleValidationError if retries exhausted
  sampleTools(config: SampleToolsConfig | SampleToolsConfigMessages): Operation<SampleToolsResult>
  
  // Guaranteed parsed schema - throws SampleValidationError if retries exhausted
  sampleSchema<T>(config: SampleSchemaConfig<T> | SampleSchemaConfigMessages<T>): Operation<SampleSchemaResult<T>>
}
```

### Guaranteed Helper Types

```typescript
/** Config for sampleTools with prompt */
interface SampleToolsConfig {
  prompt: string
  tools: SamplingToolDefinition[]
  toolChoice?: SamplingToolChoice  // defaults to 'required'
  retries?: number                  // defaults to 2
  systemPrompt?: string
  maxTokens?: number
}

/** Config for sampleTools with messages */
interface SampleToolsConfigMessages {
  messages: Message[]
  tools: SamplingToolDefinition[]
  toolChoice?: SamplingToolChoice
  retries?: number
  systemPrompt?: string
  maxTokens?: number
}

/** Guaranteed result - toolCalls is non-empty tuple */
interface SampleToolsResult extends SampleResultBase {
  stopReason: 'toolUse'
  toolCalls: [SamplingToolCall, ...SamplingToolCall[]]  // At least one
}

/** Config for sampleSchema with prompt */
interface SampleSchemaConfig<T> {
  prompt: string
  schema: z.ZodType<T>
  retries?: number                  // defaults to 2
  systemPrompt?: string
  maxTokens?: number
}

/** Config for sampleSchema with messages */
interface SampleSchemaConfigMessages<T> {
  messages: Message[]
  schema: z.ZodType<T>
  retries?: number
  systemPrompt?: string
  maxTokens?: number
}

/** Guaranteed result - parsed is never null */
interface SampleSchemaResult<T> extends SampleResultBase {
  parsed: T  // Guaranteed non-null
}

/** Error thrown when all retries exhausted */
class SampleValidationError extends Error {
  readonly method: 'sampleTools' | 'sampleSchema'
  readonly attempts: number
  readonly lastResult: SampleResultBase
}
```

### Usage Examples

#### Structured Output (TicTacToe) - Basic

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

#### Structured Output with Guaranteed Result (Recommended)

```typescript
const MoveSchema = z.object({ 
  cell: z.number().min(0).max(8),
})

// sampleSchema handles retries automatically
// Throws SampleValidationError if all retries fail
const response = yield* ctx.sampleSchema({
  prompt: `Pick a cell for your move. Empty cells: ${emptyCells.join(', ')}`,
  schema: MoveSchema,
  retries: 3,
})

// response.parsed is guaranteed to be non-null!
const cell = response.parsed.cell  // No null check needed
board[cell] = 'X'
```

#### Tool Calling with Guaranteed Result (Recommended)

```typescript
// sampleTools guarantees toolCalls[0] exists
const strategy = yield* ctx.sampleTools({
  prompt: `Board:\n${formatBoard(board)}\nChoose your strategy.`,
  tools: [
    { name: 'play_offensive', inputSchema: z.object({ reasoning: z.string() }) },
    { name: 'play_defensive', inputSchema: z.object({ threat: z.string() }) },
  ],
  retries: 3,
})

// Guaranteed to have at least one tool call
const strategyCall = strategy.toolCalls[0]
console.log(`Strategy: ${strategyCall.name}`)
```

#### Tool Calling (LLM-Driven Flow Control) - Basic

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

#### Divergence from Official MCP Protocol

The official MCP `sampling/createMessage` spec (as of 2025-11-25) does **not** include:
- `tools` - tool definitions for the model to call
- `toolChoice` - control over whether/which tools to call
- `schema` - structured output schema for JSON responses

This implementation is a **framework extension beyond the MCP spec**.

#### What the MCP Spec Defines

The official MCP sampling request includes:
```typescript
// From MCP spec sampling/createMessage
interface CreateMessageRequest {
  messages: SamplingMessage[]
  modelPreferences?: ModelPreferences
  systemPrompt?: string
  includeContext?: 'none' | 'thisServer' | 'allServers'
  maxTokens: number
}
```

The response includes:
```typescript
interface CreateMessageResult {
  role: 'user' | 'assistant'
  content: TextContent | ImageContent
  model: string
  stopReason?: 'endTurn' | 'stopSequence' | 'maxTokens' | string
}
```

Note: No `tools`, `toolCalls`, or structured `schema` support.

#### Our Extensions

We extend the sampling request with:
```typescript
// Our extensions (not in MCP spec)
interface ExtendedSampleOptions {
  tools?: SamplingToolDefinition[]      // Tool definitions
  toolChoice?: 'auto' | 'required' | 'none'  // Tool selection control
  schema?: JsonSchema                    // Structured output schema
}
```

And the response with:
```typescript
// Our extensions (not in MCP spec)
interface ExtendedSampleResult {
  stopReason?: 'toolUse' | ...           // New stop reason for tool calls
  toolCalls?: SamplingToolCall[]         // Extracted tool calls
  parsed?: T                             // Parsed schema result
  parseError?: { message, rawText }      // Schema parse errors
}
```

#### Why We Diverge

1. **Tool calling is fundamental** - Every major LLM provider (OpenAI, Anthropic, Google) supports tool calling. It's a core capability for agentic workflows.

2. **Structured output is essential** - Without schema support, tools must parse free-form text with regex, which is fragile and error-prone.

3. **Decision trees need tool calling** - The L1/L2 pattern (strategy → move) requires tools for branching decisions.

4. **MCP spec is incomplete for agentic tools** - The current spec assumes sampling returns simple text, not structured data or tool invocations.

#### Interoperability Impact

| Scenario | Compatible? | Notes |
|----------|-------------|-------|
| Our tools ↔ Our runtime | ✅ Yes | Full feature support |
| Our tools → Standard MCP client | ⚠️ Partial | Tools/schema ignored, falls back to text |
| Standard MCP tool → Our runtime | ✅ Yes | We're a superset |
| Our tools → MCP Inspector | ⚠️ Partial | Basic sampling works, tools/schema not |

#### Future Direction

We plan to:
1. Advocate for adding `tools`, `toolChoice`, and `schema` to the MCP sampling spec
2. Provide a polyfill layer for standard MCP clients
3. Gracefully degrade when connected to non-extended clients

#### Helper Methods: Framework-Only

The guaranteed helper methods (`ctx.sampleTools()`, `ctx.sampleSchema()`) are purely framework conveniences built on top of the extended sampling. They:
- Are not part of any protocol
- Handle retry logic and validation internally
- Throw `SampleValidationError` on exhausted retries

These would work with any sampling implementation that supports our extensions.

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

The new `play_ttt` tool validates both `schema` and `tools` patterns using the **guaranteed helper methods**:

### Design

Single agentic tool that encapsulates an entire tic-tac-toe game:
- Uses `before/after` handoff for random X/O assignment
- Uses `ctx.sampleTools()` for strategy decisions (L1) - guaranteed tool calls
- Uses `ctx.sampleSchema()` for move selection (L2) - guaranteed parsed result
- Uses `ctx.elicit()` for user moves
- No manual retry loops needed - helpers handle retries automatically

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
│    │    L1: ctx.sampleTools({ tools: [...] })            │  │
│    │         → Guaranteed toolCalls[0] exists            │  │
│    │    L2: ctx.sampleSchema({ schema: MoveSchema })     │  │
│    │         → Guaranteed parsed.cell exists             │  │
│    │    Apply move, check win                            │  │
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
