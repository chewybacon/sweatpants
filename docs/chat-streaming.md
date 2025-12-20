# Chat Streaming System

A structured concurrency-based chat streaming system built with [Effection](https://frontside.com/effection). It provides smooth streaming of LLM responses with intelligent buffering, progressive rendering, and comprehensive testing support.

## Overview

The system implements a **dual buffer pattern** (similar to double buffering in game rendering) to provide smooth streaming of chat content:

```
┌─────────────────────┐     ┌─────────────────────┐
│  Pending Buffer     │     │  Settled Buffer     │
│  (accumulating)     │ ──► │  (displayed as MD)  │
│  raw text + cursor  │swap │  parsed, rendered   │
└─────────────────────┘     └─────────────────────┘
```

**Key benefits:**
- Content settles at natural boundaries (paragraphs, sentences, code blocks)
- Settled content can be safely parsed as markdown
- Pending content shows with a typing cursor
- No flickering or partial markdown rendering

## Architecture

```
React Component
      │
      ▼
┌─────────────────────────────────────────────────────────────────┐
│  useChatSession()                                               │
│  ┌────────────┐    ┌──────────────┐    ┌────────────────────┐  │
│  │  Commands  │───►│   Session    │───►│  Patches           │  │
│  │  (Signal)  │    │  Runtime     │    │  (Channel)         │  │
│  └────────────┘    └──────────────┘    └────────────────────┘  │
│                           │                     │               │
│                           ▼                     ▼               │
│                    ┌──────────────┐    ┌────────────────────┐  │
│                    │  Streamer    │    │  Transform         │  │
│                    │  (fetch/test)│    │  Pipeline          │  │
│                    └──────────────┘    └────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### Basic Usage

```typescript
import { useChatSession, dualBufferTransform, paragraph, markdown } from './chat'

function ChatComponent() {
  const { state, send, abort, reset } = useChatSession({
    transforms: [
      dualBufferTransform({
        settler: paragraph(),
        processor: markdown(),
      }),
    ],
  })

  return (
    <div>
      {/* Rendered markdown (settled content) */}
      <div dangerouslySetInnerHTML={{ __html: state.buffer.settledHtml }} />
      
      {/* Typing indicator (pending content) */}
      {state.buffer.pending && (
        <span className="pending">{state.buffer.pending}▊</span>
      )}
      
      <button onClick={() => send('Hello!')}>Send</button>
    </div>
  )
}
```

### With Code Fence Awareness

```typescript
import { 
  useChatSession, 
  dualBufferTransform, 
  codeFence, 
  syntaxHighlight 
} from './chat'

const { state, send } = useChatSession({
  transforms: [
    dualBufferTransform({
      settler: codeFence(),        // Line-by-line in code, paragraph outside
      processor: syntaxHighlight(), // Progressive syntax highlighting
    }),
  ],
})
```

## Core Concepts

### Settlers

Settlers decide **when** and **what** content moves from pending to settled. They are generator functions that yield content to settle.

```typescript
// Built-in settlers
import { paragraph, sentence, line, timeout, maxSize, codeFence } from './settlers'

// Paragraph: settle on \n\n
dualBufferTransform({ settler: paragraph() })

// Sentence: settle on . ? ! followed by space
dualBufferTransform({ settler: sentence() })

// Line: settle on each \n
dualBufferTransform({ settler: line() })

// Timeout: settle everything after 150ms
dualBufferTransform({ settler: timeout(150) })

// Max size: settle when buffer exceeds 500 chars
dualBufferTransform({ settler: maxSize(500) })

// Code fence: smart mode - lines in code, paragraphs outside
dualBufferTransform({ settler: codeFence() })
```

**Combinators:**

```typescript
import { any, all } from './settlers'

// OR: settle on paragraph OR after 200ms timeout (whichever first)
any(paragraph(), timeout(200))

// AND: settle on paragraph BUT only after 100ms has passed
all(timeout(100), paragraph())
```

See [settlers.md](./settlers.md) for detailed documentation.

### Processors

Processors enrich settled content with additional data (HTML, AST, syntax highlighting). They are Effection Operations that can do async work and emit multiple times for progressive enhancement.

```typescript
// Built-in processors
import { passthrough, markdown, incrementalMarkdown, smartMarkdown, syntaxHighlight } from './processors'

// No processing - just pass through raw content
dualBufferTransform({ processor: passthrough() })

// Parse full accumulated content as markdown
dualBufferTransform({ processor: markdown() })

// Parse only the new chunk (faster, less context-aware)
dualBufferTransform({ processor: incrementalMarkdown() })

// Smart: skip markdown in code fences (use with codeFence settler)
dualBufferTransform({ processor: smartMarkdown() })

// Progressive syntax highlighting (quick pass → full pass)
dualBufferTransform({ settler: codeFence(), processor: syntaxHighlight() })
```

See [processors.md](./processors.md) for detailed documentation.

### Transforms

Transforms are pipeline stages that process patches before they reach React state. The dual buffer is itself a transform.

```typescript
import { useTransformPipeline, loggingTransform } from './transforms'

// Multiple transforms in sequence
useChatSession({
  transforms: [
    loggingTransform('raw'),           // Debug: log raw patches
    dualBufferTransform({ ... }),      // Buffer and process
    loggingTransform('processed'),     // Debug: log processed patches
  ],
})
```

## Message Rendering

For completed messages (not streaming), use the `renderer` option:

```typescript
import { markdownRenderer, mathRenderer } from './processors'

useChatSession({
  renderer: markdownRenderer(),  // Markdown only
  // OR
  renderer: mathRenderer(),      // Markdown + LaTeX math
})

// Access rendered content
const messageHtml = state.rendered[message.id]?.output
```

## State Shape

```typescript
interface ChatState {
  messages: ChatMessage[]
  rendered: Record<string, { output?: string }>
  
  // Current streaming state
  isStreaming: boolean
  currentResponse: ResponseStep[]
  activeStep: ActiveStep | null
  
  // Dual buffer state (when using dualBufferTransform)
  buffer: {
    settled: string      // Content safe to parse as markdown
    pending: string      // Content still streaming
    settledHtml: string  // Parsed HTML (when using markdown processor)
  }
  
  error: string | null
  capabilities: Capabilities | null
  persona: string | null
}
```

## Commands

```typescript
const { send, abort, reset } = useChatSession()

send('Hello!')   // Send a message
abort()          // Cancel current streaming
reset()          // Clear history and reset state
```

## Patch Types

The system emits these patch types:

| Patch Type | Description |
|------------|-------------|
| `user_message` | User message added |
| `streaming_start` | Streaming began |
| `streaming_text` | Text chunk received |
| `streaming_thinking` | Thinking chunk received |
| `streaming_end` | Streaming complete |
| `assistant_message` | Assistant message finalized |
| `buffer_settled` | Content moved to settled buffer |
| `buffer_pending` | Pending buffer updated |
| `tool_call_start` | Tool call started |
| `tool_call_result` | Tool call completed |
| `tool_call_error` | Tool call failed |
| `error` | Error occurred |
| `reset` | Session reset |

## Testing

The system provides test utilities for comprehensive e2e testing without network dependencies.

```typescript
import { run, createSignal, createChannel, spawn, each, sleep } from 'effection'
import { runChatSession, createTestStreamer, dualBufferTransform } from './chat'

it('should stream and buffer content', async () => {
  const result = await run(function* () {
    const { streamer, controls } = createTestStreamer()
    const commands = createSignal<ChatCommand, void>()
    const patches = createChannel<ChatPatch, void>()
    const received: ChatPatch[] = []

    // Collect patches
    yield* spawn(function* () {
      for (const patch of yield* each(patches)) {
        received.push(patch)
        yield* each.next()
      }
    })

    // Run session
    yield* spawn(function* () {
      yield* runChatSession(commands, patches, {
        streamer,
        transforms: [dualBufferTransform()],
      })
    })

    // Send message
    commands.send({ type: 'send', content: 'Hello' })
    yield* sleep(10)

    // Step through streaming
    yield* controls.emit({ type: 'text', content: 'First paragraph.\n\n' })
    yield* controls.emit({ type: 'text', content: 'Second paragraph.' })
    yield* controls.complete('First paragraph.\n\nSecond paragraph.')

    yield* sleep(50)
    return received
  })

  // Assert on received patches
  expect(result.some(p => p.type === 'buffer_settled')).toBe(true)
})
```

See [testing.md](./testing.md) for detailed testing documentation.

## File Structure

```
apps/dynobase/src/demo/effection/chat/
├── index.ts           # Public exports
├── types.ts           # Type definitions
├── session.ts         # Chat session runtime
├── useChatSession.ts  # React hook
├── transforms.ts      # Transform pipeline utilities
├── dualBuffer.ts      # Dual buffer transform
├── settlers.ts        # Built-in settlers
├── processors.ts      # Built-in processors
├── streamChatOnce.ts  # Fetch-based streamer
├── readNdjson.ts      # NDJSON stream parser
├── testing.ts         # Test utilities
├── usePersonas.ts     # Persona management
├── shiki/             # Shiki syntax highlighting
│   ├── index.ts
│   ├── loader.ts
│   ├── processor.ts
│   └── settlers.ts
└── __tests__/         # Test suite
    ├── settlers.test.ts
    ├── processors.test.ts
    ├── session-e2e.test.ts
    ├── edge-cases.test.ts
    ├── readNdjson.test.ts
    └── ...
```

## Advanced: Custom Settler

```typescript
import type { Settler, SettleContext } from './types'

// Custom settler: settle after each word
function word(): Settler {
  return function* ({ pending }: SettleContext) {
    const pattern = /\s+/g
    let lastEnd = 0
    let match: RegExpExecArray | null

    while ((match = pattern.exec(pending)) !== null) {
      const endIdx = match.index + match[0].length
      yield pending.slice(lastEnd, endIdx)
      lastEnd = endIdx
    }
  }
}
```

## Advanced: Custom Processor

```typescript
import type { Processor, ProcessorContext, ProcessorEmit } from './types'

// Custom processor with progressive enhancement
function myProcessor(): Processor {
  return function* (ctx: ProcessorContext, emit: ProcessorEmit) {
    // Quick pass - immediate
    yield* emit({ 
      raw: ctx.chunk, 
      html: quickTransform(ctx.chunk), 
      pass: 'quick' 
    })

    // Full pass - after async work
    const html = yield* call(() => expensiveTransform(ctx.chunk))
    yield* emit({ 
      raw: ctx.chunk, 
      html, 
      pass: 'full' 
    })
  }
}
```

## Structured Concurrency

The system uses Effection's structured concurrency model:

- **Automatic cleanup**: When the React component unmounts, all spawned tasks (streaming, transforms) are automatically halted
- **No resource leaks**: Fetch requests, channels, and timers are cleaned up automatically
- **Cancellation propagates**: Aborting a stream halts all child operations

```typescript
// When abort() is called:
// 1. currentRequestTask.halt() is called
// 2. This propagates to all spawned children
// 3. fetch is aborted, channels closed, finally blocks run
// 4. No manual cleanup needed
```

## Related Documentation

- [settlers.md](./settlers.md) - Detailed settler documentation
- [processors.md](./processors.md) - Detailed processor documentation  
- [testing.md](./testing.md) - Testing guide and utilities
