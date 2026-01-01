# Isomorphic Tools

Isomorphic tools are the core primitive for building AI-powered interactions. They define both server-side logic (what the LLM sees) and client-side behavior (user interaction or agent logic) in a single file.

## Core Principle

**The server's return value is ALWAYS the final result sent to the LLM.**

There is no "merge" function. The server has authority over what the LLM receives.

## Builder API

Tools are created using the `createIsomorphicTool()` builder:

```typescript
import { createIsomorphicTool } from '@tanstack/framework/chat/isomorphic-tools'
import { z } from 'zod'

const myTool = createIsomorphicTool('tool_name')
  .description('Description for the LLM')
  .parameters(z.object({ ... }))
  .context('browser')     // execution context
  .authority('server')    // who runs first
  .handoff({ ... })       // execution phases
```

See: `src/lib/chat/isomorphic-tools/builder.ts`

## Context Modes

Every tool declares what execution context it requires with `.context()`:

### `headless` - Pure Computation

No UI, no LLM. Can run anywhere.

```typescript
const calculator = createIsomorphicTool('calculate')
  .description('Perform calculations')
  .parameters(z.object({ expression: z.string() }))
  .context('headless')
  .authority('server')
  .server(function*(params) {
    return { result: eval(params.expression) }
  })
  .build()
```

### `browser` - UI Interaction

Requires browser environment. Has access to:
- `ctx.render(Component, props)` - Render React component, wait for response
- `ctx.waitFor(type, payload)` - Generic UI request pattern

```typescript
const picker = createIsomorphicTool('pick')
  .description('Let user pick an option')
  .parameters(z.object({ options: z.array(z.string()) }))
  .context('browser')
  .authority('server')
  .handoff({
    *before(params) { return { options: params.options } },
    *client(handoff, ctx) {
      // ctx.render() is guaranteed available
      return yield* ctx.render(Picker, { options: handoff.options })
    },
    *after(handoff, client) { return `Picked: ${client.choice}` },
  })
```

See: `apps/yo-chat/src/tools/pick-card.tsx`

### `agent` - LLM-Powered

Requires server-side agent environment. Has access to:
- `ctx.prompt(opts)` - Execute structured LLM call

```typescript
const analyzer = createIsomorphicTool('analyze')
  .description('Analyze sentiment')
  .parameters(z.object({ text: z.string() }))
  .context('agent')
  .authority('server')
  .handoff({
    *before(params) { return { text: params.text } },
    *client(handoff, ctx) {
      // ctx.prompt() is guaranteed available
      return yield* ctx.prompt({
        prompt: `Analyze: "${handoff.text}"`,
        schema: z.object({
          sentiment: z.enum(['positive', 'negative', 'neutral']),
        }),
      })
    },
    *after(handoff, client) { return client },
  })
```

See: `src/lib/chat/isomorphic-tools/contexts.ts`

## Authority Modes

### `server` Authority (Default)

Server executes first, optionally hands off to client, then returns result.

**Flow:**
```
LLM calls tool
    |
    v
Server: before(params) -> handoff data
    |
    v
Client: client(handoff, ctx) -> client output
    |
    v
Server: after(handoff, client) -> result to LLM
```

Use for: Server picks random state, generates options, etc.

### `client` Authority

Client executes first, server validates/processes.

**Flow:**
```
LLM calls tool
    |
    v
Client: client(params, ctx) -> client output
    |
    v
Server: server(params, ctx, clientOutput) -> result to LLM
```

Use for: User input that server validates.

```typescript
const userInput = createIsomorphicTool('ask')
  .description('Ask user a question')
  .parameters(z.object({ question: z.string() }))
  .context('browser')
  .authority('client')
  .client(function*(params, ctx) {
    return yield* ctx.render(QuestionForm, { question: params.question })
  })
  .server(function*(params, ctx, clientOutput) {
    // Validate/process user's answer
    return { question: params.question, answer: clientOutput.answer }
  })
```

## The Handoff Pattern

The V7 handoff pattern splits server execution into two phases:

```typescript
.handoff({
  // Phase 1: Runs ONCE, before client
  *before(params, ctx) {
    // Expensive computation, random selection, etc.
    // Return value is cached and sent to client
    return { cards: drawCards(5) }
  },

  // Client phase: User/agent interaction
  *client(handoff, ctx, params) {
    // handoff = cached data from before()
    // ctx = context with render()/prompt() based on context mode
    return yield* ctx.render(CardPicker, { cards: handoff.cards })
  },

  // Phase 2: Runs ONCE, after client
  *after(handoff, client, ctx, params) {
    // handoff = same cached data (NOT re-computed)
    // client = response from client phase
    // Return value goes to LLM
    return `User picked: ${client.picked}`
  },
})
```

**Key guarantee:** `before()` only runs once. Even when the server re-executes in phase 2, it uses the cached handoff data.

See: `src/lib/chat/isomorphic-tools/types.ts` for `HandoffConfig<THandoff, TClient, TResult>`

## The `ctx.render()` Pattern

For browser tools, `ctx.render()` is the primary way to interact with users.

### Component Contract

Components receive `RenderableProps<TResponse>`:

```typescript
interface RenderableProps<TResponse> {
  onRespond: (value: TResponse) => void  // Call when user completes
  disabled?: boolean                      // True if already responded
  response?: TResponse                    // The response (for replay)
}
```

### Interactive Component

```typescript
interface PickerProps extends RenderableProps<{ choice: string }> {
  options: string[]
}

function Picker({ options, onRespond, disabled, response }: PickerProps) {
  if (disabled && response) {
    return <div>You picked: {response.choice}</div>
  }

  return (
    <div>
      {options.map(opt => (
        <button
          key={opt}
          onClick={() => onRespond({ choice: opt })}
          disabled={disabled}
        >
          {opt}
        </button>
      ))}
    </div>
  )
}
```

### Fire-and-Forget Component

For display-only components, call `onRespond()` immediately:

```typescript
function LoadingIndicator({ message, onRespond }: LoadingProps) {
  useEffect(() => {
    onRespond(undefined)  // Resolve immediately
  }, [])
  
  return <div>{message}</div>
}
```

See: `src/lib/chat/isomorphic-tools/runtime/browser-context.ts`

## The `ctx.prompt()` Pattern

For agent tools, `ctx.prompt()` executes structured LLM calls:

```typescript
interface PromptOptions<T extends z.ZodType> {
  prompt: string      // The prompt text
  schema: T           // Zod schema for structured output
  system?: string     // Optional system prompt
  model?: string      // Optional model override
  temperature?: number
}

// Usage in client phase
*client(handoff, ctx) {
  const result = yield* ctx.prompt({
    prompt: `Choose the best option from: ${handoff.options.join(', ')}`,
    schema: z.object({
      choice: z.string(),
      reasoning: z.string(),
    }),
  })
  return result
}
```

See: `src/lib/chat/isomorphic-tools/contexts.ts` for `PromptOptions`

## Running as an Agent

For autonomous agent execution, use `runAsAgent()`:

```typescript
import { runAsAgent } from '@tanstack/framework/chat/isomorphic-tools'

const result = yield* runAsAgent({
  tool: myAgentTool,
  params: { input: 'analyze this' },
  llmClient: myLLMClient,
})
```

See: `src/lib/chat/isomorphic-tools/agent-runtime.ts`

## Approval Configuration

Tools can require user approval before execution:

```typescript
const dangerousTool = createIsomorphicTool('delete_file')
  .description('Delete a file')
  .parameters(z.object({ path: z.string() }))
  .context('browser')
  .authority('server')
  .approval({
    server: 'none',      // No server-side approval
    client: 'confirm',   // Require user confirmation
    clientMessage: (params) => `Delete ${params.path}?`,
    onDenied: 'error',   // or 'skip' or 'disable'
  })
  .handoff({ ... })
```

## Type Safety

The builder maintains full type safety across phases:

```typescript
const tool = createIsomorphicTool('typed_example')
  .description('...')
  .parameters(z.object({ input: z.string() }))
  .context('browser')
  .authority('server')
  .handoff({
    *before(params) {
      // params is { input: string }
      return { computed: params.input.toUpperCase() }
    },
    *client(handoff, ctx, params) {
      // handoff is { computed: string }
      // ctx is BrowserToolContext (has render())
      // params is { input: string }
      return yield* ctx.render(MyComponent, { value: handoff.computed })
    },
    *after(handoff, client, ctx, params) {
      // handoff is { computed: string } (cached, not re-computed)
      // client is the return type from *client()
      return { success: true, result: client }
    },
  })

// Extract types from a tool
type Params = InferToolParams<typeof tool>       // { input: string }
type Result = InferToolResult<typeof tool>       // { success: boolean, result: ... }
type Handoff = InferToolHandoff<typeof tool>     // { computed: string }
type ClientOut = InferToolClientOutput<typeof tool>
```

See: `src/lib/chat/isomorphic-tools/builder.ts` for type helpers

## Real-World Examples

### Card Picker (Browser, Interactive)

File: `apps/yo-chat/src/tools/pick-card.tsx`

Server draws random cards, user picks one via rendered UI.

### Tic-Tac-Toe (Browser, Multi-Turn)

File: `apps/yo-chat/src/tools/games/tic-tac-toe.tsx`

Multi-turn game with:
- Model plays as X, user as O
- Interactive board with `ctx.render()`
- Fire-and-forget winner announcement

### Built-in Tools

File: `src/lib/chat/isomorphic-tools/builtins.ts`

- `calculatorIsomorphicTool` - Basic calculator
- `searchIsomorphicTool` - Web search
- `getWeatherIsomorphicTool` - Weather lookup

## File Reference

| File | Description |
|------|-------------|
| `src/lib/chat/isomorphic-tools/index.ts` | Main exports |
| `src/lib/chat/isomorphic-tools/builder.ts` | `createIsomorphicTool()` |
| `src/lib/chat/isomorphic-tools/types.ts` | Core types, `HandoffConfig` |
| `src/lib/chat/isomorphic-tools/contexts.ts` | Context modes |
| `src/lib/chat/isomorphic-tools/executor.ts` | Server/client execution |
| `src/lib/chat/isomorphic-tools/runtime/browser-context.ts` | `ctx.render()` |
| `src/lib/chat/isomorphic-tools/agent-runtime.ts` | `runAsAgent()` |
| `src/lib/chat/isomorphic-tools/registry.ts` | Tool registry |
