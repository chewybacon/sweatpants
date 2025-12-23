# Type-Safe Isomorphic Tools

A type-safe builder pattern for creating isomorphic tools that execute across server and client boundaries with full type inference.

## Overview

Isomorphic tools are LLM-callable functions that coordinate execution between server and client. The **builder pattern** (inspired by TanStack Start's `createServerFn`) provides compile-time type safety across all phases.

```typescript
import { createIsomorphicTool } from '@/lib/chat/isomorphic-tools'
import { z } from 'zod'

const guessCard = createIsomorphicTool('guess_card')
  .description('A card guessing game')
  .parameters(z.object({ prompt: z.string().optional() }))
  .authority('server')
  .handoff({
    *before(params) {
      // Phase 1: Server picks secret (runs ONCE)
      return { secret: 'Ace', choices: ['Ace', 'King', 'Queen'] }
    },
    *client(handoff, ctx, params) {
      // Client shows UI, collects input
      // handoff is typed as { secret: string, choices: string[] }
      return { guess: handoff.choices[0] }
    },
    *after(handoff, client) {
      // Phase 2: Server validates (runs ONCE after client)
      // handoff and client are both fully typed
      return { correct: client.guess === handoff.secret }
    },
  })
```

## Key Benefits

1. **Full Type Inference**: Types flow from `before()` to `client()` to `after()`
2. **Phantom Types**: No runtime cost for type information
3. **Client Hooks**: Type-safe React handlers for handoff events
4. **Migration Path**: Works alongside legacy `defineIsomorphicTool`

## Builder API

### Basic Flow

```typescript
createIsomorphicTool(name)
  .description(desc)
  .parameters(zodSchema)
  .authority('server' | 'client')
  // Then configure based on authority...
```

### Server Authority with Handoff (V7 Pattern)

For tools where the server picks state, client interacts, and server validates:

```typescript
const tool = createIsomorphicTool('my_tool')
  .description('...')
  .parameters(z.object({ ... }))
  .authority('server')
  .handoff({
    *before(params, ctx) {
      // Runs ONCE - return data for client and phase 2
      return { secret: pickRandom(), options: generateOptions() }
    },
    *client(handoff, ctx, params) {
      // handoff is typed from before() return
      return { userChoice: yield* getUserInput(handoff.options) }
    },
    *after(handoff, client, ctx, params) {
      // handoff from before(), client from client()
      return { correct: client.userChoice === handoff.secret }
    },
  })
```

### Server Authority (Simple)

For tools where server computes and client optionally presents:

```typescript
const tool = createIsomorphicTool('compute')
  .description('...')
  .parameters(z.object({ input: z.string() }))
  .authority('server')
  .server(function*(params, ctx) {
    return { result: compute(params.input) }
  })
  .client(function*(serverOutput, ctx, params) {
    // serverOutput is typed from server() return
    showResult(serverOutput.result)
    return { displayed: true }
  })
```

### Client Authority

For tools where client collects input and server validates:

```typescript
const tool = createIsomorphicTool('get_input')
  .description('...')
  .parameters(z.object({ prompt: z.string() }))
  .authority('client')
  .client(function*(params, ctx) {
    return { input: yield* showPrompt(params.prompt) }
  })
  .server(function*(params, ctx, clientOutput) {
    // clientOutput is typed from client() return
    return { valid: validate(clientOutput.input) }
  })
```

## Client Hooks

The client hooks extract types from builder tools and apply them to React handlers.

### Pattern 1: Registry (Recommended for Multiple Tools)

```typescript
import { createHandoffHandler, createHandoffRegistry } from '@/lib/chat/isomorphic-tools'

// Create typed handlers
const handleGuessCard = createHandoffHandler(guessCardTool, (handoff, params, respond) => {
  // handoff.choices is typed as string[]
  // respond expects { guess: string }
  return (
    <CardPicker
      choices={handoff.choices}
      onPick={(card) => respond({ guess: card })}
    />
  )
})

const handlePickNumber = createHandoffHandler(pickNumberTool, (handoff, params, respond) => {
  return (
    <NumberInput
      hint={handoff.hint}
      onSubmit={(n) => respond({ number: n })}
    />
  )
})

// Create registry
const registry = createHandoffRegistry([handleGuessCard, handlePickNumber])

// Use in component
function ToolRenderer({ event, onRespond }) {
  const ui = registry.handle(event, onRespond)
  if (ui) return ui
  return <div>Unknown tool: {event.toolName}</div>
}
```

### Pattern 2: Narrowing (For Switch Statements)

```typescript
import { narrowHandoff } from '@/lib/chat/isomorphic-tools'

function ToolRenderer({ event, onRespond }) {
  const card = narrowHandoff(guessCardTool, event, onRespond)
  if (card) {
    // card.handoff is typed as { secret: string, choices: string[] }
    // card.respond expects { guess: string }
    return <CardPicker choices={card.handoff.choices} onPick={card.respond} />
  }

  const number = narrowHandoff(pickNumberTool, event, onRespond)
  if (number) {
    return <NumberInput hint={number.handoff.hint} onSubmit={number.respond} />
  }

  return <div>Unknown tool</div>
}
```

### Pattern 3: Discriminated Union (For Type-Safe Switches)

```typescript
import { type ToolHandoffUnion } from '@/lib/chat/isomorphic-tools'

type MyToolHandoffs = ToolHandoffUnion<[
  typeof guessCardTool,
  typeof pickNumberTool,
]>

function handleTool(data: MyToolHandoffs) {
  switch (data.tool) {
    case 'guess_card':
      // data.handoff is { secret: string, choices: string[] }
      return <CardPicker choices={data.handoff.choices} />
    case 'pick_number':
      // data.handoff is { number: number, hint: string }
      return <NumberInput hint={data.handoff.hint} />
  }
}
```

## Type Extraction

Extract types from finalized tools for use elsewhere:

```typescript
import {
  ExtractHandoff,
  ExtractClientOutput,
  ExtractParams,
  InferToolResult,
} from '@/lib/chat/isomorphic-tools'

type GuessCardHandoff = ExtractHandoff<typeof guessCardTool>
// { secret: string, choices: string[] }

type GuessCardClientOutput = ExtractClientOutput<typeof guessCardTool>
// { guess: string }

type GuessCardParams = ExtractParams<typeof guessCardTool>
// { prompt?: string }

type GuessCardResult = InferToolResult<typeof guessCardTool>
// { correct: boolean }
```

## Migration from defineIsomorphicTool

### Before (Legacy)

```typescript
const tool = defineIsomorphicTool({
  name: 'guess_card',
  description: '...',
  parameters: z.object({ prompt: z.string() }),
  authority: 'server',
  *server(params, ctx) {
    return yield* ctx.handoff({
      *before() {
        return { secret: 'Ace', choices: ['Ace', 'King'] }
      },
      *after(handoff, clientOutput) {
        // handoff is unknown!
        // clientOutput is unknown!
        return { correct: clientOutput.guess === handoff.secret }
      },
    })
  },
  *client(handoffData, ctx, params) {
    // handoffData is unknown! Must cast manually
    const data = handoffData as { choices: string[] }
    return { guess: data.choices[0] }
  },
})
```

### After (Builder)

```typescript
const tool = createIsomorphicTool('guess_card')
  .description('...')
  .parameters(z.object({ prompt: z.string() }))
  .authority('server')
  .handoff({
    *before(params) {
      return { secret: 'Ace', choices: ['Ace', 'King'] }
    },
    *client(handoff, ctx, params) {
      // handoff is { secret: string, choices: string[] } - fully typed!
      return { guess: handoff.choices[0] }
    },
    *after(handoff, client) {
      // Both are fully typed!
      return { correct: client.guess === handoff.secret }
    },
  })
```

## Architecture

### Type Flow Diagram

```
Server (builder.ts)                    Client (client-hooks.ts)
─────────────────────                  ─────────────────────────

createIsomorphicTool('guess_card')
  .handoff({
    *before() {                        createHandoffHandler(tool, (handoff, params, respond) => {
      return {                           // handoff is typed as:
        secret: 'Ace',                   // { secret: string, choices: string[], hint: string }
        choices: ['Ace', 'King'],
        hint: 'Pick!'                    // respond expects:
      }                                  // { guess: string }
    },
    *client(handoff) {                   return <CardPicker
      return { guess: '...' }              choices={handoff.choices}  // typed!
    },                                     onPick={(c) => respond({ guess: c })}  // typed!
    *after(handoff, client) {            />
      return { correct: ... }          })
    },
  })
```

### Phantom Types

The builder uses TypeScript's phantom type pattern (from TanStack Start) to carry type information without runtime cost:

```typescript
interface IsomorphicToolTypes<
  in out TParams,
  in out TAuthority,
  in out THandoff,
  in out TClient,
  in out TResult,
> {
  params: TParams
  authority: TAuthority
  handoff: THandoff
  client: TClient
  result: TResult
}

interface FinalizedIsomorphicTool<...> {
  _types: IsomorphicToolTypes<...>  // Phantom - no runtime value
  name: TName
  // ... actual runtime fields
}
```

The `in out` variance modifiers enable bidirectional type flow, allowing types to be both inferred from builder calls and extracted for client-side use.

## Files

- `builder.ts` - Type-safe builder implementation
- `client-hooks.ts` - React client hooks for handoff handling
- `types.ts` - Shared type definitions
- `define.ts` - Legacy `defineIsomorphicTool` (still supported)
- `executor.ts` - V7 handoff executor
- `registry.ts` - Tool registry

## See Also

- [TanStack Start createServerFn](https://tanstack.com/start/latest/docs/framework/react/api/createServerFn) - Inspiration for the builder pattern
- Demo: `/demo/effection/typed-tools` - Live example of all patterns
