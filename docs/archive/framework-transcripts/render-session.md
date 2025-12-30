# Analyzing triple-buffer rendering pipeline concepts

**Session ID:** ses_49b1c53d1ffeOojDBTz7G3wl99
**Created:** 12/28/2025, 7:16:41 AM
**Updated:** 12/28/2025, 8:38:47 AM

---

## Assistant

```
Tool: read
```

---

## Assistant

Now let me update the RenderableBuffer interface and the emit logic to include delta and timestamp:

```
Tool: edit
```

---

## Assistant

Good, no errors. Now let me update the emit logic to include the delta information:

```
Tool: read
```

---

## Assistant

```
Tool: edit
```

---

## Assistant

```
Tool: edit
```

---

## Assistant

Good. Now let me also update the fallback case when processor emits nothing:

```
Tool: read
```

---

## Assistant

```
Tool: edit
```

---

## Assistant

Now let me also update the state reducer to handle the new delta fields. First let me find where the state is updated:

```
Tool: grep
```

---

## Assistant

```
Tool: read
```

---

## Assistant

```
Tool: edit
```

---

## Assistant

Now let me rebuild the package and verify everything compiles:

```
Tool: bash
```

---

## Assistant

Build succeeded. Let me mark task 2 as complete and move to task 3:

```
Tool: todowrite
```

---

## Assistant

Now let me fix the characterReveal and wordReveal processors to emit hints instead of blocking with sleep():

```
Tool: read
```

---

## Assistant

Now let me rewrite these to emit hints instead of blocking:

```
Tool: edit
```

---

## Assistant

Good - we can remove the unused sleep import since we're no longer blocking:

```
Tool: read
```

---

## Assistant

```
Tool: edit
```

---

## Assistant

Now let me also add a compatibility layer note and rebuild:

```
Tool: bash
```

---

## Assistant

I need to update the processor-orchestrator to use the new API:

```
Tool: read
```

---

## Assistant

```
Tool: edit
```

---

## Assistant

```
Tool: bash
```

---

## Assistant

Build succeeded. Let me mark task 3 as complete and move to task 4:

```
Tool: todowrite
```

---

## Assistant

Now let me create the high-level `useChat` hook that abstracts away buffer complexity. This will give users a simpler API with just messages:

```
Tool: write
```

---

## Assistant

I need to fix the type issues with optional properties:

```
Tool: edit
```

---

## Assistant

Now let me add the export to the index.ts:

```
Tool: read
```

---

## Assistant

```
Tool: edit
```

---

## Assistant

Now let me rebuild:

```
Tool: bash
```

---

## Assistant

Let me mark task 4 as complete and move to task 5 (RAF throttle):

```
Tool: todowrite
```

---

## Assistant

Now let me add the RAF-throttled processor wrapper. This will be useful for expensive operations like syntax highlighting:

```
Tool: read
```

---

## Assistant

```
Tool: read
```

---

## Assistant

```
Tool: read
```

---

## Assistant

Now let me add the RAF-throttled processor wrapper at the end of the file. Since this runs in Node.js for the Effection pipeline but the throttling needs to happen at the React level, I'll create a different approach - a throttle hint that React can use:

```
Tool: edit
```

---

## Assistant

```
Tool: edit
```

---

## Assistant

No more errors. Let me rebuild:

```
Tool: bash
```

---

## Assistant

Let me mark task 5 as complete and move to task 6 (update yo-chat):

```
Tool: todowrite
```

---

## Assistant

Now let me update yo-chat to use the new API. First let me look at what needs to change:

```
Tool: read
```

---

## Assistant

The current yo-chat already uses the new `settler` and `processor` names (we updated that earlier). But it's using `useChatSession` directly. Let me create a simpler example using `useChat` while keeping the advanced demo using `useChatSession`. I'll update the existing one to showcase the new API properly:

```
Tool: edit
```

---

## User

---

## Assistant

# Continuation Prompt: Triple Buffer Rendering Engine Refactor

## Context

We're refactoring the streaming rendering engine in `packages/framework/src/react/chat/` for a TanStack chat framework. The goal is to clean up the architecture for AI streaming content rendering, inspired by double/triple buffer patterns from game rendering.

## What We Completed

### 1. ✅ Vocabulary Cleanup (tripleBuffer.ts)
- Renamed `chunker` → `settler` and `enhancer` → `processor` throughout
- Added deprecated aliases for backward compatibility (`chunker`/`enhancer` still work)
- Updated all internal variable names and comments
- File: `/packages/framework/src/react/chat/tripleBuffer.ts`

### 2. ✅ RenderFrame with Delta Support (types.ts + tripleBuffer.ts)
Added new types for animation-ready rendering:
```typescript
// In types.ts
export interface RenderDelta {
  added: string        // New content since prev frame
  addedHtml?: string   // HTML for just the new content
  startOffset: number  // Where new content begins
}

export interface RevealHint {
  type: 'instant' | 'character' | 'word' | 'line'
  duration?: number
  isComplete?: boolean
}
```
- Updated `BufferRenderablePatch` to include `delta`, `revealHint`, `timestamp`
- Updated `ChatState.buffer.renderable` with same fields
- Updated `tripleBuffer.ts` emit logic to populate delta info
- Updated `state.ts` reducer to handle new fields

### 3. ✅ Non-blocking Reveal Processors (processors.ts)
- Removed blocking `sleep()` calls from `characterReveal` and `wordReveal`
- Changed them to emit `revealHint` metadata instead
- Added `lineReveal()` and `instantReveal()` processors
- New API uses options object: `characterReveal({ charDelayMs: 30 })`
- Updated `processor-orchestrator.ts` to use new API

### 4. ✅ High-level useChat Hook (useChat.ts - NEW FILE)
Created `/packages/framework/src/react/chat/useChat.ts`:
- Simple `Message[]` interface hiding buffer complexity
- Returns `{ messages, streamingMessage, isStreaming, send, abort, reset, error, session }`
- `messages` includes streaming message with `isStreaming: true`
- `streamingMessage` has full delta/revealHint for animation
- Added export to `index.ts`

### 5. ✅ Processor Utilities (processors.ts)
Added new processor wrappers:
- `debounceProcessor()` - Batches rapid emissions
- `batchProcessor()` - Collects chunks before processing
- `withThrottleHint()` - Adds throttle metadata for React-side handling

### 6. 🚧 yo-chat Update (IN PROGRESS)
Started updating `/apps/yo-chat/src/routes/demo/chat/index.tsx` to use new `useChat` hook, but hit errors:
- `useChat` not exported (need to rebuild framework)
- Type errors with `settler` property

## Current Errors

After last edit to yo-chat, we have:
```
ERROR [14:10] Module '"@tanstack/framework/react/chat"' has no exported member 'useChat'.
ERROR [33:9] Object literal may only specify known properties, and 'settler' does not exist in type 'TripleBufferOptions'.
```

## Files Modified

1. `/packages/framework/src/react/chat/tripleBuffer.ts` - Vocabulary + delta support
2. `/packages/framework/src/react/chat/types.ts` - New RenderDelta, RevealHint types
3. `/packages/framework/src/react/chat/processors.ts` - Reveal hints, debounce/batch utilities
4. `/packages/framework/src/react/chat/processor-orchestrator.ts` - Updated API calls
5. `/packages/framework/src/react/chat/state.ts` - Handle new renderable fields
6. `/packages/framework/src/react/chat/useChat.ts` - NEW FILE (high-level hook)
7. `/packages/framework/src/react/chat/index.ts` - Added useChat export
8. `/apps/yo-chat/src/routes/demo/chat/index.tsx` - Partially updated (has errors)

## What Needs to Be Done

### Immediate (to fix current errors):
1. Rebuild framework: `pnpm --filter @tanstack/framework build`
2. Fix yo-chat TypeScript errors after rebuild

### Remaining Tasks:
- **Task 6**: Finish yo-chat update to use new `useChat` hook
- **Task 7**: Update documentation (`docs/settlers.md`, `docs/rendering-engine-design.md`)

## Key Architecture

```
┌───────────────────┐      ┌───────────────────┐      ┌───────────────────┐
│   RAW BUFFER      │ ──►  │   SETTLED BUFFER  │ ──►  │   RENDER BUFFER   │
│   (tokens)        │      │   (parsed chunks) │      │   (frames)        │
│                   │      │                   │      │                   │
│ • accumulates     │      │ • settler decides │      │ • prev frame      │
│   incoming text   │      │   when to move    │      │ • next frame      │
│ • high frequency  │      │ • processor       │      │ • delta (new)     │
│                   │      │   enriches (html) │      │ • React consumes  │
└───────────────────┘      └───────────────────┘      └───────────────────┘
```

**Vocabulary:**
- `Settler`: Decides WHEN content moves from raw → settled (yields chunks + metadata)
- `Processor`: Enriches settled content (yields html/ast/metadata)
- `Buffer`: Accumulated state at each stage
- `Frame`: prev/next snapshot with delta for React

**Two-Level API:**
- `useChat`: Simple - `{ messages, isStreaming, send }`
- `useChatSession`: Advanced - full buffer/transform access

---

## User

---

## Assistant

Looking at the summary, we have errors to fix. Let me check the current state of the files and then rebuild the framework to fix the export issues.

```
Tool: bash
```

```
Tool: read
```

---

## Assistant

Build succeeded. Now let me check the yo-chat file to see what errors remain:

```
Tool: read
```

---

## Assistant

Now let me check the `tripleBufferTransform` options to see what properties are expected (the error said `settler` doesn't exist):

```
Tool: read
```

---

## Assistant

The `tripleBufferTransform` does support `settler` property (line 120). The type error about `'settler' does not exist` might be a stale type. Let me check if the types are properly exported and if there are any issues with the yo-chat app:

```
Tool: bash
```

---

## Assistant

No type errors now. Let me verify the app can start and check if the useChat hook file exists and is correctly structured:

```
Tool: read
```

---

## Assistant

Everything looks good. Let me verify the app works by checking if there are any remaining issues:

```
Tool: bash
```

---

## Assistant

The yo-chat app builds successfully. Let me update the todo list and summarize what's complete:

```
Tool: todowrite
```

---

## Assistant

## Summary

All major tasks are now complete:

| Task | Status |
|------|--------|
| 1. Vocabulary cleanup (`chunker` → `settler`, `enhancer` → `processor`) | ✅ |
| 2. RenderFrame with delta support | ✅ |
| 3. Non-blocking reveal processors | ✅ |
| 4. High-level `useChat` hook | ✅ |
| 5. Processor utilities (debounce/batch) | ✅ |
| 6. yo-chat demo updated | ✅ |
| 7. Documentation updates | ⏳ Pending |

The framework builds successfully and yo-chat compiles without errors. The previous type errors were due to stale build artifacts that are now resolved after rebuilding the framework.

**Remaining task**: Update documentation files (`docs/settlers.md`, `packages/framework/docs/rendering-engine-design.md`) to reflect the new vocabulary and architecture. Would you like me to proceed with the documentation updates?

---

## User

there might be either a race condition or a slight bug in the chat demo

it occurs for a single frame just after a code fence ends and syntax highlighting progressively enhances where we rendered a frame of potentially raw markdown then the enhanced highlighted html

---

## Assistant

That's a good catch. Let me look at the rendering logic to understand the race condition. The issue is likely in how we transition between the settled content and the processed HTML.

```
Tool: read
```

```
Tool: read
```

---

## Assistant

Now let me look at the state reducer to see how `buffer.renderable` gets updated:

```
Tool: grep
```

---

## Assistant

```
Tool: read
```

---

## Assistant

Now let me look at the tripleBuffer's `processChunk` more carefully - specifically the order of emissions and when we emit with/without HTML:

```
Tool: read
```

---

## Assistant

Now let me look at the shiki processor to understand the progressive enhancement flow - it does multiple passes:

```
Tool: read
```

---

## Assistant

```
Tool: glob
```

---

## Assistant

```
Tool: read
```

---

## Assistant

Now I see the issue. Let me trace through what happens at fence end:

1. **Line 257-268**: On `fenceEnd`, it emits the **quick** version first with `pass: 'quick'`
2. **Line 271**: Awaits `highlightCode()` (async)
3. **Line 275-278**: Emits the **full** Shiki version with `pass: 'full'`

The problem is:
- After the full Shiki emit at fence end (line 275-278), subsequent content (the next markdown chunk after the code block) might arrive and the processor emits but **without preserving the Shiki HTML properly**.

Look at line 224-235 - when we're **outside** a code fence after a block was just finished:
```typescript
if (!meta?.inCodeFence) {
  markdownBuffer += ctx.chunk
  const parsedMarkdown = marked.parse(markdownBuffer, { async: false }) as string
  const fullHtml = outputHtml + parsedMarkdown
  yield* emit({...})
}
```

The issue is `outputHtml` contains the Shiki-highlighted block, but `markdownBuffer` is only the new markdown after the fence. When `marked.parse(markdownBuffer)` runs on just the first few chars of post-fence content, it might produce incomplete HTML.

But wait, let me look more carefully at the **actual problem** you described: "a single frame just after a code fence ends... rendered a frame of potentially raw markdown then the enhanced highlighted html"

Let me check the mermaid processor too since that's what yo-chat uses:

```
Tool: read
```

---

## Assistant

Now I understand the issue better. The problem is in the **timing of state updates vs React renders**.

Looking at `tripleBuffer.ts` lines 248-306, when the processor emits, it:
1. Sends `buffer_settled` patch
2. Updates internal `renderable` state
3. Sends `buffer_renderable` patch

But here's the race condition: The processor emits **twice** at fence end (quick then full), and React might render between these two emissions, showing the stale state.

Let me trace through what happens at `fenceEnd` in mermaid processor:

1. **Line 191-195**: Emits `pass: 'quick'` with quick-highlighted HTML
2. **Line 199/208**: Async await for Shiki/Mermaid rendering
3. **Line 212-216**: Emits `pass: 'full'` with Shiki/Mermaid HTML

The issue: Between step 1 and step 3, React can render. But the problem you describe is "raw markdown" - which suggests the **content without HTML** is being shown.

Let me check how the `useChat` hook decides what to render:

```typescript
// Line 122-127 in yo-chat
{msg.html ? (
  <div dangerouslySetInnerHTML={{ __html: msg.html }} />
) : (
  msg.content  // <-- This shows raw markdown!
)}
```

So if `msg.html` is ever `undefined`, it falls back to raw `msg.content`.

Let me check the `buffer_renderable` state update more carefully:

```
Tool: read
```

---

## Assistant

I see! On `streaming_start`, the `renderable` is reset to `{ prev: '', next: '' }` - **no html field**.

Now let me trace through the issue more carefully. When the first markdown chunk comes in AFTER a code fence ends and Shiki finishes:

1. Code fence ends with `pass: 'full'` - `renderable.html` is set to Shiki HTML
2. Next markdown chunk arrives (outside code fence)
3. Processor emits with new HTML (outputHtml + parsed markdown)
4. `buffer_renderable` patch arrives with new html

The question is: **Is there a frame where `html` is lost?**

Looking at the `buffer_renderable` reducer (lines 296-311):

```typescript
case 'buffer_renderable':
  return {
    ...state,
    buffer: {
      ...state.buffer,
      renderable: {
        prev: patch.prev,
        next: patch.next,
        ...(patch.html && { html: patch.html }),  // Only set if patch has html!
        ...
      },
    },
  }
```

**AH! There's the bug!**

The renderable state is **completely replaced** each time, not merged. If a patch doesn't include `html`, the previous `html` is **lost**.

Looking at `tripleBuffer.ts` lines 319-350, when the processor **doesn't emit anything**, we send a basic `buffer_renderable` patch **without html**:

```typescript
// If processor emitted nothing, send basic patches
if (!emitted) {
  // ...
  yield* output.send({
    type: 'buffer_renderable',
    prev: renderable.prev,
    next: renderable.next,
    delta,
    timestamp: now,
    // NO HTML!
  })
}
```

But wait, looking at the mermaid processor - it always emits with html. So the issue is more subtle.

Let me check if there's a timing issue in how the patches flow through the transform chain. Let me look for another place where `buffer_renderable` might be sent without html:

```
Tool: grep
```

---

## Assistant

There are only two places where `buffer_renderable` is emitted in tripleBuffer.ts - line 294 (when processor emits) and line 344 (when processor doesn't emit). Let me check the type definition:

```
Tool: read
```

---

## Assistant

Now I think I understand the issue better. Let me re-read the state reducer:

```typescript
case 'buffer_renderable':
  return {
    ...state,
    buffer: {
      ...state.buffer,
      renderable: {   // <-- Completely replaces renderable!
        prev: patch.prev,
        next: patch.next,
        ...(patch.html && { html: patch.html }),
```

**The bug is that `renderable` is completely replaced, not merged.** If the new patch doesn't have `html`, the previous `html` is lost.

But wait, looking at the mermaid processor more carefully - every emit includes `html`. Let me think about this differently...

Actually, I think I see the issue now. Let me trace through what happens:

1. **During streaming**: Patches flow: `streaming_text` → tripleBuffer → `buffer_renderable` with html
2. **At fence end**:
   - Quick emit with html ✅
   - **Async Shiki/mermaid call**
   - Full emit with html ✅
3. **After fence, next chunk arrives**:
   - New `streaming_text` arrives
   - tripleBuffer processes it
   - If this is outside a code fence, processor is called
   - Processor emits with html (outputHtml + markdown)

But here's the issue I think: **The processor's `outputHtml` state is held inside the processor instance.** If there's any reset happening, or if the processor doesn't emit (falls to the `if (!emitted)` path), we lose html.

Let me check when processors might not emit. Looking at the mermaid processor on lines 149-160:

```typescript
if (!meta?.inCodeFence) {
  markdownBuffer += ctx.chunk
  const parsedMarkdown = marked.parse(markdownBuffer, { async: false }) as string
  const fullHtml = outputHtml + parsedMarkdown
  yield* emit({
    raw: ctx.next,
    html: fullHtml,  // <-- Always emits html!
    pass: 'quick',
  })
  return
}
```

This always emits with html. So the processor path is fine.

Let me re-read the issue: **"single frame just after a code fence ends"**.

I think the issue might be in how React batches renders. Between the quick emit and full emit at fence end, React might render showing the quick-highlighted version. That's expected. But you said "raw markdown" not "quick-highlighted".

Let me look at the useChat hook's fallback:

```
Tool: read
```

---

## Assistant

Ah, I see it now! Look at line 233:

```typescript
...(renderable.html && { html: renderable.html }),
```

If `renderable.html` is falsy (undefined or empty string), no `html` property is set on the streaming message. Then in the UI (line 122-127 of yo-chat):

```tsx
{msg.html ? (
  <div dangerouslySetInnerHTML={{ __html: msg.html }} />
) : (
  msg.content  // Raw markdown!
)}
```

So the question is: **When does `renderable.html` become undefined/falsy after having a value?**

Looking at state.ts line 296-311 again:

```typescript
case 'buffer_renderable':
  return {
    ...state,
    buffer: {
      ...state.buffer,
      renderable: {
        prev: patch.prev,
        next: patch.next,
        ...(patch.html && { html: patch.html }),  // If patch.html is undefined, html is NOT preserved!
```

**This is the bug!** When a `buffer_renderable` patch arrives without `html`, the entire `renderable` object is replaced, and the previous `html` value is lost.

Now let me find when this could happen:

1. **tripleBuffer.ts line 344**: When processor doesn't emit, we send `buffer_renderable` without html
2. But the mermaid/shiki processors always emit with html...

Wait, let me check if there's another transform in the chain that might send patches:

```
Tool: grep
```

---

## Assistant

```
Tool: grep
```

---

## Assistant

Let me look at both places in tripleBuffer where it's emitted:

```
Tool: read
```

---

## Assistant

Found it! **Line 343-349** - when the processor doesn't emit anything (`!emitted`), we send a `buffer_renderable` **without html**:

```typescript
yield* output.send({
  type: 'buffer_renderable',
  prev: renderable.prev,
  next: renderable.next,
  delta,
  timestamp: now,
  // NO html field!
})
```

Now the question is: when does a processor NOT emit? Let me check the mermaid processor:

Looking at `mermaidProcessor()`:
- Line 165-180: `fenceStart` - **does NOT emit** (returns early)
- All other cases emit

**There it is!** On `fenceStart`, the processor doesn't emit, so `tripleBuffer.ts` falls to the `if (!emitted)` branch and sends a `buffer_renderable` without html - **wiping out the previous html!**

But wait, at fence start there wasn't html before either... Let me think about this more.

Actually, let me trace through a specific scenario:

1. Stream: "Hello world\n\n```python\n"
2. Settler yields: "Hello world\n\n" (paragraph)
3. Processor emits with html (markdown parsed)
4. `buffer_renderable` sent with html ✅
5. Next: "```python\n"
6. Settler yields: "```python\n" with `fenceStart: true`
7. Processor sees `fenceStart`, returns without emitting
8. `tripleBuffer` falls to `!emitted` branch
9. Sends `buffer_renderable` WITHOUT html
10. **Previous html is wiped!** React renders with `content` only (raw markdown)

**That's the bug!**

Now let me fix it. The fix should preserve the previous `html` value in the reducer when a new patch doesn't include `html`:

```
Tool: read
```

---

## Assistant

The fix should preserve the previous `html` when the new patch doesn't have one. There are two ways to fix this:

**Option A: Fix in the reducer (state.ts)** - Preserve previous html if new patch doesn't have it
**Option B: Fix in tripleBuffer.ts** - Always include html in the patch (preserve from local state)

Option B is better because it keeps the source of truth in one place. Let me fix it in `tripleBuffer.ts`:

```
Tool: read
```

---

## Assistant

I see the issue now more clearly. Look at lines 265-280:

When the processor emits, the `newRenderable` is created fresh, and only copies `html` from `processed.html` (line 270-272). It doesn't preserve the **previous** `renderable.html` if `processed.html` is not set.

But more importantly, in the `!emitted` path (lines 319-350), we don't preserve html at all.

The fix: In both places, preserve the previous `renderable.html` when the new html is not provided.

```
Tool: edit
```

---

## Assistant

```
Tool: read
```

---

## Assistant

The edit was applied. Now let me fix the `!emitted` path to also preserve html:

```
Tool: read
```

---

## Assistant

Now I need to fix this section to preserve html:

```
Tool: edit
```

---

## Assistant

```
Tool: bash
```

---

## Assistant

The build succeeded. Let me verify the changes were applied correctly:

```
Tool: read
```

---

## Assistant

Both changes are in place. Let me also check the first edit was applied correctly:

```
Tool: read
```

---

## Assistant

Both changes are applied. Now let me run the tests to make sure nothing is broken:

```
Tool: bash
```

---

## Assistant

The tests are running. Let me wait for them to complete:

```
Tool: bash
```

---

## Assistant

There's one test failure, but it's unrelated to our change - it's a pre-existing issue with `dualBufferTransform` not being exported. Let me check:

```
Tool: read
```

---

## Assistant

The test is using `dualBufferTransform` which is different from `tripleBufferTransform`. This is a pre-existing test issue, not related to our changes. Let me check if `dualBufferTransform` exists:

```
Tool: grep
```

---

## Assistant

It exists but might not be exported from index. Let me check:

```
Tool: grep
```

---

## Assistant

It's not exported. That's a pre-existing issue with the test. Let me add the export:

```
Tool: read
```

---

## Assistant

```
Tool: edit
```

---

## Assistant

Now let me rebuild and re-run tests:

```
Tool: bash
```

---

## Assistant

```
Tool: bash
```

---

## Assistant

All tests pass. Now let me update the todo list and provide a summary:

```
Tool: todowrite
```

---

## Assistant

## Fixed: HTML Flash Bug at Code Fence Transitions

### Root Cause

The bug occurred because when a processor **doesn't emit** (e.g., at `fenceStart` when the mermaid/shiki processor just initializes state and returns), the `tripleBuffer.ts` fallback path sent a `buffer_renderable` patch **without the `html` field**.

Since the state reducer completely replaces `renderable` (not merges), the previous `html` was lost, causing React to render raw markdown for one frame.

### Fix

In `packages/framework/src/react/chat/tripleBuffer.ts`:

1. **Line 264-275**: When processor emits, preserve previous `renderable.html` in `newRenderable` if `processed.html` is not provided:
   ```typescript
   const newRenderable: RenderableBuffer = {
     prev: renderable.next,
     next: next,
     timestamp: now,
     // Preserve previous html if not replaced
     ...(renderable.html && { html: renderable.html }),
   }
   if (processed.html) {
     newRenderable.html = processed.html  // Override if processor provides new html
   }
   ```

2. **Lines 333-358**: When processor doesn't emit (`!emitted` path), preserve and include `html` from previous frame:
   ```typescript
   const prevHtml = renderable.html
   renderable = {
     prev: renderable.next,
     next: next,
     timestamp: now,
     ...(prevHtml && { html: prevHtml }),
   }
   // ... and include in patch:
   yield* output.send({
     type: 'buffer_renderable',
     // ...
     ...(renderable.html && { html: renderable.html }),
   })
   ```

### Also Fixed

- Added missing `dualBuffer` export to `index.ts` (pre-existing test issue)

All 455 tests pass.

---

## User

wow, ok this is super solid

been working at this for days

I want to commit to this direction

I want to change the setup API

transformers: []

feels too low to the metal, I'm forced to import the buffer to configure it

it seems more likely you just want to setup the settlers and processors

the way state currently works, I'm not sure its really viable to swap then entire tranformer without deep deep knowledge of the internals or overhauling the internals with something new

---

## Assistant

Good point. The current API is awkward - you're forced to understand buffer internals just to configure markdown rendering or syntax highlighting.

Let me think through what a better API could look like:

## Current (Low-Level)
```typescript
useChat({
  transforms: [
    tripleBufferTransform({
      settler: shiki.codeFence,
      processor: [mermaid.mermaidProcessor]
    })
  ]
})
```

## Proposed Options

### Option A: Flat Configuration
```typescript
useChat({
  settler: shiki.codeFence,        // or 'paragraph' | 'line' | 'codeFence'
  processors: [mermaid.mermaidProcessor],
})
```
The hook internally wraps these in `tripleBufferTransform`. Simple, but loses flexibility if someone ever needs custom transforms.

### Option B: Presets + Escape Hatch
```typescript
// Most users - just pick a preset
useChat({ preset: 'markdown' })        // paragraph settler + markdown processor
useChat({ preset: 'code-highlight' })  // codeFence settler + shiki processor
useChat({ preset: 'mermaid' })         // codeFence settler + mermaid processor

// Power users - customize within preset
useChat({
  preset: 'code-highlight',
  processors: [...additionalProcessors],  // Add to default
})

// Escape hatch - raw transforms (current API)
useChat({
  transforms: [customTransform()],
})
```

### Option C: Builder Pattern
```typescript
useChat()
  .withSettler(shiki.codeFence)
  .withProcessor(markdown)
  .withProcessor(mermaid.mermaidProcessor)
```

---

## Questions

1. **Do you see a realistic use case for custom transforms** (not just settlers/processors)? If not, we could hide `transforms` entirely or make it a very explicit escape hatch.

2. **Preset vs explicit settler/processor**: Presets are simpler for common cases, but "codeFence + markdown" might feel like a black box. Explicit settler/processor names are more discoverable.

3. **Should `useChatSession` keep the low-level `transforms` API** for advanced users, while `useChat` only exposes the simpler configuration?

What direction feels right to you?

---

## User

option b looks nice, preset with escape hatch

I like this new direction of useChat for "nice" api, useChatSession for advanced use cases

---

## Assistant

Agreed. Let me explore the current code to understand what we need to change, then propose a concrete plan.

```
Tool: read
```

```
Tool: read
```

---

## Assistant

Let me also check what settlers and processors we have available to understand the preset options:

```
Tool: read
```

```
Tool: read
```

---

## Assistant

```
Tool: read
```

```
Tool: read
```

```
Tool: read
```

---

## Assistant

Now I have a good understanding. Let me propose a plan:

---

## Plan: Preset-Based API for `useChat`

### Goals

1. **Simple defaults** - `useChat()` with no args should "just work" with sensible defaults
2. **Named presets** - Common configurations as single string options
3. **Customizable** - Allow extending presets with additional processors
4. **Escape hatch** - `transforms` still available for power users / `useChatSession`

---

### Proposed API

```typescript
// Simple - sensible default (markdown preset)
const { messages, send } = useChat()

// Named presets
useChat({ preset: 'markdown' })           // paragraph + markdown (default)
useChat({ preset: 'code' })               // codeFence + shiki (syntax highlighting)
useChat({ preset: 'diagrams' })           // codeFence + mermaid + shiki
useChat({ preset: 'plain' })              // paragraph + passthrough (no processing)

// Preset + additional processors
useChat({
  preset: 'code',
  processors: [myCustomProcessor],  // Added AFTER preset's processors
})

// Explicit settler/processor (no preset)
useChat({
  settler: shiki.codeFence,
  processors: [mermaid.mermaidProcessor, shiki.shikiProcessor],
})

// Escape hatch - raw transforms (discouraged, use useChatSession)
useChat({
  transforms: [customTransform()],
})
```

---

### Preset Definitions

| Preset | Settler | Processors | Use Case |
|--------|---------|------------|----------|
| `markdown` (default) | `paragraph` | `markdown` | Basic markdown rendering |
| `code` | `shiki.codeFence` | `shiki.shikiProcessor` | Code with syntax highlighting |
| `diagrams` | `shiki.codeFence` | `[mermaid.mermaidProcessor]` | Mermaid + syntax highlighting |
| `plain` | `paragraph` | `passthrough` | Raw text, no processing |

---

### Type Definitions

```typescript
export type ChatPreset = 'markdown' | 'code' | 'diagrams' | 'plain'

export interface UseChatOptions extends Omit<UseChatSessionOptions, 'transforms'> {
  /**
   * Rendering preset. Determines settler and base processors.
   * @default 'markdown'
   */
  preset?: ChatPreset

  /**
   * Additional processors to run after preset processors.
   * Only used when `preset` is set.
   */
  processors?: ProcessorFactory[]

  /**
   * Custom settler (overrides preset's settler).
   * If set without preset, uses passthrough processor by default.
   */
  settler?: SettlerFactory

  /**
   * Raw transforms array. Overrides preset/settler/processors.
   * For advanced use cases - prefer useChatSession for full control.
   * @deprecated Use preset + processors, or useChatSession for advanced cases
   */
  transforms?: UseChatSessionOptions['transforms']
}
```

---

### Resolution Logic

```typescript
function resolveTransforms(options: UseChatOptions): PatchTransform[] {
  // Explicit transforms override everything
  if (options.transforms) {
    return options.transforms
  }

  // Explicit settler/processors (no preset)
  if (options.settler || options.processors) {
    return [tripleBufferTransform({
      settler: options.settler ?? paragraph,
      processor: options.processors ?? [passthrough],
    })]
  }

  // Preset-based (default path)
  const preset = options.preset ?? 'markdown'
  const config = PRESETS[preset]

  const processors = options.processors
    ? [...config.processors, ...options.processors]
    : config.processors

  return [tripleBufferTransform({
    settler: config.settler,
    processor: processors,
  })]
}
```

---

### Files to Modify

1. **`useChat.ts`** - Add preset types, resolution logic, update `UseChatOptions`
2. **`index.ts`** - Export `ChatPreset` type

---

### Questions for You

1. **Preset naming**: Do `markdown`, `code`, `diagrams`, `plain` feel right? Alternatives:
   - `basic` vs `markdown`?
   - `highlight` vs `code`?
   - `rich` for diagrams?

2. **Default preset**: Is `markdown` a good default, or should it be `code` (with shiki)?

3. **Deprecation of `transforms`**: Should we deprecate it on `useChat` and push power users to `useChatSession`, or keep it as a silent escape hatch?

4. **Math rendering**: You have KaTeX in processors. Should there be a `math` preset or should math be included in `markdown` by default?

---

## User

my vision is that this will be a big extension point for the framework, theres probably only a handful of settlers, but processors has the potential to be very expansive

---

## Assistant

That makes sense. Settlers are structural (how content gets chunked) while processors are the creative space (what happens to each chunk).

Let me think through this as an extension point:

## Settlers (Finite Set)
These are fundamentally about parsing structure:
- `paragraph` - on `\n\n`
- `line` - on `\n`
- `sentence` - on `.?!`
- `codeFence` - line-by-line in fences, paragraph outside
- `timeout(ms)` - time-based

Hard to imagine many more since they're about text boundaries.

## Processors (Expansive)
This is where extensibility lives:
- **Rendering**: markdown, math/KaTeX, mermaid diagrams
- **Syntax**: shiki, prism, other highlighters
- **Enhancement**: link previews, emoji parsing, mentions
- **Analysis**: sentiment, language detection
- **Interactive**: collapsible sections, copy buttons
- **Custom**: domain-specific rendering (API docs, data tables, charts)

---

## Revised Thinking

Given processors are the extension point, maybe the API should lean into that:

```typescript
// Default - markdown only
useChat()

// Add processors
useChat({
  processors: ['syntax', 'diagrams', 'math']  // Named processors
})

// Or factory refs for custom
useChat({
  processors: [shiki.shikiProcessor, myCustomProcessor]
})

// Settler override (rare)
useChat({
  settler: 'line',  // or shiki.codeFence
  processors: ['syntax']
})
```

### Questions

1. **Should processors be named strings or imports?**
   - Strings: `processors: ['syntax', 'diagrams']` - simpler, but magic
   - Imports: `processors: [shiki.shikiProcessor]` - explicit, tree-shakeable
   - Both?: Named strings for built-ins, imports for custom

2. **Settler as string or import?**
   - `settler: 'codeFence'` vs `settler: shiki.codeFence`
   - Leaning toward strings since there are few options

3. **Should we bundle common combos as presets anyway?** Even if processors are the extension point, presets like `'code'` or `'rich'` could be convenience shortcuts that expand to settler + processor combos.

4. **Processor ordering** - When user adds processors, should they go before or after built-ins? Or should we have `beforeProcessors` / `afterProcessors`?

What's your instinct on the string-vs-import question for processors?

---

## User

processors should probably be underpinned by effectionx/context-api so that each one can have middleware hooks for things like pre-loading assets and stuff

---

## Assistant

Interesting. So processors become a proper plugin system with lifecycle hooks, not just pure transforms.

Let me explore what that could look like:

## Processor as Plugin with Context

```typescript
// Processor plugin definition
interface ProcessorPlugin {
  name: string

  // Lifecycle hooks
  preload?: () => Operation<void>           // Load assets (shiki, mermaid, etc.)
  setup?: (ctx: PluginContext) => void      // Register middleware, config

  // The actual processor
  processor: ProcessorFactory

  // Dependencies
  requires?: string[]                        // Other processors this needs
  settler?: SettlerFactory                   // Preferred settler (codeFence for syntax)
}

// Usage
useChat({
  processors: [
    shikiPlugin,        // Has preload() for highlighter
    mermaidPlugin,      // Has preload() for mermaid lib
    mathPlugin,         // KaTeX preload
    myCustomPlugin,
  ]
})
```

## What Context Could Provide

```typescript
interface PluginContext {
  // Middleware hooks
  beforeSettle?: (content: string) => string
  afterProcess?: (html: string) => string

  // Shared state across processors
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T): void

  // Asset registration
  registerPreload(name: string, loader: () => Promise<void>): void

  // CSS injection
  injectStyles(css: string): void
}
```

## Questions to Think Through

1. **effection/context-api** - I should look at how this works. Is this already in the codebase or a pattern you want to adopt?

2. **Preloading strategy** - When do preloads run?
   - Eagerly on mount?
   - Lazily when first needed?
   - User-controlled via `preloadProcessors()`?

3. **Settler negotiation** - If multiple processors prefer different settlers (e.g., one wants `codeFence`, another wants `paragraph`), how do we resolve? First wins? Error? Merge?

4. **Processor ordering** - Does order matter? Should plugins declare `before: ['x']` / `after: ['y']`?

Let me look at how effection context works to ground this:

```
Tool: grep
```

---

## Assistant

Let me look at the existing `@effectionx/context-api` usage:

```
Tool: read
```

```
Tool: read
```

---

## Assistant

Now let me look at the rendering pipeline which also uses context-api:

```
Tool: read
```

---

## Assistant

Excellent! Now I understand the pattern better. The `@effectionx/context-api` provides an AOP-like middleware system with `around` hooks. You already have this foundation in place.

Let me think through what a processor plugin system could look like:

---

## Processor Plugin Architecture

### Current State
You have:
- `createApi` from `@effectionx/context-api` for middleware hooks
- `processor-api.ts` with basic `process` operation and `around` hooks
- `processor-orchestrator.ts` with pipeline creation helpers
- Individual processors as factory functions

### Vision: Processors as Plugins

```typescript
// A processor plugin is a factory that returns the processor,
// but can also hook into the pipeline lifecycle

interface ProcessorPlugin {
  // Identity
  name: string

  // Lifecycle hooks (all optional)
  preload?: () => Operation<void>              // Load async assets

  // Middleware hooks via context-api
  middleware?: () => Operation<void>           // Install around() hooks

  // The actual processor factory
  processor: ProcessorFactory

  // Configuration
  settler?: SettlerFactory                     // Preferred settler
  order?: { before?: string[], after?: string[] }
}

// Example: Shiki as a plugin
export const shikiPlugin: ProcessorPlugin = {
  name: 'shiki',

  *preload() {
    yield* preloadHighlighter(['typescript', 'python', 'javascript'])
  },

  *middleware() {
    // Install logging for shiki processing
    yield* processors.around({
      process: function* ([ctx, emit], next) {
        if (ctx.meta?.inCodeFence) {
          console.log(`[shiki] Highlighting ${ctx.meta.language}`)
        }
        yield* next(ctx, emit)
      }
    })
  },

  processor: shikiProcessor,
  settler: codeFence,  // Shiki prefers codeFence settler
}
```

### useChat with Plugins

```typescript
// Simple - just names (framework resolves to plugins)
useChat({
  processors: ['shiki', 'mermaid', 'math']
})

// Custom plugins
useChat({
  processors: [shikiPlugin, myCustomPlugin]
})

// Mixed
useChat({
  processors: ['shiki', myCustomPlugin, 'math']
})
```

### Resolution & Lifecycle

```typescript
// Inside useChat/session initialization
function* initializeProcessors(plugins: (string | ProcessorPlugin)[]) {
  // 1. Resolve string names to plugins
  const resolved = plugins.map(p =>
    typeof p === 'string' ? BUILTIN_PLUGINS[p] : p
  )

  // 2. Sort by order constraints
  const sorted = topologicalSort(resolved)

  // 3. Negotiate settler (error if conflict, or use most restrictive)
  const settler = negotiateSettler(sorted)

  // 4. Run preloads in parallel
  yield* all(sorted.filter(p => p.preload).map(p => p.preload!()))

  // 5. Install middleware hooks
  for (const plugin of sorted) {
    if (plugin.middleware) {
      yield* plugin.middleware()
    }
  }

  // 6. Create processor chain
  const chain = sorted.map(p => p.processor)

  return { settler, chain }
}
```

---

## Questions for You

1. **Plugin resolution** - Should we have a global registry for string → plugin resolution? Or require explicit imports always?
   ```typescript
   // Global registry approach
   registerProcessor('shiki', shikiPlugin)
   useChat({ processors: ['shiki'] })

   // vs explicit imports only
   useChat({ processors: [shikiPlugin] })
   ```

2. **Settler negotiation** - When multiple plugins want different settlers:
   - Error? ("shiki wants codeFence but math wants paragraph")
   - Most restrictive wins? (codeFence > paragraph since it's a superset)
   - User must specify explicitly?

3. **Preload timing** - When should preloads run?
   - On hook mount (eager)
   - On first stream (lazy)
   - Explicit `preloadProcessors()` call
   - Config option for each plugin?

4. **This feels like it could be a separate package** - Should this plugin system live in:
   - `@tanstack/framework/react/chat` (current location)
   - `@tanstack/chat-processors` (new package)
   - Part of `@effectionx/context-api` as a general pattern?

---

## User

I like the plugin idea, how can we rebuild all our processors and settlers so that they are more single responsibility, right now they are a tangled mess of inter dependencies

---

## Assistant

Good call. Let me audit the current state and understand the dependencies.

```
Tool: task
```

---

## Assistant

This is a great audit. Let me digest and propose a restructuring plan:

---

## Current Problems Summary

1. **Duplicate implementations**: `codeFence` and `line` exist in both `settlers.ts` and `shiki/settlers.ts`
2. **Tight coupling**: Mermaid imports from Shiki (can't use one without the other)
3. **`processors.ts` is a mega-file** (560 lines, 7+ concerns)
4. **`types.ts` is a mega-file** (1354 lines, 9+ domains)
5. **Deprecated API still in use**: `chunker`/`enhancer` in `processor-orchestrator.ts`
6. **dualBuffer/tripleBuffer share 80% code**

---

## Proposed Plugin-Based Architecture

### Directory Structure

```
packages/framework/src/react/chat/
├── types/
│   ├── index.ts              # Re-exports all
│   ├── settler.ts            # Settler types
│   ├── processor.ts          # Processor types
│   ├── patch.ts              # Patch types
│   ├── state.ts              # State types
│   └── session.ts            # Session/config types
│
├── core/
│   ├── buffer.ts             # Shared buffer logic (extracted from dual/triple)
│   ├── tripleBuffer.ts       # Extends buffer with renderable
│   ├── processor-chain.ts    # Chain composition
│   └── settler-utils.ts      # Settler combinators (any, all, timeout)
│
├── settlers/
│   ├── index.ts              # Re-exports all settlers
│   ├── paragraph.ts          # Single settler
│   ├── line.ts               # Single settler
│   ├── sentence.ts           # Single settler
│   ├── code-fence.ts         # The good one (from shiki/)
│   └── types.ts              # Settler-specific types (CodeFenceMeta)
│
├── plugins/
│   ├── types.ts              # ProcessorPlugin interface
│   ├── registry.ts           # Plugin registry & resolution
│   ├── loader.ts             # Plugin lifecycle (preload, middleware)
│   │
│   ├── markdown/
│   │   ├── index.ts          # Export plugin
│   │   ├── processor.ts      # markdown() processor
│   │   └── plugin.ts         # ProcessorPlugin definition
│   │
│   ├── shiki/
│   │   ├── index.ts          # Export plugin
│   │   ├── processor.ts      # shikiProcessor()
│   │   ├── quick-highlight.ts # Regex-based quick pass
│   │   ├── loader.ts         # Highlighter singleton
│   │   └── plugin.ts         # ProcessorPlugin definition
│   │
│   ├── mermaid/
│   │   ├── index.ts          # Export plugin
│   │   ├── processor.ts      # mermaidProcessor() - NO shiki import
│   │   ├── loader.ts         # Mermaid singleton
│   │   └── plugin.ts         # ProcessorPlugin definition
│   │
│   ├── math/
│   │   ├── index.ts          # Export plugin
│   │   ├── processor.ts      # KaTeX processor
│   │   └── plugin.ts         # ProcessorPlugin definition
│   │
│   └── reveal/
│       ├── index.ts          # Export plugin
│       ├── character.ts      # characterReveal
│       ├── word.ts           # wordReveal
│       └── plugin.ts         # ProcessorPlugin definition
│
├── hooks/
│   ├── useChat.ts            # High-level hook (preset API)
│   ├── useChatSession.ts     # Low-level hook (full control)
│   └── usePersonas.ts        # Persona fetching
│
└── index.ts                  # Public API exports
```

### Plugin Interface

```typescript
// plugins/types.ts
import type { Operation } from 'effection'

export interface ProcessorPlugin {
  /** Unique identifier */
  name: string

  /** Human-readable description */
  description?: string

  /**
   * Preferred settler for this processor.
   * Used for automatic settler selection when multiple plugins are combined.
   * More specific settlers (codeFence) take precedence over general (paragraph).
   */
  settler?: 'paragraph' | 'line' | 'sentence' | 'codeFence'

  /**
   * Preload assets (highlighters, renderers, etc.)
   * Called before first use or eagerly based on config.
   */
  preload?: () => Operation<void>

  /**
   * Check if preload is complete
   */
  isReady?: () => boolean

  /**
   * Install middleware hooks for cross-cutting concerns
   */
  middleware?: () => Operation<void>

  /**
   * The processor factory
   */
  processor: ProcessorFactory

  /**
   * Ordering constraints relative to other plugins
   */
  order?: {
    before?: string[]  // Run before these plugins
    after?: string[]   // Run after these plugins
  }

  /**
   * Dependencies on other plugins
   */
  requires?: string[]
}
```

### Settler Precedence

```typescript
// settlers have inherent precedence (more specific > less specific)
const SETTLER_PRECEDENCE = {
  'codeFence': 3,  // Most specific - line-by-line in fences, paragraph outside
  'line': 2,       // More specific than paragraph
  'sentence': 2,   // More specific than paragraph
  'paragraph': 1,  // Default
}

function negotiateSettler(plugins: ProcessorPlugin[]): SettlerFactory {
  const settlers = plugins
    .filter(p => p.settler)
    .map(p => ({ name: p.name, settler: p.settler! }))

  if (settlers.length === 0) return paragraph

  // Pick highest precedence
  const winner = settlers.reduce((best, curr) =>
    SETTLER_PRECEDENCE[curr.settler] > SETTLER_PRECEDENCE[best.settler]
      ? curr : best
  )

  return SETTLER_FACTORIES[winner.settler]
}
```

### Decoupling Mermaid from Shiki

The key insight: Mermaid needs:
1. `CodeFenceMeta` type - move to shared `settlers/types.ts`
2. `highlightCode` for non-mermaid blocks - make this **optional**

```typescript
// plugins/mermaid/plugin.ts
export const mermaidPlugin: ProcessorPlugin = {
  name: 'mermaid',
  settler: 'codeFence',

  // Mermaid doesn't require shiki, but can use it if available
  requires: [],  // NOT ['shiki']

  *preload() {
    yield* preloadMermaid()
  },

  processor: mermaidProcessor,
}

// plugins/mermaid/processor.ts
// For non-mermaid code blocks, just pass through raw
// If user wants syntax highlighting, they add shiki plugin separately
function* processNonMermaid(ctx: ProcessorContext, emit: ProcessorEmit) {
  // Just escape and wrap - no highlighting
  const escaped = escapeHtml(ctx.chunk)
  yield* emit({ raw: ctx.chunk, html: wrapCodeBlock(escaped, language) })
}
```

If user wants both mermaid AND syntax highlighting:
```typescript
useChat({
  processors: ['shiki', 'mermaid']  // Order matters: shiki handles code, mermaid handles mermaid
})
```

---

## Questions Before Proceeding

1. **Should we keep dualBuffer?** It seems like tripleBuffer is the successor. Should dualBuffer be deprecated or removed?

2. **Backward compatibility** - How important is it to keep the old API working during transition? Options:
   - Hard break (cleaner, faster)
   - Deprecation warnings (safer, more work)
   - Shim layer (old API calls new internally)

3. **Plugin string names** - Should built-in plugins be registered globally?
   ```typescript
   // Option A: Strings for built-ins
   useChat({ processors: ['shiki', 'mermaid'] })

   // Option B: Always import
   useChat({ processors: [shikiPlugin, mermaidPlugin] })

   // Option C: Both work
   useChat({ processors: ['shiki', mermaidPlugin] })
   ```

4. **Where to put `CodeFenceMeta`?**
   - `settlers/types.ts` (makes it a settler concern)
   - `types/settler.ts` (part of main types)
   - Keep in shiki but export from settlers index

5. **Preload strategy** - When should `preload()` run?
   - Eager on hook mount
   - Lazy on first stream
   - User calls `preloadProcessors()` explicitly
   - Per-plugin config

---


