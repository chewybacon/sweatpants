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

**Status:** In Development - Basic TUI complete, framework integration in progress.

A CLI-based agentic AI application - an MVP OpenCode clone TUI.

### Current Features

- **Ink/React TUI** - Terminal UI with React paradigms
- **Two Modes** - `plan` (read-only) and `build` (HAL 9000 mock for now)
- **In-Process Handler** - Same framework backend as yo-chat, no HTTP layer
- **Message History** - Chat-style display with input at bottom

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         yo-agent TUI                             │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    Ink/React UI                            │  │
│  │  - StatusBar (mode indicator)                             │  │
│  │  - MessageList (chat history)                             │  │
│  │  - TextInput (fixed at bottom)                            │  │
│  └─────────────────────────┬─────────────────────────────────┘  │
│                            │ (in-process, no HTTP)               │
│  ┌─────────────────────────▼─────────────────────────────────┐  │
│  │                   Framework Backend                        │  │
│  │  - createInProcessHandler() adapter                       │  │
│  │  - Isomorphic tools                                       │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Usage

```bash
cd apps/yo-agent
pnpm install
pnpm dev
```

### Key Bindings

| Key | Action |
|-----|--------|
| ESC | Toggle plan/build mode |
| Enter | Send message |
| Ctrl+C | Exit |

### Roadmap

- [x] Basic TUI with Ink
- [x] Mode switching
- [x] HAL 9000 mock (build mode)
- [ ] Integrate framework with in-process handler
- [ ] Plan mode tools (read_file, glob, grep, git)
- [ ] Session persistence

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
