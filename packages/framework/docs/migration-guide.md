# Migration Guide: Settlers to Pipeline

This guide covers migrating from the old dual-buffer/settler rendering system to the new frame-based pipeline architecture.

## Overview

| Aspect | Old Architecture | New Architecture |
|--------|-----------------|------------------|
| State | Mutable buffers | Immutable frames |
| Structure | Settler negotiation | Automatic parsing |
| Composition | Linear chains | DAG-based resolution |
| Enhancement | Separate emissions | Built-in render passes |
| Content bugs | Common at fences | Impossible |

## Key Changes

### 1. Parser Replaces Settlers

**Old:** Settlers decided when content could move from pending to settled.

```ts
// Old: Settler decided when to settle
const codeFenceSettler = defineSettler({
  name: 'code-fence',
  *settle(ctx) {
    if (ctx.pending.includes('```')) {
      // Wait for closing fence
    }
  }
})
```

**New:** Parser automatically detects code fences and creates block structure.

```ts
// New: Parser handles structure automatically
// Just provide processors, parser handles the rest
useChat({
  processors: [markdown, shiki]
})
```

### 2. Processors Have New Interface

**Old:** Processors received context and emitted updates.

```ts
// Old processor interface
defineProcessor({
  name: 'shiki',
  match: (ctx) => ctx.meta?.type === 'code',
  *process(ctx, emit) {
    const html = yield* highlight(ctx.chunk, ctx.meta.language)
    yield* emit({ raw: ctx.chunk, html, pass: 'full' })
  }
})
```

**New:** Processors receive frames and return updated frames.

```ts
// New processor interface
defineProcessor({
  name: 'shiki',
  dependencies: ['markdown'],
  *process(frame) {
    return updateFrame(frame, (block) => {
      if (block.type === 'code' && block.renderPass === 'quick') {
        const html = yield* highlight(block.raw, block.language)
        return setBlockHtml(block, html, 'full')
      }
      return block
    })
  }
})
```

### 3. Immutable Frames Replace Mutable Buffers

**Old:** Mutable pending/settled buffers.

```ts
// Old: Mutable state
const pending = ''
const settled = ''

function processChunk(chunk) {
  pending += chunk
  // Mutations everywhere...
  settled = applySettler(pending)
}
```

**New:** Immutable frame snapshots.

```ts
// New: Immutable state
let frame = emptyFrame()

function processChunk(chunk) {
  frame = runPipeline(pipeline, frame, chunk)
  // frame is always complete, no partial state
}
```

### 4. Dependency Resolution Replaces Manual Ordering

**Old:** Manual ordering in transforms array.

```ts
// Old: Manual ordering
dualBufferTransform({
  transforms: [
    { name: 'code', settler: 'code-fence', processor: 'shiki' },
    { name: 'mermaid', processor: 'mermaid' },
  ]
})
```

**New:** Automatic dependency resolution.

```ts
// New: Declare dependencies, pipeline resolves order
useChat({
  processors: [
    shiki,     // Will run after markdown (declared in shiki.dependencies)
    mermaid,   // Will run after markdown
    markdown,  // Runs first (no dependencies)
  ]
})
```

## Step-by-Step Migration

### Step 1: Remove Settler Definitions

**Before:**
```ts
// src/rendering/settlers/code-fence.ts
export const codeFenceSettler = defineSettler({
  name: 'code-fence',
  *settle(ctx) {
    // Logic to detect code fence boundaries
  }
})
```

**After:** Settlers are no longer needed. Remove these files or repurpose them as processors.

### Step 2: Update Processor Definitions

**Before:**
```ts
// src/rendering/processors/shiki.ts
export const shikiProcessor = defineProcessor({
  name: 'shiki',
  match: (ctx) => ctx.meta?.type === 'code',
  *process(ctx, emit) {
    const html = yield* highlight(ctx.chunk, ctx.meta.language)
    yield* emit({ raw: ctx.chunk, html, pass: 'full' })
  }
})
```

**After:**
```ts
// src/rendering/processors/shiki.ts
import { defineProcessor } from '@tanstack/framework/react/chat/pipeline'

export const shiki = defineProcessor({
  name: 'shiki',
  description: 'Syntax highlighting with Shiki',
  dependencies: ['markdown'],  // Declare dependency
  
  *preload() {
    yield* preloadHighlighter()
  },
  
  isReady: () => isHighlighterReady(),
  
  *process(frame) {
    return updateFrame(frame, (block) => {
      if (block.type === 'code' && !block.html) {
        // Quick pass: basic escaping
        const quickHtml = escapeHtml(block.raw)
        const quickBlock = setBlockHtml(block, quickHtml, 'quick')
        
        // Full pass: async highlighting
        const fullHtml = yield* highlight(block.raw, block.language || 'text')
        return setBlockHtml(quickBlock, fullHtml, 'full')
      }
      return block
    })
  },
})
```

### Step 3: Update Chat Configuration

**Before:**
```ts
import { dualBufferTransform } from '@tanstack/framework/rendering'

function Chat() {
  const session = useChatSession({
    transforms: [
      dualBufferTransform({
        settler: 'code-fence',
        processor: 'shiki',
      }),
      {
        name: 'mermaid',
        processor: 'mermaid',
      },
    ]
  })
}
```

**After:**
```tsx
import { useChat } from '@tanstack/framework/react/chat'
import { markdown, shiki, mermaid } from '@tanstack/framework/react/chat/pipeline'

function Chat() {
  const { messages, send } = useChat({
    processors: [markdown, shiki, mermaid]
  })
}
```

### Step 4: Update Message Rendering

**Before:**
```tsx
// Old: Render from pending/settled buffers
function ChatMessage({ session }) {
  const { pending, settled } = session.buffer
  
  return (
    <div>
      <div className="pending">{pending}</div>
      <div className="settled">{settled}</div>
    </div>
  )
}
```

**After:**
```tsx
// New: Render from frames
function ChatMessage({ messages }) {
  return (
    <div className="chat-message">
      {messages.map(msg => (
        <div key={msg.id} className="message">
          {msg.blocks.map(block => (
            <div
              key={block.id}
              className={`block render-${block.renderPass}`}
              dangerouslySetInnerHTML={{ __html: block.html }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
```

### Step 5: Handle Progressive Enhancement

**Before:** Processors emitted multiple times.

```ts
// Old: emit() called multiple times
*process(ctx, emit) {
  emit({ raw: ctx.chunk, html: basic, pass: 'quick' })
  emit({ raw: ctx.chunk, html: full, pass: 'full' })
}
```

**After:** Processors return frames with different render passes.

```ts
// New: Return frame with progressive enhancement
*process(frame) {
  return updateFrame(frame, (block) => {
    if (block.type === 'code') {
      const quickBlock = setBlockHtml(block, basicHtml, 'quick')
      const fullBlock = setBlockHtml(quickBlock, fullHtml, 'full')
      return fullBlock
    }
    return block
  })
}
```

## Common Migration Patterns

### Pattern 1: Custom Settler Logic

If you had custom settler logic:

**Old:**
```ts
const customSettler = defineSettler({
  name: 'custom',
  *settle(ctx) {
    if (ctx.pending.length > 100) {
      yield { content: ctx.pending.slice(0, 100), meta: ctx.meta }
    }
  }
})
```

**New:** Parser handles boundaries automatically. For custom chunking, create a processor:

```ts
const chunkingProcessor = defineProcessor({
  name: 'chunking',
  dependencies: [],
  *process(frame) {
    return updateFrame(frame, (block) => {
      if (block.status === 'streaming' && block.raw.length > 100) {
        // Split into chunks if needed
        return completeBlock(block)
      }
      return block
    })
  }
})
```

### Pattern 2: Custom Processor with Metadata

**Old:**
```ts
const customProcessor = defineProcessor({
  name: 'custom',
  match: (ctx) => true,
  *process(ctx, emit) {
    const result = processContent(ctx.chunk)
    emit({ 
      raw: ctx.chunk, 
      html: result.html,
      meta: result.metadata  // Custom metadata
    })
  }
})
```

**New:** Use annotations:

```ts
const customProcessor = defineProcessor({
  name: 'custom',
  dependencies: ['markdown'],
  *process(frame) {
    return updateFrame(frame, (block) => {
      const result = processContent(block.raw)
      const blockWithAnnotations = addAnnotations(block, [
        { type: 'custom', rawStart: 0, rawEnd: block.raw.length, data: result.metadata }
      ])
      return setBlockHtml(blockWithAnnotations, result.html, 'full')
    })
  }
})
```

### Pattern 3: Multiple Processors on Same Content

**Old:** Not supported - only one processor per settler/processor pair.

```ts
// Old: Couldn't easily chain processors
dualBufferTransform({
  settler: 'code-fence',
  processor: 'shiki',  // Only one processor
})
```

**New:** Multiple processors run in dependency order.

```ts
// New: Multiple processors, auto-ordered
useChat({
  processors: [
    markdown,        // Parse markdown first
    shiki,           // Then highlight code
    customHighlighter, // Then apply custom highlights
    myFormatter,     // Then format
  ]
})
```

### Pattern 4: Conditional Processing

**Old:** Used `match` function.

```ts
// Old: match determined if processor ran
const shikiProcessor = defineProcessor({
  name: 'shiki',
  match: (ctx) => ctx.meta?.type === 'code',
})
```

**New:** Processors check conditions themselves.

```ts
// New: Processor checks conditions
const shiki = defineProcessor({
  name: 'shiki',
  dependencies: ['markdown'],
  *process(frame) {
    return updateFrame(frame, (block) => {
      if (block.type === 'code') {
        // Process code blocks
        const html = yield* highlight(block.raw, block.language)
        return setBlockHtml(block, html, 'full')
      }
      // Skip text blocks
      return block
    })
  }
})
```

## API Mapping

### Old → New API

| Old API | New API |
|---------|---------|
| `defineSettler()` | Removed (parser handles structure) |
| `defineProcessor()` | `defineProcessor()` |
| `dualBufferTransform()` | `createPipeline()` |
| `ctx.pending` | `frame.blocks[i].raw` |
| `ctx.meta` | `block.type`, `block.language`, `block.annotations` |
| `emit({ html, pass })` | `setBlockHtml(block, html, pass)` |
| `yield { content, meta }` | `createTextBlock()`, `createCodeBlock()` |

### Import Changes

```ts
// Old imports
import { defineSettler, defineProcessor } from '@tanstack/framework/rendering'
import { dualBufferTransform } from '@tanstack/framework/rendering/transforms'

// New imports
import { defineProcessor } from '@tanstack/framework/react/chat/pipeline'
import { markdown, shiki, mermaid } from '@tanstack/framework/react/chat/pipeline'
import { useChat } from '@tanstack/framework/react/chat'
```

## Rollback Compatibility

For gradual migration, the old API is still available but deprecated:

```ts
import { dualBufferTransform } from '@tanstack/framework/legacy'

// Still works, but logs deprecation warning
const transform = dualBufferTransform({
  settler: 'code-fence',
  processor: 'shiki',
})
```

We recommend migrating to the new pipeline API for:
- Better performance (immutable frames)
- Cleaner code (no manual structure handling)
- Easier composition (dependency resolution)
- Progressive enhancement built-in

## Troubleshooting

### Issue: Content not rendering

**Check:** Is the markdown processor included?

```ts
// Make sure markdown is first
useChat({
  processors: [markdown, shiki, mermaid]
})
```

### Issue: Code highlighting not working

**Check:** Does your processor have correct dependencies?

```ts
const shiki = defineProcessor({
  name: 'shiki',
  dependencies: ['markdown'],  // Required!
  // ...
})
```

### Issue: Old code still running

**Check:** Did you remove old settler imports?

```ts
// Old - remove this
import { defineSettler } from '@tanstack/framework/rendering'

// New - use this
import { defineProcessor } from '@tanstack/framework/react/chat/pipeline'
```

### Issue: Cannot find block metadata

**Check:** Metadata is now in block properties.

```ts
// Old: ctx.meta
const language = ctx.meta?.language

// New: block.language
const language = block.language
```

## Checklist

- [ ] Remove settler definitions
- [ ] Update processor definitions to new interface
- [ ] Update chat configuration to use `processors` instead of `transforms`
- [ ] Update message rendering to use frames/blocks
- [ ] Add `dependencies` to processors
- [ ] Remove old `@tanstack/framework/rendering` imports
- [ ] Add new `@tanstack/framework/react/chat/pipeline` imports
- [ ] Test progressive enhancement (quick → full)
- [ ] Verify no content duplication at code fences
- [ ] Update any custom code using ctx.meta
