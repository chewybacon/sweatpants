# yo-agent

A CLI-based agentic AI application built on the framework.

## Status

**Coming Soon** - This application is under development.

## Purpose

yo-agent demonstrates the framework's capabilities in a headless/CLI environment:

- **Headless Tools** - Tools with `.context('headless')` that run without UI
- **Agent Tools** - Tools with `.context('agent')` that use `ctx.prompt()` for LLM calls
- **Server-Side Orchestration** - Using `runAsAgent()` for autonomous agent execution
- **Structured Output** - Zod schemas for type-safe LLM responses

## Relationship to yo-chat

While `yo-chat` demonstrates browser-based interactive tools with `ctx.render()`, yo-agent shows the same framework primitives working in a CLI context:

| Feature | yo-chat | yo-agent |
|---------|---------|----------|
| Environment | Browser | CLI/Server |
| User Interaction | `ctx.render()` with React | `ctx.prompt()` with LLM |
| Context Mode | `browser` | `agent` / `headless` |
| UI Framework | React | None (stdout) |

## Architecture

```
┌─────────────────────────────────────────────┐
│                  yo-agent                    │
├─────────────────────────────────────────────┤
│  CLI Interface (stdin/stdout)               │
├─────────────────────────────────────────────┤
│  Agent Runtime (runAsAgent)                 │
├─────────────────────────────────────────────┤
│  Isomorphic Tools                           │
│  - context('headless') - pure computation   │
│  - context('agent') - LLM-powered           │
├─────────────────────────────────────────────┤
│  Framework Core (Effection)                 │
└─────────────────────────────────────────────┘
```

## Getting Started

```bash
# When ready:
cd apps/yo-agent
pnpm install
pnpm dev
```

## See Also

- [Framework Documentation](../../packages/framework/docs/README.md)
- [Isomorphic Tools Guide](../../packages/framework/docs/isomorphic-tools.md)
- [yo-chat Reference App](../yo-chat/README.md)
