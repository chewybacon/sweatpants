# Framework Design Plan

## Vision

A full-featured AI framework where:
- **User code is discovered and executed by the framework** (not manually wired)
- **Build-time code splitting** separates server/client code automatically
- **Extension points are pluggable** without editing framework internals

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

```ts
// src/tools/guess-card.ts
import { defineIsomorphicTool } from '@tanstack/framework/tools'
import { z } from 'zod'

export default defineIsomorphicTool({
  name: 'guess_card',
  description: 'Play a card guessing game',
  parameters: z.object({
    difficulty: z.enum(['easy', 'hard']).default('easy'),
  }),
  authority: 'server',
  
  // Server-only code (extracted to server bundle)
  server: {
    *before({ difficulty }) {
      const secret = pickRandomCard(difficulty)
      const choices = generateChoices(secret, difficulty)
      return { secret, choices }  // → handoff to client
    },
    *after(handoff, clientOutput) {
      const correct = clientOutput.guess === handoff.secret
      return { correct, secret: handoff.secret }  // → LLM result
    },
  },
  
  // Client-only code (stays in client bundle)
  client: {
    // Effection operation for headless execution
    *run(handoff, ctx) {
      // Default client behavior (can be overridden by UI)
      return { guess: handoff.choices[0] }
    },
    // Optional React component for interactive UI
    component: GuessCardUI,
  },
})

// Co-located React component
function GuessCardUI({ handoff, params, respond }: ToolUIProps<typeof tool>) {
  return (
    <div>
      <h3>Pick a card!</h3>
      {handoff.choices.map(card => (
        <button key={card} onClick={() => respond({ guess: card })}>
          {card}
        </button>
      ))}
    </div>
  )
}
```

### Build-Time Extraction

The Vite plugin:

1. **Discovers** files matching `src/tools/**/*.ts`
2. **Parses** AST to find `defineIsomorphicTool()` calls
3. **Extracts** `server` block to server-only module
4. **Replaces** `server` in client bundle with RPC stub
5. **Generates** `toolRegistry.gen.ts` with all discovered tools

**Server bundle output:**
```ts
// tools/guess-card.server.ts (generated)
export const guessCard_server = {
  *before({ difficulty }) { /* original code */ },
  *after(handoff, clientOutput) { /* original code */ },
}
```

**Client bundle output:**
```ts
// tools/guess-card.ts (transformed)
export default {
  name: 'guess_card',
  description: '...',
  parameters: /* schema */,
  authority: 'server',
  server: null,  // Removed - server code not in client bundle
  client: {
    *run(handoff, ctx) { /* original code */ },
    component: GuessCardUI,
  },
}
```

**Generated registry:**
```ts
// toolRegistry.gen.ts
import guessCard from './tools/guess-card'
import calculator from './tools/calculator'
// ... auto-discovered

export const toolRegistry = createToolRegistry([
  guessCard,
  calculator,
  // ...
])

export const serverToolRegistry = createServerToolRegistry({
  'guess_card': () => import('./tools/guess-card.server'),
  'calculator': () => import('./tools/calculator.server'),
})
```

### Tool Categories

| Type | Authority | Server Code | Client Code | Example |
|------|-----------|-------------|-------------|---------|
| Server-only | server | `server()` | none | calculator, search |
| Server-authority with handoff | server | `before()` + `after()` | `client.run()` + `component` | guess_card |
| Client-authority | client | `validate()` (optional) | `client.run()` + `component` | file_picker |
| Client-only | client | none | `client.run()` + `component` | clipboard |

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

### Processor Registration

```ts
// src/rendering/processors/markdown.ts
import { defineProcessor } from '@tanstack/framework/react/chat/pipeline'

export const markdown = defineProcessor({
  name: 'markdown',
  description: 'Convert markdown to HTML',
  
  // No dependencies - runs first
  dependencies: [],
  
  // Preload async assets
  *preload() {
    // Load marked or remark if needed
  },
  
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
})
```

### Built-in Processors

| Processor | Purpose | Dependencies |
|-----------|---------|--------------|
| `markdown` | Parse markdown to HTML | none |
| `shiki` | Syntax highlighting | markdown |
| `mermaid` | Diagram rendering | markdown |
| `math` | KaTeX math rendering | markdown |

### Pipeline Configuration

```ts
// Simple - list processors, dependencies auto-resolved
useChat({
  processors: [markdown, shiki, mermaid]
})

// Or use a preset
useChat({
  processors: 'full'  // = [markdown, shiki, mermaid, math]
})

// Custom processor with dependencies
useChat({
  processors: [
    markdown,
    shiki,
    {
      name: 'custom-highlight',
      dependencies: ['markdown', 'shiki'],
      *process(frame) { /* ... */ }
    }
  ]
})
```

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

## Migration Path

### Phase 1: Tools Infrastructure (Complete)
1. Create `defineIsomorphicTool()` unified API
2. Build Vite plugin for discovery
3. Build AST transformer for server/client splitting
4. Generate tool registry
5. Migrate existing tools

### Phase 2: Providers (Complete)
1. Create `defineProvider()` API
2. Add discovery and registry generation
3. Migrate ollama/openai providers
4. Add runtime selection

### Phase 3: Rendering (Complete - New Architecture)
1. Create `defineProcessor()` API with dependency resolution
2. Implement frame-based pipeline architecture
3. Add progressive enhancement (quick → full passes)
4. Migrate from settlers/processors to pipeline
5. **Parser now handles structure detection automatically**

### Phase 4: Personas (In Progress)
1. Create `definePersona()` API with validation
2. Add discovery and registry generation
3. Add build-time validation (tool references, etc.)
4. Migrate existing personas

### Phase 5: Agents (Future)
1. Design agent orchestration patterns
2. Create `defineAgent()` API
3. Implement memory/context management
4. Add agent lifecycle hooks

---

## Package Structure

The framework is published as `@tanstack/framework` with subpath exports:

```ts
import { defineIsomorphicTool } from '@tanstack/framework/tools'
import { defineProvider } from '@tanstack/framework/providers'
import { definePersona } from '@tanstack/framework/personas'
import { markdown, shiki, mermaid } from '@tanstack/framework/react/chat/pipeline'
import { useChat } from '@tanstack/framework/react/chat'
```

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

### Key Differences

| Aspect | Old | New |
|--------|-----|-----|
| State | Mutable buffers | Immutable frames |
| Structure | Settler negotiation | Automatic parsing |
| Composition | Linear chains | DAG-based resolution |
| Enhancement | Separate emissions | Built-in render passes |
| Content bugs | Common at fences | Impossible (immutability) |

### Migration Guide

See [migration-guide.md](./migration-guide.md) for detailed migration instructions from settlers/dualBufferTransform to the new pipeline.
