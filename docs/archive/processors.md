# Processors

Processors enrich settled content with additional data like parsed HTML, syntax highlighting, or AST representations. They are Effection Operations that can perform async work and emit multiple times for progressive enhancement.

## Concept

A processor receives context about the settled content and emits enriched output:

```typescript
type Processor = (ctx: ProcessorContext, emit: ProcessorEmit) => Operation<void>

interface ProcessorContext {
  chunk: string       // The content that just settled
  accumulated: string // Previously settled content
  next: string        // Full content after this chunk (accumulated + chunk)
  meta?: SettleMeta   // Metadata from the settler (e.g., code fence info)
}

interface ProcessedOutput {
  raw: string         // Original content (always present)
  html?: string       // Parsed HTML
  ast?: unknown       // Parsed AST
  pass?: 'quick' | 'full'  // Progressive enhancement pass
  [key: string]: unknown   // Additional fields
}

type ProcessorEmit = (output: ProcessedOutput) => Operation<void>
```

### Key Features

- **Async support**: Processors are Effection Operations, so they can `yield*` async work
- **Multiple emissions**: Emit multiple times for progressive enhancement
- **Metadata access**: Receive context from metadata-aware settlers
- **Immediate delivery**: Each `emit()` sends immediately to the client

## Built-in Processors

### `passthrough()`

No processing - returns raw content unchanged. This is the **default processor**.

```typescript
import { passthrough } from './processors'

dualBufferTransform({ processor: passthrough() })
```

**Output:**
```typescript
{ raw: "Hello world" }
```

### `markdown()`

Parses the full accumulated content as markdown using [marked](https://marked.js.org/).

```typescript
import { markdown } from './processors'

dualBufferTransform({ 
  settler: paragraph(),
  processor: markdown() 
})
```

**Behavior:**
- Parses `ctx.next` (all settled content) to ensure proper markdown context
- Synchronous parsing (no async overhead)

**Output:**
```typescript
{ 
  raw: "# Hello\n\nWorld",
  html: "<h1>Hello</h1>\n<p>World</p>\n"
}
```

### `incrementalMarkdown()`

Parses only the new chunk as markdown (faster, less context-aware).

```typescript
import { incrementalMarkdown } from './processors'

dualBufferTransform({ processor: incrementalMarkdown() })
```

**When to use:**
- When each settled chunk is self-contained
- For performance-critical scenarios
- When you don't need cross-chunk markdown features (like multi-paragraph lists)

### `smartMarkdown()`

Context-aware markdown that skips code fences. Best used with `codeFence()` settler.

```typescript
import { smartMarkdown } from './processors'
import { codeFence } from './settlers'

dualBufferTransform({ 
  settler: codeFence(),
  processor: smartMarkdown() 
})
```

**Behavior:**
- If `ctx.meta?.inCodeFence` is true, passes through raw content
- Otherwise, parses as markdown
- Prevents markdown from mangling code content

### `syntaxHighlight()`

Progressive syntax highlighting with quick and full passes.

```typescript
import { syntaxHighlight } from './processors'
import { codeFence } from './settlers'

dualBufferTransform({ 
  settler: codeFence(),
  processor: syntaxHighlight() 
})
```

**Behavior:**
1. **Quick pass**: Instant regex-based highlighting (sent immediately)
2. **Full pass**: Detailed highlighting (sent after async processing)

**Output (two emissions):**
```typescript
// First emission (immediate)
{ raw: "def foo():", html: "<span class=\"kw\">def</span> foo():", pass: 'quick' }

// Second emission (after async work)
{ raw: "def foo():", html: "<span class=\"keyword\">def</span> <span class=\"function\">foo</span>():", pass: 'full' }
```

### `mathMarkdown()`

Markdown with LaTeX math support using [KaTeX](https://katex.org/).

```typescript
import { mathMarkdown } from './processors'

dualBufferTransform({ processor: mathMarkdown() })
```

**Supports:**
- Display math: `$$...$$` or `\[...\]`
- Inline math: `$...$` or `\(...\)`

**Example:**
```typescript
// Input
"The formula is $E = mc^2$ and:\n\n$$\\int_0^1 x^2 dx = \\frac{1}{3}$$"

// Output includes rendered KaTeX HTML
{ raw: "...", html: "<p>The formula is <span class=\"katex\">...</span>...</p>" }
```

## Message Renderers

For completed messages (not streaming), use message renderers with the `renderer` option:

### `markdownRenderer()`

```typescript
import { markdownRenderer } from './processors'

useChatSession({
  renderer: markdownRenderer()
})

// Access rendered content
const html = state.rendered[message.id]?.output
```

### `mathRenderer()`

```typescript
import { mathRenderer } from './processors'

useChatSession({
  renderer: mathRenderer()  // Markdown + LaTeX math
})
```

## Progressive Enhancement Pattern

The key innovation of the processor system is **progressive enhancement** - sending quick results immediately while async work happens in the background.

```typescript
function myProcessor(): Processor {
  return function* (ctx, emit) {
    // Quick pass - instant, sent immediately
    const quickHtml = fastTransform(ctx.chunk)
    yield* emit({ raw: ctx.chunk, html: quickHtml, pass: 'quick' })

    // Full pass - async work, sent when ready
    const fullHtml = yield* call(() => expensiveAsyncTransform(ctx.chunk))
    yield* emit({ raw: ctx.chunk, html: fullHtml, pass: 'full' })
  }
}
```

**Client-side handling:**

```tsx
function MessageContent({ patches }) {
  const [content, setContent] = useState({ html: '', pass: null })

  useEffect(() => {
    for (const patch of patches) {
      if (patch.type === 'buffer_settled') {
        // Always update with latest pass (full replaces quick)
        setContent({ html: patch.html, pass: patch.pass })
      }
    }
  }, [patches])

  return (
    <div 
      className={content.pass === 'quick' ? 'loading' : ''}
      dangerouslySetInnerHTML={{ __html: content.html }}
    />
  )
}
```

## Custom Processors

### Simple Processor

```typescript
import type { Processor } from './types'

// Uppercase processor
function uppercase(): Processor {
  return function* (ctx, emit) {
    yield* emit({ 
      raw: ctx.chunk, 
      html: ctx.chunk.toUpperCase() 
    })
  }
}
```

### Async Processor

```typescript
import { call } from 'effection'

function translateProcessor(targetLang: string): Processor {
  return function* (ctx, emit) {
    // Emit original immediately
    yield* emit({ raw: ctx.chunk, pass: 'quick' })

    // Translate asynchronously
    const translated = yield* call(() => 
      translateAPI(ctx.chunk, targetLang)
    )
    
    yield* emit({ 
      raw: ctx.chunk, 
      translated, 
      pass: 'full' 
    })
  }
}
```

### Metadata-Aware Processor

```typescript
function smartCodeProcessor(): Processor {
  return function* (ctx, emit) {
    if (ctx.meta?.inCodeFence) {
      // Inside code fence - apply syntax highlighting
      const html = yield* call(() => 
        highlightCode(ctx.chunk, ctx.meta?.language || 'text')
      )
      yield* emit({ 
        raw: ctx.chunk, 
        html,
        language: ctx.meta.language 
      })
    } else {
      // Outside code fence - parse as markdown
      const html = marked.parse(ctx.next, { async: false })
      yield* emit({ raw: ctx.next, html })
    }
  }
}
```

### Processor with AST

```typescript
import { fromMarkdown } from 'mdast-util-from-markdown'

function astProcessor(): Processor {
  return function* (ctx, emit) {
    const ast = fromMarkdown(ctx.next)
    const html = toHtml(ast)
    
    yield* emit({ 
      raw: ctx.next, 
      html,
      ast  // Include AST for advanced rendering
    })
  }
}
```

## Compatibility: Legacy Sync Processors

For simple use cases, wrap sync functions with `fromSync()`:

```typescript
import { fromSync } from './processors'
import type { SyncProcessor } from './types'

const legacyProcessor: SyncProcessor = (ctx) => ({
  raw: ctx.chunk,
  html: marked.parse(ctx.chunk)
})

dualBufferTransform({
  processor: fromSync(legacyProcessor)
})
```

## Output Fields

Processors can add any fields to the output. Common fields:

| Field | Type | Description |
|-------|------|-------------|
| `raw` | `string` | Original content (required) |
| `html` | `string` | Parsed HTML |
| `ast` | `unknown` | Parsed AST |
| `pass` | `'quick' \| 'full'` | Progressive enhancement pass |
| `meta` | `SettleMeta` | Copied from settler metadata |
| `language` | `string` | Code language (for syntax highlighting) |

All fields are spread onto the `buffer_settled` patch:

```typescript
// Processor emits:
yield* emit({ raw: "code", html: "<pre>code</pre>", language: "python" })

// Patch received:
{
  type: 'buffer_settled',
  content: "code",
  prev: "...",
  next: "...",
  raw: "code",
  html: "<pre>code</pre>",
  language: "python"
}
```

## Testing Processors

```typescript
import { run } from 'effection'
import { markdown, syntaxHighlight } from './processors'

describe('markdown processor', () => {
  async function runProcessor(processor, ctx) {
    return run(function* () {
      const emissions = []
      
      function* emit(output) {
        emissions.push(output)
      }
      
      yield* processor(ctx, emit)
      return emissions
    })
  }

  it('should parse markdown to HTML', async () => {
    const processor = markdown()
    const ctx = {
      chunk: '# Hello',
      accumulated: '',
      next: '# Hello'
    }

    const results = await runProcessor(processor, ctx)

    expect(results).toHaveLength(1)
    expect(results[0].html).toContain('<h1>')
  })

  it('should emit quick and full passes', async () => {
    const processor = syntaxHighlight()
    const ctx = {
      chunk: 'def foo():',
      accumulated: '',
      next: 'def foo():',
      meta: { inCodeFence: true, language: 'python' }
    }

    const results = await runProcessor(processor, ctx)

    expect(results).toHaveLength(2)
    expect(results[0].pass).toBe('quick')
    expect(results[1].pass).toBe('full')
  })
})
```

## Performance Considerations

- **Quick pass matters**: Users see the quick pass immediately - make it fast
- **Batch async work**: If doing multiple async operations, consider batching
- **Cache when possible**: Syntax highlighters often benefit from caching
- **Incremental vs full**: Use `incrementalMarkdown()` if you don't need full context

## Shiki Integration

For production syntax highlighting, use the Shiki module:

```typescript
import { shiki } from './chat'

dualBufferTransform({
  settler: shiki.codeFence(),
  processor: shiki.syntaxHighlight({
    theme: 'github-dark',
    languages: ['typescript', 'python', 'rust']
  })
})
```

See `apps/dynobase/src/demo/effection/chat/shiki/` for implementation details.

## Related

- [chat-streaming.md](./chat-streaming.md) - Main system documentation
- [settlers.md](./settlers.md) - Controlling when content settles
- [testing.md](./testing.md) - Testing utilities
