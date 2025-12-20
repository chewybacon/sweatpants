# Processor Design Notes

> **Status**: Design considerations for future refactoring. Not actionable yet.

## Current Issues

### 1. Processors are stateful (some of them)

Basic processors like `markdown()`, `passthrough()` are stateless - they just transform `ctx.next` to HTML.

But `shikiProcessor()` and `quickHighlightProcessor()` maintain closure state:

```typescript
export function shikiProcessor(): Processor {
  let currentBlock: CodeBlockState | null = null  // code fence state
  let markdownBuffer = ''                          // text waiting to be parsed
  let outputHtml = ''                              // accumulated HTML output

  return function* (ctx, emit) {
    // Uses and mutates all three variables
  }
}
```

**Why they're stateful:**
1. **Code block accumulation** - Need to collect lines during a code fence to Shiki-highlight the complete block at fence close
2. **Output accumulation** - Each emit must contain the *complete* HTML so far (not just the chunk), so the reducer can do a simple replacement

**The dilemma:** Should processors own HTML accumulation, or should `dualBuffer` handle it?

Current responsibility split:
- **Settler** → yields raw text chunks to settle
- **dualBuffer** → tracks `settled` (accumulated raw text)
- **Processor** → tracks `outputHtml` (accumulated rendered HTML)

Alternative:
- **dualBuffer** → tracks both `settled` AND `settledHtml`
- **Processor** → just returns HTML for current chunk, dualBuffer appends

This would make processors stateless but requires dualBuffer to understand HTML accumulation.

### 2. Only one processor allowed

Currently `dualBufferTransform` takes a single processor:

```typescript
dualBufferTransform({
  settler: codeFence,
  processor: shikiProcessor,  // Only one!
})
```

This violates SRP - `shikiProcessor` does both:
- Markdown parsing (for text outside code blocks)
- Syntax highlighting (for code blocks)

What if you want:
- Markdown + Math rendering + Syntax highlighting?
- Different highlighting for different languages?
- Custom processing for specific content types?

### 3. No composition model

Processors can't be composed. You can't do:

```typescript
// This doesn't exist
dualBufferTransform({
  processor: compose(
    markdownProcessor,
    mathProcessor, 
    shikiProcessor,
  ),
})
```

## Design Questions to Explore

### Should processors be a pipeline?

```typescript
// Multiple processors, each handles what it knows
dualBufferTransform({
  processors: [
    mathProcessor,      // Handles $...$ and $$...$$
    shikiProcessor,     // Handles code fences
    markdownProcessor,  // Handles everything else
  ],
})
```

But how do they coordinate? Does each one pass output to the next? Or do they each get the raw input and somehow merge?

### Should processors declare what they handle?

```typescript
const shikiProcessor = defineProcessor({
  handles: (ctx) => ctx.meta?.inCodeFence === true,
  process: function* (ctx, emit) { ... }
})

const markdownProcessor = defineProcessor({
  handles: (ctx) => ctx.meta?.inCodeFence !== true,
  process: function* (ctx, emit) { ... }
})
```

Then dualBuffer routes chunks to the right processor based on metadata.

### Should state live in context instead of closures?

```typescript
// Processor receives mutable state object
type Processor = (
  ctx: ProcessorContext, 
  emit: ProcessorEmit,
  state: ProcessorState  // Managed by dualBuffer, reset on streaming_start
) => Operation<void>
```

This makes processors "stateless" in the sense that they don't own their state - dualBuffer manages it. But they can still access persistent state across chunks.

### Should we separate concerns more clearly?

Maybe the problem is that "processor" is doing too much:

```typescript
// Separate concerns
dualBufferTransform({
  settler: codeFence,
  
  // Renderers: transform raw text to HTML (per-chunk, stateless)
  renderers: {
    markdown: (chunk) => marked.parse(chunk),
    code: (chunk, lang) => highlightSync(chunk, lang),
  },
  
  // Enhancers: async upgrades after initial render
  enhancers: [
    shikiEnhancer,  // Replaces code blocks with Shiki output
  ],
})
```

## Next Steps

1. Identify all the use cases for processors
2. Design a composition model that handles them
3. Decide where state should live
4. Consider whether dualBuffer should own HTML accumulation

## Related Files

- `apps/dynobase/src/demo/effection/chat/processors.ts` - Basic processors
- `apps/dynobase/src/demo/effection/chat/shiki/processor.ts` - Stateful shiki processor
- `apps/dynobase/src/demo/effection/chat/dualBuffer.ts` - Where processors are called
- `apps/dynobase/src/demo/effection/chat/types.ts` - Processor type definitions
