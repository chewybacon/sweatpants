# Framework Design

## Vision

A full-featured AI framework where:
- **User code is discovered and executed by the framework** (not manually wired)
- **Build-time code splitting** separates server/client code automatically
- **Extension points are pluggable** without editing framework internals

## Reference Applications

Two demo applications showcase the framework in action:

- **yo-chat** (`apps/yo-chat/`) - Browser-based chat with interactive tools
- **yo-agent** (`apps/yo-agent/`) - CLI-based agent (coming soon)

See [reference-apps.md](./reference-apps.md) for details.

---

## Philosophy: Framework vs Library

In our mental model:
- **Libraries** give you code to execute (you call them)
- **Frameworks** execute your code (they call you)

We want to be a framework. Anywhere we currently rely on user code being manually imported and wired together, we want to make it discoverable and extensible.

---

## Execution Model: Effection & Generators

**Effection and generators are the default execution model throughout the framework.**

### Why Generators?

- **Structured concurrency** - Child tasks are automatically cleaned up when parents complete or error
- **Cancelation** - Operations can be halted at any yield point, with guaranteed cleanup
- **Composability** - Operations compose naturally with `yield*`
- **Testability** - Generator-based code is easier to test than callback/promise chains
- **Backpressure** - Streams and channels provide natural flow control

### Where Generators Are Used

| Extension Point | Generator Usage |
|-----------------|-----------------|
| **Tools** | `*before()`, `*after()`, `*run()`, `*validate()` - all tool execution is generator-based |
| **Providers** | `*stream()` returns `Stream<ChatEvent, ChatResult>` - an Effection stream |
| **Processors** | `*process(frame)` - yields to emit progressive enhancements |
| **Transforms** | `*(input, output)` - consumes and produces via channels |
| **Agent Hooks** | `*beforeTurn()`, `*afterTool()`, `*onComplete()` - lifecycle as operations |

### The Pattern

All user-defined execution code follows this pattern:

```ts
// User defines a generator function
*myOperation(params) {
  // Can yield* to other operations (composability)
  const result = yield* someAsyncWork(params)

  // Can use Effection primitives
  yield* sleep(100)
  const signal = yield* useAbortSignal()

  // Framework handles cancelation, cleanup, errors
  return result
}
```

### Execution Context

The framework provides execution context via Effection's `Context` API:

```ts
// Framework provides context
const RequestContext = createContext<RequestInfo>('request')
const SessionContext = createContext<SessionInfo>('session')

// User code accesses it
*myToolServer(params) {
  const request = yield* RequestContext
  const session = yield* SessionContext
  // ...
}
```

### Streams vs Operations

- **`Operation<T>`** - A single async computation that returns `T`
- **`Stream<T, R>`** - An async iterator that yields `T` values and returns `R` when done

Providers return streams (continuous events), tools return operations (single result).

### React Integration

The React layer bridges generators to React state:

```ts
// useChatSession internally runs Effection
function useChatSession(options) {
  useEffect(() => {
    const task = run(function* () {
      // Effection world - generators
      const session = yield* createChatSession(options)
      for (const state of yield* each(session.state)) {
        setState(state)  // Bridge to React world
        yield* each.next()
      }
    })
    return () => task.halt()
  }, [])
}
```

### No Async/Await in Framework Code

Where possible, avoid `async/await` in favor of generators:

```ts
// Prefer this (generator)
*fetchData(url) {
  const response = yield* call(() => fetch(url))
  return yield* call(() => response.json())
}

// Over this (async/await)
async fetchData(url) {
  const response = await fetch(url)
  return await response.json()
}
```

The generator version integrates with Effection's cancelation and structured concurrency; the async version does not.

### Exception: React Components

React components remain standard functions/JSX. The generator boundary is at the hook level:

```ts
// React component - normal function
function ToolUI({ handoff, respond }) {
  return <button onClick={() => respond({ choice: 'A' })}>Pick A</button>
}

// Hook bridges to generators
function useChatSession() {
  // Effection runs here, exposes React-friendly API
}
```

---

## Core Extension Points

1. **Tools** - Isomorphic tools with server/client separation
2. **Providers** - LLM provider plugins (OpenAI, Ollama, Anthropic, etc.)
3. **Rendering** - Processors and pipelines for content rendering
4. **Personas** - Agent personalities with tool/config bundles
5. **Agents** - Higher-level orchestration patterns (not yet implemented)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Build Time                                   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │  Vite Plugin    │  │  Code Extractor │  │  Registry Generator │  │
│  │  (discovery)    │──│  (AST transform)│──│  (codegen)          │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │
│           │                   │                      │               │
│           ▼                   ▼                      ▼               │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │ tools/*.ts      │  │ server.bundle   │  │ toolRegistry.gen.ts │  │
│  │ personas/*.ts   │  │ client.bundle   │  │ personaRegistry.gen │  │
│  │ providers/*.ts  │  │ (tree-shaken)   │  │ providerRegistry.gen│  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Runtime                                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │ Server Runtime  │  │ Client Runtime  │  │ Shared Runtime      │  │
│  │ - tool.server() │  │ - tool.client() │  │ - schemas           │  │
│  │ - providers     │  │ - components    │  │ - types             │  │
│  │ - personas      │  │ - handlers      │  │ - validation        │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 1. Tools

### Definition API

Tools use the `createIsomorphicTool()` builder pattern. See [isomorphic-tools.md](./isomorphic-tools.md) for the complete API.

```ts
// src/tools/pick-card.tsx
import { createIsomorphicTool, RenderableProps } from '@tanstack/framework/chat/isomorphic-tools'
import { z } from 'zod'

// Co-located React component
interface CardPickerProps extends RenderableProps<{ picked: Card }> {
  cards: Card[]
  prompt: string
}

function CardPicker({ cards, prompt, onRespond, disabled, response }: CardPickerProps) {
  if (disabled && response) {
    return <div>You picked: {response.picked.display}</div>
  }
  return (
    <div>
      <h3>{prompt}</h3>
      {cards.map(card => (
        <button key={card.display} onClick={() => onRespond({ picked: card })}>
          {card.display}
        </button>
      ))}
    </div>
  )
}

// Tool definition using builder pattern
export const pickCard = createIsomorphicTool('pick_card')
  .description('Draw random cards and let the user pick one')
  .parameters(z.object({
    count: z.number().min(2).max(10).default(5),
  }))
  .context('browser')      // Requires UI interaction
  .authority('server')     // Server executes first
  .handoff({
    // Phase 1: Server draws cards (runs once)
    *before(params) {
      const cards = drawUniqueCards(params.count)
      return { cards, prompt: `Pick one of these ${cards.length} cards:` }
    },

    // Client phase: User picks via rendered component
    *client(handoff, ctx) {
      return yield* ctx.render(CardPicker, {
        cards: handoff.cards,
        prompt: handoff.prompt,
      })
    },

    // Phase 2: Server returns result to LLM
    *after(handoff, client) {
      return `The user selected the ${client.picked.rank} of ${client.picked.suit}.`
    },
  })
```

See: `apps/yo-chat/src/tools/pick-card.tsx` for the complete implementation.

### Build-Time Discovery

The Vite plugin:

1. **Discovers** files matching `src/tools/**/*.ts(x)`
2. **Parses** AST to find `createIsomorphicTool()` calls
3. **Generates** `tool-registry.gen.ts` with all discovered tools

**Generated registry:**
```ts
// __generated__/tool-registry.gen.ts
import { pickCard } from '../tools/pick-card'
import { startTttGame, tttMove, tttWinner } from '../tools/games/tic-tac-toe'
// ... auto-discovered

export const tools = [
  pickCard,
  startTttGame,
  tttMove,
  tttWinner,
  // ...
]
```

See: `apps/yo-chat/src/__generated__/tool-registry.gen.ts`

### Tool Categories

| Type | Authority | Context | Example |
|------|-----------|---------|---------|
| Server-only | server | headless | calculator, search |
| Server with handoff | server | browser | pick_card, tic-tac-toe |
| Agent tool | server | agent | sentiment analyzer |
| Client-authority | client | browser | file_picker |

See [isomorphic-tools.md](./isomorphic-tools.md) for detailed patterns.

---

## 2. Providers

### Definition API

```ts
// src/providers/anthropic.ts
import { defineProvider } from '@tanstack/framework/providers'

export default defineProvider({
  name: 'anthropic',

  // When to use this provider
  match: (config) => config.provider === 'anthropic',

  // Provider capabilities
  capabilities: {
    thinking: true,
    toolCalling: true,
    vision: true,
    streaming: true,
  },

  // Required config (validated at startup)
  configSchema: z.object({
    apiKey: z.string(),
    model: z.string().default('claude-3-5-sonnet-20241022'),
    baseUrl: z.string().optional(),
  }),

  // The streaming implementation
  *stream(messages, options) {
    // Return Stream<ChatEvent, ChatResult>
  },
})
```

### Discovery & Selection

```ts
// providerRegistry.gen.ts
import anthropic from './providers/anthropic'
import openai from './providers/openai'
import ollama from './providers/ollama'

export const providers = [anthropic, openai, ollama]

export function getProvider(config: ProviderConfig): ChatProvider {
  const provider = providers.find(p => p.match(config))
  if (!provider) throw new Error(`No provider matches config`)
  return provider
}
```

### Runtime Selection

```ts
// Config from environment or request
const config = { provider: 'anthropic', apiKey: process.env.ANTHROPIC_KEY }
const provider = getProvider(config)

// Use provider
const stream = provider.stream(messages, { tools: [...] })
```

---

## 3. Rendering (Frame-Based Pipeline)

The rendering system has been completely redesigned around **immutable frames** and **processor pipelines**.

### Overview

```
Raw Tokens → Parser → Frame₀ → [Processors] → Frame₁ → Frame₂ → UI
                                    ↓
                              Progressive Enhancement
                              (quick → full passes)
```

### Core Concepts

#### Frames

A **Frame** is an immutable snapshot of the document at a point in time:

```ts
interface Frame {
  id: string                    // Unique identifier
  blocks: Block[]               // Content blocks
  timestamp: number             // When created
  trace: TraceEntry[]           // Debug info
  activeBlockIndex: number|null // Currently streaming block
}
```

Frames are immutable - each update creates a new frame. This eliminates content duplication bugs and enables clean UI rendering.

#### Blocks

A **Block** is the unit of content within a frame:

```ts
interface Block {
  id: string           // Stable across frames
  type: 'text'|'code'  // Block type
  raw: string          // Raw markdown/code
  html: string         // Rendered HTML
  status: 'streaming'|'complete'
  renderPass: 'none'|'quick'|'full'
  language?: string    // For code blocks
  annotations?: Annotation[]
  meta?: Record<string, unknown>
}
```

Blocks are parsed automatically from streaming content. Code fences create `code` blocks; everything else is `text`.

#### Processors

A **Processor** is a self-contained processing unit that transforms frames:

```ts
interface Processor {
  name: string
  description?: string
  dependencies?: string[]     // Auto-resolved order
  preload?: () => Operation<void>
  isReady?: () => boolean
  process: (frame: Frame) => Operation<Frame>
}
```

Processors declare dependencies, and the pipeline resolves them via topological sort.

### Processor Definition

Processors are objects implementing the `Processor` interface:

```ts
// src/react/chat/pipeline/processors/markdown.ts
import type { Processor } from '../types'

export const markdown: Processor = {
  name: 'markdown',
  description: 'Convert markdown to HTML',

  // No dependencies - runs first
  dependencies: [],

  // Check if ready
  isReady: () => true,

  // Process frames
  *process(frame) {
    return updateFrame(frame, (block) => {
      if (block.type === 'text' && !block.html) {
        const html = marked(block.raw)
        return setBlockHtml(block, html, 'quick')
      }
      return block
    })
  },
}
```

See: `src/react/chat/pipeline/processors/` for built-in processors.

### Built-in Processors

| Processor | Purpose | Dependencies |
|-----------|---------|--------------|
| `markdown` | Parse markdown to HTML | none |
| `shiki` | Syntax highlighting | markdown |
| `mermaid` | Diagram rendering | markdown |
| `math` | KaTeX math rendering | markdown |

### Pipeline Configuration

```ts
import { useChat } from '@tanstack/framework/react/chat'

// Use a preset
useChat({
  pipeline: 'full'  // = markdown + shiki + mermaid + math
})

// Or explicit processors
import { markdown, shiki, mermaid } from '@tanstack/framework/react/chat/pipeline'

useChat({
  pipeline: { processors: [markdown, shiki, mermaid] }
})
```

See: `src/react/chat/useChat.ts` for pipeline options.

### Progressive Enhancement

Frames support progressive enhancement via `renderPass`:

| Render Pass | Purpose | Performance |
|-------------|---------|-------------|
| `none` | Raw content only | Instant |
| `quick` | Fast regex-based rendering | ~10-50ms |
| `full` | Complete async rendering | ~100-500ms+ |

The UI receives frames at each pass level and can animate between them:

```tsx
function ChatMessage({ frame }) {
  return (
    <div className="chat-message">
      {frame.blocks.map(block => (
        <div
          key={block.id}
          className={`render-${block.renderPass}`}
          dangerouslySetInnerHTML={{ __html: block.html }}
        />
      ))}
    </div>
  )
}
```

### Generated Registry

```ts
// renderingRegistry.gen.ts
export const processors = {
  'markdown': markdownProcessor,
  'shiki': shikiProcessor,
  'mermaid': mermaidProcessor,
  'math': mathProcessor,
}
```

---

## 4. Personas

### Definition API

```ts
// src/personas/code-reviewer.ts
import { definePersona } from '@tanstack/framework/personas'

export default definePersona({
  name: 'code-reviewer',
  description: 'Reviews code for quality, security, and best practices',

  // Dynamic system prompt
  systemPrompt: ({ config }) => `
    You are a code reviewer. Focus on:
    ${config.focusAreas.map(a => `- ${a}`).join('\n')}

    Severity threshold: ${config.severityThreshold}
  `,

  // Required tools (must exist in tool registry)
  requiredTools: ['read_file', 'search_code', 'run_linter'],

  // Optional tools user can enable
  optionalTools: ['write_file', 'create_pr_comment'],

  // Configurable options
  configSchema: z.object({
    focusAreas: z.array(z.enum(['security', 'performance', 'style', 'bugs'])),
    severityThreshold: z.enum(['info', 'warning', 'error']).default('warning'),
  }),

  // Effort levels (model selection)
  effortLevels: {
    low: { models: ['gpt-4o-mini', 'claude-3-haiku'] },
    medium: { models: ['gpt-4o', 'claude-3-5-sonnet'] },
    high: { models: ['o1', 'claude-3-opus'] },
  },

  // Rendering pipeline for this persona
  pipeline: 'code-review',

  // Provider requirements
  requires: {
    thinking: false,
    toolCalling: true,
  },
})
```

### Validation

At build time, the framework validates:
- All `requiredTools` exist in tool registry
- All `optionalTools` exist in tool registry
- Referenced `pipeline` exists in rendering registry
- Config schema is valid

---

## 5. Agents (Future - Not Yet Implemented)

The Agents extension point is not yet implemented. Once the core framework is stable, agents will provide higher-level orchestration patterns on top of personas.

---

## Build System

### Vite Plugin

```ts
// packages/framework/src/vite/plugin.ts
export function sweatpantsFramework(options?: FrameworkOptions): Plugin[] {
  return [
    // Discovery: scan for tools, personas, providers, rendering
    discoveryPlugin(options),

    // Code splitting: extract server code from isomorphic tools
    serverExtractionPlugin(options),

    // Codegen: generate registries
    registryGeneratorPlugin(options),

    // Post-build: final transformations (like start-env)
    postBuildPlugin(options),
  ]
}
```

### Directory Convention

```
src/
  tools/
    calculator.ts
    search.ts
    guess-card/
      index.ts
      component.tsx

  providers/
    ollama.ts
    openai.ts
    anthropic.ts

  personas/
    general.ts
    code-reviewer.ts
    math-assistant.ts

  rendering/
    processors/
      custom.ts
    pipelines/
      default.ts
      code-review.ts

  agents/
    code-fixer.ts  // Not yet implemented

  # Generated (gitignored)
  __generated__/
    toolRegistry.gen.ts
    providerRegistry.gen.ts
    personaRegistry.gen.ts
    renderingRegistry.gen.ts
```

### Generated Type Safety

```ts
// __generated__/types.gen.ts
export type ToolName = 'calculator' | 'search' | 'guess_card' | ...
export type PersonaName = 'general' | 'code-reviewer' | 'math-assistant' | ...
export type ProviderName = 'ollama' | 'openai' | 'anthropic' | ...
export type PipelineName = 'default' | 'code-review' | ...
export type ProcessorName = 'markdown' | 'shiki' | 'mermaid' | 'math' | ...
```

---

## Implementation Status

### Complete

- **Tools Infrastructure** - `createIsomorphicTool()` builder API, Vite plugin discovery, registry generation
- **Rendering Pipeline** - Frame-based architecture, processors, progressive enhancement
- **React Integration** - `useChat()` / `useChatSession()` hooks
- **Context Modes** - `headless`, `browser`, `agent` with type-safe contexts
- **Browser Interaction** - `ctx.render()` pattern with `RenderableProps<T>`
- **Agent Runtime** - `runAsAgent()` for server-side agent execution

### In Progress

- **yo-agent CLI** - CLI-based agent application (`apps/yo-agent/`)

### Future

- **Personas** - Agent personality bundles with tool/config presets
- **Memory/Context** - Persistent agent memory across sessions

---

## Package Structure

The framework exports:

```ts
// Isomorphic tools
import {
  createIsomorphicTool,
  RenderableProps,
} from '@tanstack/framework/chat/isomorphic-tools'

// Pipeline processors
import {
  markdown, shiki, mermaid, math
} from '@tanstack/framework/react/chat/pipeline'

// React hooks
import { useChat, useChatSession } from '@tanstack/framework/react/chat'
```

See: `src/lib/chat/isomorphic-tools/index.ts` for full exports.

---

## Prior Art / Inspiration

- **Effection** - Structured concurrency primitives; **the foundation of our execution model**
- **TanStack Start** - `createServerFn()` pattern, Vite plugin for server/client splitting
- **tRPC** - Type-safe RPC with build-time extraction
- **Next.js Server Actions** - `"use server"` directive
- **Remix** - Loader/action pattern with automatic code splitting

---

## Appendix: Rendering Architecture Migration

### Old Architecture (Dual Buffer + Settlers)

```
Raw Stream → Settler (when to settle?) → Buffer (pending/settled) → Processor → UI
```

- **Settlers** decided when content could move from pending to settled
- **Processors** enhanced settled content linearly
- **Mutable buffers** caused content duplication bugs at code fence transitions
- **Manual configuration** of settler/processor pairs

### New Architecture (Frame-Based Pipeline)

```
Raw Tokens → Parser (auto structure) → Frame₀ → [Processors in DAG order] → Frame₁ → UI
```

- **Parser** automatically detects code fences and creates block structure
- **Processors** declare dependencies, pipeline resolves order automatically
- **Immutable frames** eliminate content duplication bugs
- **Progressive enhancement** built into render passes (quick → full)
- **Clean separation**: Parser handles structure, processors handle enhancement

### Key Difference

| Aspect | Old | New |
|--------|-----|-----|
| State | Mutable buffers | Immutable frames |
| Structure | Settler negotiation | Automatic parsing |
| Composition | Linear chains | DAG-based resolution |
| Enhancement | Separate emissions | Built-in render passes |
| Content bugs | Common at fences | Impossible (immutability) |

## Documentation Index

- [README.md](./README.md) - Quick start and overview
- [isomorphic-tools.md](./isomorphic-tools.md) - Tool builder API and patterns
- [pipeline-guide.md](./pipeline-guide.md) - Streaming pipeline details
- [rendering-engine-design.md](./rendering-engine-design.md) - Internal rendering architecture
- [reference-apps.md](./reference-apps.md) - yo-chat and yo-agent details
