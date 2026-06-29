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

| Package                              | Description                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `@sweatpants/framework`              | Server/chat framework primitives, durable handlers, isomorphic tools, and MCP plugin support |
| `@sweatpants/react-chat`             | React hooks and message derivation for chat UIs                                              |
| `@sweatpants/durable-streams`        | Reconnectable token buffers and durable stream transports                                    |
| `@sweatpants/stream-bridge`          | Effection/Web stream bridge helpers                                                          |
| `@sweatpants/tool-runtime-local`     | Local/worker-backed tool runtime                                                             |
| `@sweatpants/tool-runtime-agentcore` | AgentCore-backed remote tool runtime                                                         |
| `@sweatpants/model-provider-pi-ai`   | Model provider adapter for `@earendil-works/pi-ai`                                           |
| `@sweatpants/cli`                    | CLI for generating TypeScript types from MCP manifests                                       |
| `@sweatpants/elicit-context`         | Encode/decode elicit context for tool interactions                                           |

## Quick Start

```bash
pnpm add @sweatpants/framework @sweatpants/react-chat
```

### Basic Chat Session

```tsx
import { useChat } from "@sweatpants/react-chat";

function Chat() {
    const { messages, send, isStreaming } = useChat({
        baseUrl: "/api/chat",
    });

    return (
        <div>
            {messages.map((msg) => (
                <div key={msg.id}>{msg.content}</div>
            ))}
            <input
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        send(e.currentTarget.value);
                    }
                }}
            />
        </div>
    );
}
```

### Defining Tools

```ts
import { createIsomorphicTool } from "@sweatpants/framework/chat/isomorphic-tools";
import { z } from "zod";

export const calculator = createIsomorphicTool("calculator")
    .description("Perform mathematical calculations")
    .parameters(
        z.object({
            expression: z.string().describe("Math expression to evaluate"),
        }),
    )
    .server(function* ({ expression }) {
        const result = Number(expression);
        return { result };
    });
```

### MCP Tools with Elicit

```ts
import { createTool } from "@sweatpants/core";
import { z } from "zod";

export const bookFlight = createTool("book_flight")
    .description("Book a flight for the user")
    .parameters(
        z.object({
            from: z.string(),
            to: z.string(),
            date: z.string(),
        }),
    )
    .elicits({
        confirm: {
            response: z.object({ confirmed: z.boolean() }),
        },
    })
    .execute(function* ({ from, to, date }, ctx) {
        // Request user confirmation
        const response = yield* ctx.elicit("confirm", {
            message: `Book flight from ${from} to ${to} on ${date}?`,
        });

        if (response.action === "accept" && response.content.confirmed) {
            return { status: "booked", confirmation: "ABC123" };
        }
        return { status: "cancelled" };
    });
```

## Apps

| App        | Description                                 |
| ---------- | ------------------------------------------- |
| `yo-chat`  | Reference web application with full chat UI |
| `yo-agent` | CLI agent for terminal-based chat           |
| `yo-mcp`   | MCP server demo                             |
| `hydra`    | Effection tutorial and examples             |

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

## Development Workflow

### TypeScript Incremental Builds

This monorepo uses TypeScript project references for fast incremental builds:

```bash
# Build all tsc-buildable workspaces
pnpm tsc -b

# Clean and rebuild
pnpm tsc -b --clean && pnpm tsc -b

# Build specific workspace
cd packages/framework
pnpm tsc -b
```

### Development Exports

Packages export TypeScript source files via the `development` condition:

- VSCode automatically resolves to source files
- No build required for IntelliSense
- "Go to Definition" jumps to .ts files, not .d.ts

### Workspace Structure

- **tsc-buildable**: elicit-context, cli, framework, hydra
    - Use `pnpm tsc -b` for builds
    - Participate in incremental build chain

- **Bundler-based**: yo-agent, yo-chat, yo-mcp
    - Use tsup/vite for builds
    - Type-check with `pnpm check`
    - Not part of `tsc -b` chain

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
