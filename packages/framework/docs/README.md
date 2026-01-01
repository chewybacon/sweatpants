# Framework Documentation

An agentic AI framework with isomorphic tools, structured concurrency, and streaming pipelines.

## Key Concepts

### Isomorphic Tools

Tools that define both server and client behavior in a single file. The server controls what the LLM sees; the client handles user interaction or agent logic.

```typescript
// See: src/lib/chat/isomorphic-tools/builder.ts for full API
// See: apps/yo-chat/src/tools/pick-card.tsx for real example

const myTool = createIsomorphicTool('my_tool')
  .description('What the LLM sees')
  .parameters(z.object({ input: z.string() }))
  .context('browser')      // or 'agent' or 'headless'
  .authority('server')     // server executes first
  .handoff({
    *before(params) { /* compute state */ },
    *client(handoff, ctx) { /* UI or LLM interaction */ },
    *after(handoff, client) { /* return result to LLM */ },
  })
```

### Context Modes

Tools declare what execution context they need:

| Mode | Capability | Use Case |
|------|------------|----------|
| `headless` | Pure computation | Math, data processing |
| `browser` | `ctx.render()`, `ctx.waitFor()` | Interactive UI |
| `agent` | `ctx.prompt()` | LLM-powered decisions |

See: `src/lib/chat/isomorphic-tools/contexts.ts`

### Authority Modes

Who executes first:

| Mode | Flow | Use Case |
|------|------|----------|
| `server` | Server -> Client -> Server | Server picks state, client interacts |
| `client` | Client -> Server | User input, server validates |

### Streaming Pipeline

Content flows through processors for progressive rendering:

```
Tokens -> Parser -> Frame -> [markdown] -> [shiki] -> HTML
```

See: `src/react/chat/pipeline/index.ts`

## Reference Applications

Two demo applications showcase the framework:

### yo-chat (Browser)

Location: `apps/yo-chat/`

Demonstrates browser-based interactive tools:
- `ctx.render()` for inline React components
- `RenderableProps<T>` pattern for user responses
- Pipeline rendering with Shiki, Mermaid, KaTeX

Key files:
- `src/tools/pick-card.tsx` - Card picker with `ctx.render()`
- `src/tools/games/tic-tac-toe.tsx` - Multi-turn game

### yo-agent (CLI)

Location: `apps/yo-agent/` (coming soon)

Demonstrates headless/agent tools:
- `ctx.prompt()` for structured LLM calls
- `runAsAgent()` for autonomous execution
- No UI dependencies

## Documentation Index

| Document | Description |
|----------|-------------|
| [Isomorphic Tools](./isomorphic-tools.md) | Tool builder API, context modes, patterns |
| [Framework Design](./framework-design.md) | Architecture, Effection, execution model |
| [Pipeline Guide](./pipeline-guide.md) | Frame-based streaming, processors |
| [Rendering Engine](./rendering-engine-design.md) | Internal rendering architecture |
| [Reference Apps](./reference-apps.md) | yo-chat and yo-agent details |

## Quick Start

### For Browser Tools (yo-chat style)

```typescript
import { createIsomorphicTool, RenderableProps } from '@tanstack/framework/chat/isomorphic-tools'
import { z } from 'zod'

// 1. Define your component
interface PickerProps extends RenderableProps<{ choice: string }> {
  options: string[]
}

function Picker({ options, onRespond, disabled }: PickerProps) {
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

// 2. Define your tool
export const picker = createIsomorphicTool('picker')
  .description('Let user pick an option')
  .parameters(z.object({ options: z.array(z.string()) }))
  .context('browser')
  .authority('server')
  .handoff({
    *before(params) {
      return { options: params.options }
    },
    *client(handoff, ctx) {
      return yield* ctx.render(Picker, { options: handoff.options })
    },
    *after(handoff, client) {
      return `User picked: ${client.choice}`
    },
  })
```

### For Agent Tools (yo-agent style)

```typescript
import { createIsomorphicTool } from '@tanstack/framework/chat/isomorphic-tools'
import { z } from 'zod'

export const analyzer = createIsomorphicTool('analyzer')
  .description('Analyze text sentiment')
  .parameters(z.object({ text: z.string() }))
  .context('agent')
  .authority('server')
  .handoff({
    *before(params) {
      return { text: params.text }
    },
    *client(handoff, ctx) {
      // ctx.prompt() is guaranteed available in agent context
      return yield* ctx.prompt({
        prompt: `Analyze sentiment: "${handoff.text}"`,
        schema: z.object({
          sentiment: z.enum(['positive', 'negative', 'neutral']),
          confidence: z.number(),
        }),
      })
    },
    *after(handoff, client) {
      return { analyzed: true, ...client }
    },
  })
```

### Using the Chat Hook

```typescript
import { useChat } from '@tanstack/framework/react/chat'
import { picker } from './tools/picker'

function Chat() {
  const { messages, send, isStreaming } = useChat({
    tools: [picker],
    pipeline: 'full',  // markdown + shiki + mermaid + math
  })

  return (
    <div>
      {messages.map(msg => (
        <div key={msg.id}>
          {msg.html ? (
            <div dangerouslySetInnerHTML={{ __html: msg.html }} />
          ) : (
            msg.content
          )}
        </div>
      ))}
    </div>
  )
}
```

## Source Code Reference

The JSDoc comments in source files contain detailed API documentation:

| File | Contains |
|------|----------|
| `src/lib/chat/isomorphic-tools/index.ts` | Main exports, API overview |
| `src/lib/chat/isomorphic-tools/builder.ts` | `createIsomorphicTool()` builder |
| `src/lib/chat/isomorphic-tools/types.ts` | Core type definitions |
| `src/lib/chat/isomorphic-tools/contexts.ts` | Context modes and types |
| `src/lib/chat/isomorphic-tools/runtime/browser-context.ts` | `ctx.render()` implementation |
| `src/lib/chat/isomorphic-tools/agent-runtime.ts` | `runAsAgent()`, `ctx.prompt()` |
| `src/lib/chat/session/create-session.ts` | Chat session runtime |
| `src/react/chat/useChat.ts` | React hook |
| `src/react/chat/pipeline/index.ts` | Streaming pipeline |
