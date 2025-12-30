# Frame-Based Pipeline Guide

The frame-based pipeline is the new rendering architecture for sweatpants. This guide covers the core concepts, architecture, and how to work with the pipeline.

## Overview

The pipeline processes streaming AI content through a series of transforms:

```
Raw Tokens → Parser → Frame₀ → [Processors] → Frame₁ → Frame₂ → UI
                                    ↓
                              Progressive Enhancement
                              (none → quick → full)
```

- **Parser**: Internal - parses raw tokens into block structure (text/code)
- **Processors**: User-defined - enhance blocks with HTML (markdown, highlighting, diagrams)
- **Frames**: Immutable snapshots of the document state

## Core Concepts

### Frames

A **Frame** is an immutable snapshot of the document at a point in time:

```ts
interface Frame {
  id: string                      // Unique identifier for debugging
  blocks: Block[]                 // Ordered content blocks
  timestamp: number               // When this frame was created
  trace: TraceEntry[]             // Processing trace for debugging
  activeBlockIndex: number | null // Currently streaming block index
}
```

Frames are immutable - each update creates a new frame instance. This provides:

- **No content duplication bugs**: Each frame has complete state
- **Clean UI rendering**: Render the latest frame directly
- **Debugging**: Trace shows exactly what happened in each frame

### Blocks

A **Block** is the unit of content within a frame:

```ts
interface Block {
  id: string              // Stable identifier (persists across frames)
  type: 'text' | 'code'   // Block type discriminator
  raw: string             // Raw source content (markdown or code)
  html: string            // Rendered HTML (empty if not rendered)
  status: 'streaming' | 'complete'
  renderPass: 'none' | 'quick' | 'full'
  language?: string       // Language identifier for code blocks
  annotations?: Annotation[]
  meta?: Record<string, unknown>
}
```

**Block Types:**

| Type | Description | Example |
|------|-------------|---------|
| `text` | Regular prose content | "Hello, world!" |
| `code` | Fenced code blocks | ```typescript\nconst x = 1\n``` |

The parser automatically detects code fences and creates `code` blocks. Everything else becomes `text`.

### Render Passes

Each block has a `renderPass` indicating its current quality level:

| Render Pass | Purpose | Performance | Example |
|-------------|---------|-------------|---------|
| `none` | Raw content only | Instant | Plain text |
| `quick` | Fast regex-based rendering | ~10-50ms | Basic escaping, simple highlighting |
| `full` | Complete async rendering | ~100-500ms+ | Shiki highlighting, Mermaid SVG |

The pipeline can emit multiple frames for the same content at different pass levels, enabling progressive enhancement.

### Processors

A **Processor** is a self-contained processing unit that transforms frames:

```ts
interface Processor {
  name: string
  description?: string
  dependencies?: string[]
  preload?: () => Operation<void>
  isReady?: () => boolean
  process: (frame: Frame) => Operation<Frame>
}
```

**Processor Lifecycle:**

1. **preload()**: Eagerly load async assets (highlighters, renderers)
2. **isReady()**: Check if assets are loaded and ready
3. **process(frame)**: Transform the frame (can yield for async work)

**Example Processor:**

```ts
const markdownProcessor: Processor = {
  name: 'markdown',
  description: 'Convert markdown to HTML',
  dependencies: [],
  
  *preload() {
    // No async assets needed
  },
  
  isReady: () => true,
  
  *process(frame) {
    return updateFrame(frame, (block) => {
      if (block.type === 'text' && !block.html) {
        const html = marked.parse(block.raw)
        return setBlockHtml(block, html, 'quick')
      }
      return block
    })
  },
}
```

## Processor Composition

Processors declare dependencies, and the pipeline resolves them via topological sort:

```ts
const shikiProcessor: Processor = {
  name: 'shiki',
  description: 'Syntax highlighting with Shiki',
  dependencies: ['markdown'],  // Runs after markdown
  
  *preload() {
    yield* preloadHighlighter()
  },
  
  isReady: () => isHighlighterReady(),
  
  *process(frame) {
    // Transform code blocks...
    return frame
  },
}
```

**Dependency Resolution:**

```ts
// User provides processors in any order
const processors = [shiki, mermaid, markdown]

// Pipeline resolves to: [markdown, shiki, mermaid]
// Based on declared dependencies
```

## Using the Pipeline

### With useChat (Recommended)

```tsx
import { useChat } from '@sweatpants/framework/react/chat'
import { markdown, shiki, mermaid, math } from '@sweatpants/framework/react/chat/pipeline'

function Chat() {
  const { messages, send } = useChat({
    processors: 'full',  // = [markdown, shiki, mermaid, math]
  })

  return (
    <div>
      {messages.map(msg => (
        <div key={msg.id}>
          {msg.content}
        </div>
      ))}
    </div>
  )
}
```

### Architecture: How It Works

The pipeline integrates with the session's transform system:

```
streamChatOnce → [useTransformPipeline] → [createPipelineTransform] → patches → React
                     ↑                      ↑
               Buffered channel         Rendering logic
               (transforms.ts)          (pipeline/runner.ts)
```

**`useTransformPipeline`** (from `transforms.ts`):
- Provides buffering to prevent message loss (subscribe-before-send problem)
- Chains transforms together (not currently used - we only have one)

**`createPipelineTransform`** (from `pipeline/runner.ts`):
- Receives streaming text patches
- Parses into block structure
- Runs processors (markdown, shiki, mermaid, math)
- Emits `buffer_renderable` patches with HTML

You don't need to understand this detail for normal use - `useChat` handles it automatically.

### Custom Processor Array

```tsx
useChat({
  processors: [
    markdown,
    shiki,
    {
      name: 'custom',
      dependencies: ['markdown', 'shiki'],
      *process(frame) {
        // Custom processing...
        return frame
      }
    }
  ]
})
```

### Preloading Assets

For optimal performance, preload processor assets early:

```ts
import { preloadShiki, preloadMermaid, preloadMath } from '@sweatpants/framework/react/chat/pipeline'

// In your app initialization
function App() {
  useEffect(() => {
    // Preload in parallel
    Promise.all([
      preloadShiki(),
      preloadMermaid(),
      preloadMath(),
    ])
  }, [])
}
```

### Checking Readiness

```ts
import { isShikiReady, isMermaidReady, areProcessorsReady } from '@sweatpants/framework/react/chat/pipeline'

if (isShikiReady()) {
  // Shiki highlighting is available
}

if (areProcessorsReady(['markdown', 'shiki'])) {
  // All required processors are ready
}
```

## Frame Operations

### Creating Frames

```ts
import { emptyFrame, createTextBlock, createCodeBlock } from '@sweatpants/framework/react/chat/pipeline'

// Create empty frame
const frame = emptyFrame()

// Create a text block
const textBlock = createTextBlock('Hello, world!')

// Create a code block
const codeBlock = createCodeBlock('const x = 1', 'typescript')
```

### Updating Frames

```ts
import { updateFrame, addBlock, updateBlockAt } from '@sweatpants/framework/react/chat/pipeline'

// Update all blocks matching a predicate
const updated = updateFrame(frame, (block) => {
  if (block.type === 'code') {
    return setBlockHtml(block, highlighted, 'full')
  }
  return block
})

// Add a new block
const withBlock = addBlock(frame, createTextBlock('New content'))

// Update block at specific index
const modified = updateBlockAt(frame, 0, (block) => {
  return appendToBlock(block, ' more text')
})
```

### Querying Frames

```ts
import { hasBlocks, getLastBlock, findBlockById, getCodeBlocks, getTextBlocks } from '@sweatpants/framework/react/chat/pipeline'

// Check if frame has blocks
if (hasBlocks(frame)) {
  // Get the last block
  const last = getLastBlock(frame)
}

// Find block by ID
const block = findBlockById(frame, 'block-123')

// Get all code blocks
const codeBlocks = getCodeBlocks(frame)

// Get all text blocks
const textBlocks = getTextBlocks(frame)
```

## Built-in Processors

### markdown

Parses markdown to HTML. Runs first (no dependencies).

```ts
import { markdown } from '@sweatpants/framework/react/chat/pipeline'

useChat({
  processors: [markdown]
})
```

### shiki

Syntax highlighting for code blocks using Shiki.

```ts
import { shiki, preloadShiki, isShikiReady } from '@sweatpants/framework/react/chat/pipeline'

useChat({
  processors: [markdown, shiki]
})
```

**Requirements:**
- Requires `markdown` processor to run first (for code fence detection)
- Preload highlighter asynchronously

### mermaid

Renders Mermaid diagrams from text definitions.

```ts
import { mermaid, preloadMermaid, isMermaidReady } from '@sweatpants/framework/react/chat/pipeline'

useChat({
  processors: [markdown, mermaid]
})
```

**Requirements:**
- Requires `markdown` processor to run first
- Preload Meteer asynchronously

### math

Renders LaTeX math expressions using KaTeX.

```ts
import { math, preloadMath, isMathReady } from '@sweatpants/framework/react/chat/pipeline'

useChat({
  processors: [markdown, math]
})
```

**Requirements:**
- Requires `markdown` processor to run first
- Preload KaTeX CSS and fonts

## Processor Presets

Common processor combinations are available as presets:

```ts
type ProcessorPreset = 
  | 'markdown'      // Just markdown parsing
  | 'shiki'         // Markdown + syntax highlighting
  | 'mermaid'       // Markdown + diagrams
  | 'math'          // Markdown + math
  | 'full'          // All processors: markdown + shiki + mermaid + math
```

```tsx
useChat({
  processors: 'full'  // Enable all processors
})
```

## Annotations

Processors can extract metadata without affecting visual rendering:

```ts
interface Annotation {
  type: string           // 'math', 'directive', 'link', etc.
  subtype?: string       // 'inline', 'block', 'pause', etc.
  rawStart: number       // Start position in block.raw
  rawEnd: number         // End position in block.raw
  renderedStart?: number // Start position in block.html
  renderedEnd?: number   // End position in block.html
  data?: Record<string, unknown>
}
```

**Example: Extracting Math**

```ts
const mathProcessor: Processor = {
  name: 'math',
  dependencies: ['markdown'],
  
  *process(frame) {
    return updateFrame(frame, (block) => {
      if (block.type === 'text') {
        // Find math expressions
        const matches = findMathExpressions(block.raw)
        
        const annotations = matches.map(match => ({
          type: 'math' as const,
          subtype: match.delimiter === '$$' ? 'block' : 'inline',
          rawStart: match.start,
          rawEnd: match.end,
          data: { latex: match.expression }
        }))
        
        return addAnnotations(block, annotations)
      }
      return block
    })
  },
}
```

**Consuming Annotations:**

```ts
// TTS system can read annotations
function speakWithDirectives(frame: Frame) {
  for (const block of frame.blocks) {
    for (const annotation of block.annotations ?? []) {
      if (annotation.type === 'directive' && annotation.subtype === 'pause') {
        yield* sleep(annotation.data.duration)
      }
    }
  }
}
```

## Debugging

### Enable Debug Tracing

```ts
useChat({
  processors: [markdown, shiki],
  debug: true  // Enables trace logging
})
```

### Accessing Traces

```ts
const { messages } = useChat({
  processors: 'full',
  debug: true
})

// Each message contains trace information
for (const msg of messages) {
  console.log(`Message ${msg.id} processing trace:`)
  for (const entry of msg.trace) {
    console.log(`  ${entry.processor}: ${entry.action} - ${entry.detail}`)
  }
}
```

### Trace Entries

```ts
interface TraceEntry {
  processor: string     // Which processor produced this
  action: 'create' | 'update' | 'skip' | 'error'
  blockId?: string      // Which block was affected
  detail?: string       // Human-readable detail
  durationMs?: number   // How long the operation took
  timestamp: number     // When created
}
```

## Advanced Usage

### Custom Pipeline Runner

For more control, use the pipeline runner directly:

```ts
import { createPipeline, runPipeline } from '@sweatpants/framework/react/chat/pipeline'

const pipeline = createPipeline({
  processors: [markdown, shiki, mermaid],
  debug: true
})

// Process a chunk
const result = yield* runPipeline(pipeline, frame, chunk)

// result.frame - final frame after all processors
// result.intermediateFrames - frames from each processor
```

### Frame Emitter

Process frames as they stream:

```ts
import { createPipelineTransform } from '@sweatpants/framework/react/chat/pipeline'

const transform = createPipelineTransform({
  processors: [markdown, shiki],
  debug: true
})

// Stream processing
for await (const frame of transform.stream(chunks)) {
  setFrame(frame)  // Update UI
}
```

### Manual Processor Creation

```ts
import { defineProcessor } from '@sweatpants/framework/react/chat/pipeline'

const myProcessor = defineProcessor({
  name: 'my-processor',
  description: 'My custom processor',
  dependencies: ['markdown'],  // Run after markdown
  
  *preload() {
    // Load any async assets
  },
  
  isReady: () => {
    // Check if ready
    return true
  },
  
  *process(frame) {
    // Transform the frame
    return frame
  },
})
```

## Error Handling

### Processor Resolution Errors

```ts
import { 
  ProcessorResolutionError,
  CircularDependencyError,
  MissingDependencyError,
  DuplicateProcessorError 
} from '@sweatpants/framework/react/chat/pipeline'

try {
  resolveProcessors([markdown, shiki, myCustom])
} catch (e) {
  if (e instanceof CircularDependencyError) {
    // Processors have circular dependencies
  } else if (e instanceof MissingDependencyError) {
    // Required processor not found
  } else if (e instanceof DuplicateProcessorError) {
    // Same processor registered multiple times
  }
}
```

## Performance Considerations

### Preload Early

Preload processor assets at app start, not on first use:

```ts
// App.tsx
function App() {
  useEffect(() => {
    preloadShiki()
    preloadMermaid()
    preloadMath()
  }, [])
  
  return <Chat />
}
```

### Use Quick Pass for Initial Render

Processors should emit `quick` pass first for instant feedback:

```ts
*process(frame) {
  return updateFrame(frame, (block) => {
    if (block.type === 'code' && !block.html) {
      // Quick pass: basic escaping
      const quickHtml = escapeHtml(block.raw)
      const quickBlock = setBlockHtml(block, quickHtml, 'quick')
      
      // Full pass: async highlighting (can yield)
      const fullHtml = yield* highlightWithShiki(block.raw, block.language)
      return setBlockHtml(quickBlock, fullHtml, 'full')
    }
    return block
  })
}
```

### Batch Updates

The parser batches incoming tokens. For custom processors, process entire frames rather than individual tokens:

```ts
// Good: Process entire frame
*process(frame) {
  return updateFrame(frame, (block) => {
    // Process whole block at once
  })
}

// Avoid: Processing individual characters
```

## Migration from Settlers

If you're migrating from the old dual-buffer/settler system:

| Old Concept | New Concept |
|-------------|-------------|
| Settler | Parser (automatic) |
| Processor | Processor (updated interface) |
| dualBufferTransform | createPipeline |
| Buffer (mutable) | Frame (immutable) |
| settle() callback | Parser handles structure |
| emit() in processor | Return frame with renderPass |

See [migration-guide.md](./migration-guide.md) for detailed migration instructions.

## API Reference

### Types

```ts
// Core types
type BlockType = 'text' | 'code'
type BlockStatus = 'streaming' | 'complete'
type RenderPass = 'none' | 'quick' | 'full'
type ProcessFn = (frame: Frame) => Operation<Frame>
type ProcessorPreset = 'markdown' | 'shiki' | 'mermaid' | 'math' | 'full'

// Interfaces
interface Frame { id, blocks, timestamp, trace, activeBlockIndex }
interface Block { id, type, raw, html, status, renderPass, language, annotations, meta }
interface Processor { name, description?, dependencies?, preload?, isReady?, process }
interface Annotation { type, subtype?, rawStart, rawEnd, renderedStart?, renderedEnd?, data? }
```

### Exports

```ts
// Frame utilities
export {
  emptyFrame,
  updateFrame,
  createBlock,
  createTextBlock,
  createCodeBlock,
  updateBlock,
  appendToBlock,
  completeBlock,
  setBlockHtml,
  addBlock,
  updateBlockAt,
  getActiveBlock,
  getLastBlock,
  hasBlocks,
  findBlockById,
  getCodeBlocks,
  getTextBlocks,
}

// Processors
export { markdown, shiki, mermaid, math }
export { preloadShiki, isShikiReady, preloadMermaid, isMermaidReady, preloadMath, isMathReady }

// Resolution
export { resolveProcessors, preloadProcessors, areProcessorsReady, loadProcessors }
export { ProcessorResolutionError, CircularDependencyError, MissingDependencyError, DuplicateProcessorError }

// Pipeline
export { createPipeline, runPipeline, createPipelineTransform }
```
