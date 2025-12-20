# Settlers

Settlers are the core abstraction for controlling **when** and **what** content moves from the pending buffer to the settled buffer in the dual buffer transform.

## Concept

A settler is a generator function that receives context about the current buffer state and yields content to settle. This elegantly combines "when to settle" and "what to settle" into a single concept.

```typescript
type Settler = (ctx: SettleContext) => Iterable<string>

interface SettleContext {
  pending: string      // Content waiting to be settled
  settled: string      // Already settled content
  elapsed: number      // Milliseconds since pending started accumulating
  patch: ChatPatch     // The patch that triggered this settle check
}
```

### Rules

1. Yielded content **must be a prefix** of `pending`
2. Yield multiple times to settle in chunks
3. Yield nothing to leave everything in pending
4. The sum of yielded content is removed from pending

## Built-in Settlers

### `paragraph()`

Settles on paragraph breaks (`\n\n`). This is the **default settler** and works well for most markdown content.

```typescript
import { paragraph } from './settlers'

dualBufferTransform({ settler: paragraph() })
```

**Behavior:**
- Yields content up to and including each `\n\n`
- Can yield multiple times if there are multiple paragraph breaks
- Pending content without `\n\n` stays in the buffer

**Example:**
```
Input: "First para.\n\nSecond para.\n\nThird"
Yields: ["First para.\n\n", "Second para.\n\n"]
Remains pending: "Third"
```

### `sentence()`

Settles on sentence boundaries (`.`, `?`, `!` followed by space or newline).

```typescript
import { sentence } from './settlers'

dualBufferTransform({ settler: sentence() })
```

**Behavior:**
- Yields content up to and including sentence-ending punctuation + whitespace
- Good for more granular updates than paragraph

**Example:**
```
Input: "Hello world. How are you? I'm fine."
Yields: ["Hello world. ", "How are you? ", "I'm fine."]
```

### `line()`

Settles on each newline character. More aggressive than `paragraph()`.

```typescript
import { line } from './settlers'

dualBufferTransform({ settler: line() })
```

**Behavior:**
- Yields content up to and including each `\n`
- Best for code or line-oriented content

**Example:**
```
Input: "Line 1\nLine 2\nLine 3"
Yields: ["Line 1\n", "Line 2\n"]
Remains pending: "Line 3"
```

### `timeout(ms)`

Settles all pending content after a time threshold.

```typescript
import { timeout } from './settlers'

dualBufferTransform({ settler: timeout(150) })
```

**Behavior:**
- If `elapsed >= ms`, yields all pending content
- Otherwise yields nothing
- The elapsed timer resets when pending becomes empty

**Use case:** Force settling after a delay, useful as a fallback.

### `maxSize(chars)`

Settles when the pending buffer exceeds a size limit.

```typescript
import { maxSize } from './settlers'

dualBufferTransform({ settler: maxSize(500) })
```

**Behavior:**
- If `pending.length >= chars`, yields all pending content
- Prevents the pending buffer from growing unbounded

### `codeFence()`

Smart settler that understands markdown code fences. Returns a **MetadataSettler** that provides context to processors.

```typescript
import { codeFence } from './settlers'

dualBufferTransform({ 
  settler: codeFence(),
  processor: syntaxHighlight()  // Receives fence metadata
})
```

**Behavior:**
- Outside code fences: settles on paragraph breaks (like `paragraph()`)
- Inside code fences: settles on each line break (like `line()`)
- Provides metadata: `{ inCodeFence: boolean, language: string }`

**Example:**
```
Input: "Text\n\n```python\ndef foo():\n    return 42\n```\n\nMore text"

Yields:
  { content: "Text\n\n" }
  { content: "```python\n", meta: { inCodeFence: true, language: "python" } }
  { content: "def foo():\n", meta: { inCodeFence: true, language: "python" } }
  { content: "    return 42\n", meta: { inCodeFence: true, language: "python" } }
  { content: "```\n", meta: { inCodeFence: false, language: "python" } }
```

## Combinators

### `any(...settlers)`

OR combinator - uses the first settler that yields content.

```typescript
import { any, paragraph, timeout } from './settlers'

// Settle on paragraph OR after 200ms
dualBufferTransform({
  settler: any(paragraph(), timeout(200))
})
```

**Behavior:**
- Tries each settler in order
- Returns results from the first one that yields
- If none yield, nothing settles

### `all(...settlers)`

AND combinator - all must agree, uses the smallest result.

```typescript
import { all, paragraph, timeout } from './settlers'

// Only settle paragraphs after 100ms has passed
dualBufferTransform({
  settler: all(timeout(100), paragraph())
})
```

**Behavior:**
- All settlers must yield something
- Returns the shortest yielded content
- If any settler yields nothing, nothing settles

**Use case:** "Settle on X, but only if Y condition is also met"

## Metadata Settlers

For advanced use cases, settlers can yield `SettleResult` objects with metadata:

```typescript
interface SettleResult {
  content: string
  meta?: SettleMeta
}

interface SettleMeta {
  inCodeFence?: boolean
  language?: string
  [key: string]: unknown
}

type MetadataSettler = (ctx: SettleContext) => Iterable<SettleResult>
```

Processors receive this metadata in their context:

```typescript
function myProcessor(): Processor {
  return function* (ctx, emit) {
    if (ctx.meta?.inCodeFence) {
      // Handle code differently
      yield* emit({ raw: ctx.chunk, html: highlight(ctx.chunk, ctx.meta.language) })
    } else {
      yield* emit({ raw: ctx.chunk, html: markdown(ctx.chunk) })
    }
  }
}
```

## Custom Settlers

### Simple Settler

```typescript
import type { Settler } from './types'

// Settle on each comma
function comma(): Settler {
  return function* ({ pending }) {
    let remaining = pending
    let idx: number

    while ((idx = remaining.indexOf(',')) !== -1) {
      yield remaining.slice(0, idx + 1)
      remaining = remaining.slice(idx + 1)
    }
  }
}
```

### Stateful Settler

Settlers can maintain state across calls by using closures:

```typescript
function countingSettler(everyN: number): Settler {
  let callCount = 0
  
  return function* ({ pending }) {
    callCount++
    if (callCount % everyN === 0) {
      yield pending
    }
  }
}
```

### Metadata Settler

```typescript
import type { MetadataSettler, SettleResult } from './types'

function bulletList(): MetadataSettler {
  let inList = false
  
  return function* ({ pending }): Iterable<SettleResult> {
    const lines = pending.split('\n')
    
    for (const line of lines) {
      if (line.startsWith('- ') || line.startsWith('* ')) {
        inList = true
        yield { 
          content: line + '\n', 
          meta: { inList: true, listType: 'bullet' } 
        }
      } else if (line.trim() === '') {
        inList = false
        yield { content: line + '\n' }
      }
    }
  }
}
```

## Common Patterns

### Paragraph with Timeout Fallback

```typescript
// Settle on paragraph breaks, or force after 200ms
any(paragraph(), timeout(200))
```

### Paragraph with Size Limit

```typescript
// Settle on paragraph, or force when buffer gets large
any(paragraph(), maxSize(1000))
```

### Delayed Paragraph Settling

```typescript
// Only settle paragraphs after initial 100ms buffer period
all(timeout(100), paragraph())
```

### Code-Aware with Fallback

```typescript
// Use code fence awareness, but also respect size limits
any(codeFence(), maxSize(2000))
```

## Testing Settlers

Settlers are synchronous and easy to test:

```typescript
import { describe, it, expect } from 'vitest'
import { paragraph, timeout, any, all } from './settlers'

describe('paragraph settler', () => {
  it('should yield on paragraph breaks', () => {
    const settler = paragraph()
    const ctx = {
      pending: 'First\n\nSecond\n\nThird',
      settled: '',
      elapsed: 0,
      patch: { type: 'streaming_text', content: '' }
    }
    
    const results = [...settler(ctx)]
    
    expect(results).toEqual(['First\n\n', 'Second\n\n'])
  })
  
  it('should yield nothing without paragraph break', () => {
    const settler = paragraph()
    const results = [...settler({ pending: 'No breaks here', settled: '', elapsed: 0, patch: {} })]
    
    expect(results).toEqual([])
  })
})
```

## Performance Considerations

- Settlers are called on every incoming patch, so keep them fast
- Avoid regex compilation inside the settler - compile once in the factory
- The `codeFence()` settler maintains state, which is efficient for streaming
- Combinators like `any()` short-circuit after the first match

## Related

- [chat-streaming.md](./chat-streaming.md) - Main system documentation
- [processors.md](./processors.md) - Processing settled content
- [testing.md](./testing.md) - Testing utilities
