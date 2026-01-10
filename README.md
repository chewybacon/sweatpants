# Sweatpants

A framework for building AI chat applications with React and Effection.

## Features

- **Streaming Chat Sessions** - Real-time streaming responses with structured message handling
- **Isomorphic Tools** - Define tools that run on server, client, or both with seamless handoff
- **MCP Protocol Support** - Model Context Protocol tools with elicit/sample capabilities
- **Durable Streams** - Reconnectable streams for reliable chat sessions
- **React Integration** - Hooks and components for building chat UIs
- **Type-Safe** - End-to-end TypeScript with Zod schema validation

## Packages

| Package | Description |
|---------|-------------|
| `@sweatpants/framework` | Core framework with chat, tools, and React integration |
| `@sweatpants/cli` | CLI for generating TypeScript types from MCP manifests |
| `@sweatpants/elicit-context` | Encode/decode elicit context for tool interactions |

## Quick Start

```bash
pnpm add @sweatpants/framework
```

### Basic Chat Session

```tsx
import { useChat } from '@sweatpants/framework/react/chat'

function Chat() {
  const { messages, sendMessage, isStreaming } = useChat({
    endpoint: '/api/chat',
  })

  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id}>{msg.content}</div>
      ))}
      <input
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            sendMessage(e.currentTarget.value)
          }
        }}
      />
    </div>
  )
}
```

### Defining Tools

```ts
import { defineTool } from '@sweatpants/framework/chat/isomorphic-tools'
import { z } from 'zod'

export const calculator = defineTool({
  name: 'calculator',
  description: 'Perform mathematical calculations',
  parameters: z.object({
    expression: z.string().describe('Math expression to evaluate'),
  }),
  execute: async ({ expression }) => {
    const result = eval(expression)
    return { result }
  },
})
```

### MCP Tools with Elicit

```ts
import { defineMcpTool } from '@sweatpants/framework/chat/mcp-tools'
import { z } from 'zod'

export const bookFlight = defineMcpTool({
  name: 'book_flight',
  description: 'Book a flight for the user',
  parameters: z.object({
    from: z.string(),
    to: z.string(),
    date: z.string(),
  }),
  elicits: {
    confirm: z.object({
      confirmed: z.boolean(),
    }),
  },
  execute: async ({ from, to, date }, ctx) => {
    // Request user confirmation
    const response = await ctx.elicit('confirm', {
      message: `Book flight from ${from} to ${to} on ${date}?`,
    })

    if (response.action === 'accept' && response.content.confirmed) {
      return { status: 'booked', confirmation: 'ABC123' }
    }
    return { status: 'cancelled' }
  },
})
```

## Apps

| App | Description |
|-----|-------------|
| `yo-chat` | Reference web application with full chat UI |
| `yo-agent` | CLI agent for terminal-based chat |
| `yo-mcp` | MCP server demo |
| `hydra` | Effection tutorial and examples |

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
cd packages/framework && pnpm test

# Start yo-chat dev server
cd apps/yo-chat && pnpm dev
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     React App                            │
│  ┌─────────────────────────────────────────────────┐    │
│  │              useChat() Hook                      │    │
│  │  - Message state management                      │    │
│  │  - Streaming response handling                   │    │
│  │  - Tool execution coordination                   │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   Chat Handler                           │
│  ┌─────────────────┐  ┌─────────────────────────────┐   │
│  │  LLM Provider   │  │      Tool Registry          │   │
│  │  - OpenAI       │  │  - Isomorphic tools         │   │
│  │  - Anthropic    │  │  - MCP tools                │   │
│  │  - Ollama       │  │  - Tool discovery           │   │
│  └─────────────────┘  └─────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                  Durable Streams                         │
│  - Session persistence                                   │
│  - Reconnection support                                  │
│  - Multi-client coordination                             │
└─────────────────────────────────────────────────────────┘
```

## License

MIT
