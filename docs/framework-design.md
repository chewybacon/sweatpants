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
| **Settlers** | `*settle(ctx)` - yields content to settle |
| **Processors** | `*process(ctx, emit)` - yields to emit progressive enhancements |
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
3. **Rendering** - Processors, settlers, transforms for content rendering
4. **Personas** - Agent personalities with tool/config bundles
5. **Agents** - Higher-level orchestration patterns

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
import { defineIsomorphicTool } from '@dynobase/framework/tools'
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
import { defineProvider } from '@dynobase/framework/providers'

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

## 3. Rendering

### Settler Registration

```ts
// src/rendering/settlers/json-fence.ts
import { defineSettler } from '@dynobase/framework/rendering'

export default defineSettler({
  name: 'json-fence',
  description: 'Settle JSON code blocks for live preview',
  
  // Dependencies on other settlers (for composition)
  extends: 'code-fence',
  
  // The settler implementation
  *settle(ctx) {
    if (ctx.meta?.language === 'json') {
      // Validate JSON as it streams
      try {
        JSON.parse(ctx.pending)
        yield { content: ctx.pending, meta: { ...ctx.meta, validJson: true } }
      } catch {
        // Wait for more content
      }
    }
  },
})
```

### Processor Registration

```ts
// src/rendering/processors/latex.ts
import { defineProcessor } from '@dynobase/framework/rendering'

export default defineProcessor({
  name: 'latex',
  description: 'Render LaTeX math expressions',
  
  // When this processor applies
  match: (ctx) => ctx.meta?.language === 'latex' || ctx.chunk.includes('$$'),
  
  // Dependencies
  after: ['markdown'],  // Run after markdown processor
  
  // The processor implementation
  *process(ctx, emit) {
    const html = yield* renderLatex(ctx.chunk)
    yield* emit({ raw: ctx.chunk, html, pass: 'full' })
  },
})
```

### Transform Composition

```ts
// src/rendering/pipelines/default.ts
import { definePipeline } from '@dynobase/framework/rendering'

export default definePipeline({
  name: 'default',
  
  transforms: [
    { name: 'dual-buffer', settler: 'code-fence', processor: 'shiki' },
    { name: 'mermaid', processor: 'mermaid' },
  ],
  
  // Message renderer for non-streaming content
  messageRenderer: 'markdown',
})
```

### Generated Registry

```ts
// renderingRegistry.gen.ts
export const settlers = { 'code-fence': codeFence, 'json-fence': jsonFence, ... }
export const processors = { 'shiki': shiki, 'mermaid': mermaid, 'latex': latex, ... }
export const pipelines = { 'default': defaultPipeline, ... }
```

---

## 4. Personas

### Definition API

```ts
// src/personas/code-reviewer.ts
import { definePersona } from '@dynobase/framework/personas'

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
  pipeline: 'code-review',  // Uses custom pipeline with diff highlighting
  
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

## 5. Agents (Future - TBD)

Based on the "persona-based" direction, agents could be:

```ts
// src/agents/code-fixer.ts
import { defineAgent } from '@dynobase/framework/agents'

export default defineAgent({
  name: 'code-fixer',
  description: 'Automatically fix code issues',
  
  // Base persona
  persona: 'code-reviewer',
  
  // Agent-specific overrides
  personaConfig: {
    focusAreas: ['bugs', 'security'],
    severityThreshold: 'error',
  },
  
  // Agent orchestration
  loop: {
    maxIterations: 10,
    
    // When to continue
    continueIf: (result) => result.toolCalls?.length > 0,
    
    // When to stop
    stopIf: (result) => result.text.includes('All issues fixed'),
  },
  
  // Memory/context management
  memory: {
    type: 'sliding-window',
    maxTokens: 100_000,
    summarizeAfter: 50_000,
  },
  
  // Hooks for agent lifecycle
  hooks: {
    beforeTurn: (ctx) => { /* logging, metrics */ },
    afterTool: (tool, result) => { /* validation, side effects */ },
    onComplete: (result) => { /* cleanup, reporting */ },
  },
})
```

This is marked TBD - to be refined once the core framework is in place.

---

## Build System

### Vite Plugin

```ts
// packages/dynobase-framework/src/vite/plugin.ts
export function dynobaseFramework(options?: FrameworkOptions): Plugin[] {
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
    settlers/
      json-fence.ts
    processors/
      latex.ts
    pipelines/
      default.ts
      code-review.ts
  
  agents/
    code-fixer.ts

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
```

---

## Migration Path

### Phase 1: Tools Infrastructure
1. Create `defineIsomorphicTool()` unified API
2. Build Vite plugin for discovery
3. Build AST transformer for server/client splitting
4. Generate tool registry
5. Migrate existing tools

### Phase 2: Providers
1. Create `defineProvider()` API
2. Add discovery and registry generation
3. Migrate ollama/openai providers
4. Add runtime selection

### Phase 3: Rendering
1. Create `defineSettler()`, `defineProcessor()`, `definePipeline()` APIs
2. Add discovery for rendering components
3. Generate rendering registry
4. Migrate existing settlers/processors

### Phase 4: Personas
1. Create `definePersona()` API with validation
2. Add discovery and registry generation
3. Add build-time validation (tool references, etc.)
4. Migrate existing personas

### Phase 5: Agents
1. Design agent orchestration patterns
2. Create `defineAgent()` API
3. Implement memory/context management
4. Add agent lifecycle hooks

---

## Open Questions

### Package Structure
Should this be:
- A) Single package `@dynobase/framework` with subpath exports (`/tools`, `/providers`, etc.)
- B) Multiple packages (`@dynobase/tools`, `@dynobase/providers`, etc.)
- C) Internal patterns first, extract to package later

### Naming
Is `@dynobase/framework` the right name, or something else?

### Priority Ordering
Does Phase 1-5 ordering make sense, or should we reorder?

### Agent Design
Should we defer agents entirely until we have real use cases, or sketch more now?

---

## Prior Art / Inspiration

- **Effection** - Structured concurrency primitives; **the foundation of our execution model**
- **TanStack Start** - `createServerFn()` pattern, Vite plugin for server/client splitting
- **tRPC** - Type-safe RPC with build-time extraction
- **Next.js Server Actions** - `"use server"` directive
- **Remix** - Loader/action pattern with automatic code splitting

---

## Appendix: Current State Analysis

### Currently "Library-like" (user wires things together)

| Area | Current Pattern | Issue |
|------|-----------------|-------|
| **Server Tool Registry** | Hard-coded imports in `api.chat.ts` | Adding a tool requires editing framework file |
| **Persona Registry** | Hard-coded object in `personas/index.ts` | Adding a persona requires editing framework file |
| **Processors** | Passed as options to `dualBufferTransform()` | Good, but no discovery mechanism |
| **Settlers** | Passed as options to `dualBufferTransform()` | Good, but no discovery mechanism |
| **Client Handoff Handlers** | Created manually via `createHandoffHandler()` | No auto-discovery from tool definitions |
| **Providers** | Hard-coded list in `getChatProvider()` | Adding provider requires editing framework |
| **Transforms** | Passed as array to session options | Array is awkward for extensibility |

### Currently "Framework-like" (good patterns)

| Area | Pattern | Why it's good |
|------|---------|---------------|
| **Isomorphic Tool Definition** | `defineServerOnlyTool()`, etc. | User defines tools, framework discovers schema & executes |
| **Processor API** | `Processor` type with `ProcessorContext` | Framework calls user code |
| **Settler API** | `Settler` generator pattern | Framework calls user code |
| **Session Lifecycle** | `createChatSession()` resource | Framework manages lifecycle |
