# Reference Applications

Two demo applications showcase the framework in different environments.

## yo-chat (Browser)

**Location:** `apps/yo-chat/`

A browser-based chat application demonstrating interactive tools with React.

### Features Demonstrated

- **Interactive Tools** - `ctx.render()` pattern for inline UI components
- **RenderableProps** - Component contract for tool responses
- **Pipeline Rendering** - Markdown, Shiki, Mermaid, KaTeX
- **Multi-Turn Games** - Stateful interactions across tool calls

### Key Files

| File | Description |
|------|-------------|
| `src/tools/pick-card.tsx` | Card picker using `ctx.render()` |
| `src/tools/games/tic-tac-toe.tsx` | Multi-turn game with state |
| `src/routes/index.tsx` | Main chat UI |
| `src/__generated__/tool-registry.gen.ts` | Auto-discovered tools |

### Tool Pattern

```typescript
// Browser tool with ctx.render()
const myTool = createIsomorphicTool('my_tool')
  .description('...')
  .parameters(z.object({ ... }))
  .context('browser')
  .authority('server')
  .handoff({
    *before(params) {
      return { /* handoff data */ }
    },
    *client(handoff, ctx) {
      return yield* ctx.render(MyComponent, { data: handoff })
    },
    *after(handoff, client) {
      return `Result: ${client.response}`
    },
  })
```

### Running

```bash
cd apps/yo-chat
pnpm install
pnpm dev
```

---

## yo-agent (CLI)

**Location:** `apps/yo-agent/`

**Status:** Coming Soon

A CLI-based agent demonstrating headless and agent tools without a browser.

### Planned Features

- **Headless Tools** - `.context('headless')` for pure computation
- **Agent Tools** - `.context('agent')` with `ctx.prompt()` for LLM calls
- **runAsAgent()** - Autonomous agent execution
- **Structured Output** - Zod schemas for type-safe LLM responses
- **CLI Interface** - stdin/stdout interaction

### Tool Pattern

```typescript
// Agent tool with ctx.prompt()
const analyzerTool = createIsomorphicTool('analyze')
  .description('Analyze text sentiment')
  .parameters(z.object({ text: z.string() }))
  .context('agent')
  .authority('server')
  .handoff({
    *before(params) {
      return { text: params.text }
    },
    *client(handoff, ctx) {
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

### Planned Usage

```bash
cd apps/yo-agent
pnpm install
pnpm dev

# Interactive mode
> analyze "This product is amazing!"
{ sentiment: 'positive', confidence: 0.95 }
```

---

## Comparison

| Aspect | yo-chat | yo-agent |
|--------|---------|----------|
| Environment | Browser | CLI/Server |
| UI Framework | React | None |
| Context Mode | `browser` | `agent` / `headless` |
| User Interaction | `ctx.render()` | `ctx.prompt()` |
| Primary Use Case | Interactive UI | Autonomous agents |

## Architecture

Both apps share the same framework core:

```
┌─────────────────────────────────────────────────────┐
│                    Application                       │
│  ┌─────────────────┐     ┌─────────────────────┐    │
│  │    yo-chat      │     │     yo-agent        │    │
│  │  (React/Browser)│     │    (CLI/Server)     │    │
│  └────────┬────────┘     └──────────┬──────────┘    │
│           │                         │                │
│           ▼                         ▼                │
│  ┌──────────────────────────────────────────────┐   │
│  │              Framework Core                   │   │
│  │  - Isomorphic Tools                          │   │
│  │  - Session Runtime (Effection)               │   │
│  │  - Context Modes (headless/browser/agent)    │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

## Adding New Reference Apps

When creating new reference applications:

1. **Choose context mode** - What capabilities does your app need?
   - `headless`: Pure computation only
   - `browser`: React UI with `ctx.render()`
   - `agent`: LLM access with `ctx.prompt()`

2. **Set up tool discovery** - Add Vite plugin for tool registry generation

3. **Implement tools** - Use `createIsomorphicTool()` builder

4. **Document patterns** - Add examples to this guide

See [isomorphic-tools.md](./isomorphic-tools.md) for the complete tool API.
