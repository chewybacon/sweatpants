# yo-agent

A CLI-based agentic AI application built on the framework. An MVP OpenCode clone TUI.

## Status

**In Development** - Basic TUI structure complete, framework integration in progress.

## Running

```bash
cd apps/yo-agent
pnpm install
pnpm dev
```

**Requires an interactive terminal (TTY).**

## Modes

| Mode | Key | Description |
|------|-----|-------------|
| `plan` | Default | Read-only tools for research and analysis |
| `build` | ESC to toggle | Currently mocks responses with HAL 9000 quotes |

## Key Bindings

| Key | Action |
|-----|--------|
| ESC | Toggle between plan/build modes |
| Enter | Send message |
| Ctrl+C | Exit |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         yo-agent TUI                             │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    Ink/React UI                            │  │
│  │  - StatusBar (mode indicator)                             │  │
│  │  - MessageList (chat history)                             │  │
│  │  - TextInput (fixed at bottom)                            │  │
│  └─────────────────────────┬─────────────────────────────────┘  │
│                            │                                     │
│                            │ (in-process, no HTTP)               │
│                            │                                     │
│  ┌─────────────────────────▼─────────────────────────────────┐  │
│  │                   Framework Backend                        │  │
│  │  - createInProcessHandler()                               │  │
│  │  - Same handler as yo-chat server                         │  │
│  │  - Isomorphic tools with .context('agent')                │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## File Structure

```
src/
├── cli.tsx                 # Entry point
├── components/
│   ├── App.tsx            # Root component, mode state
│   ├── StatusBar.tsx      # Mode indicator, keybindings
│   ├── Chat.tsx           # Main chat interface
│   └── MessageList.tsx    # Message display
├── hooks/
│   └── useAgentChat.ts    # Chat hook (HAL mock for now)
└── lib/
    └── in-process-handler.ts  # Framework adapter
```

## Roadmap

- [x] Basic TUI with Ink
- [x] Mode switching (plan/build)
- [x] Message display
- [x] Text input
- [x] HAL 9000 mock responses (build mode)
- [ ] Integrate framework with in-process handler
- [ ] Plan mode tools (read_file, glob, grep, git)
- [ ] Session persistence with @effectionx/jsonl-store
- [ ] Streaming responses
- [ ] Tool approval prompts

## See Also

- [Framework Documentation](../../packages/framework/docs/README.md)
- [Isomorphic Tools Guide](../../packages/framework/docs/isomorphic-tools.md)
- [yo-chat Reference App](../yo-chat/README.md)
