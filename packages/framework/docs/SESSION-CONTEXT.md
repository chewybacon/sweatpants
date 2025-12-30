# Session Context

**Last Updated:** Dec 30, 2025

A quick reference for getting up to speed on the @tanstack/framework rendering system in a new session.

---

## What Is This?

The TanStack framework provides a streaming chat rendering system that processes content through an immutable frame-based pipeline.

**Key Insight:** Content flows through automatic parsing → progressive processors → React UI updates.

---

## Current State

### ✅ What's Complete

- **Parser System** - Automatically detects code fences, headers, lists, etc.
- **Frame-Based Pipeline** - Immutable snapshots prevent race conditions
- **Processor Composition** - Markdown, syntax highlighting (Shiki), diagrams (Mermaid), math (KaTeX)
- **Progressive Enhancement** - Quick renders (fast) → Full renders (accurate)
- **Test Coverage** - 288 tests covering critical paths
- **Documentation** - Architecture, API guides, migration guides

### ✅ Recently Completed (Dec 30, 2025)

- **Removed deprecated settler system** - Old buffering logic replaced by parser
- **Cleaned up 65 tests** - Deleted tests that only covered deprecated code
- **Added 25 integration tests** - New preset validation tests
- **Consolidated docs** - Moved framework docs to `/packages/framework/docs/`
- **Updated package names** - All references now @tanstack/framework
- **Type consolidation** - Unified type system organized by domain:
  - `lib/chat/core-types.ts` - Shared primitives (Capabilities, AuthorityMode, etc.)
  - `lib/chat/patches/` - All patch types organized by category
  - `lib/chat/state/` - Timeline and ChatState types
  - `lib/chat/session/` - Streaming and session configuration
  - Reduced `runtime/types.ts` from 1314 lines to ~120 lines (re-exports only)
  - Fixed duplicate type definitions across handler, react/chat, and lib/chat

### ❌ What's NOT Done

- **Tool types deep dive** - `IsomorphicTool` in handler uses `any` escape hatches
  - Need proper generics/base interface for type safety at handler boundary
  - See `CLEANUP.md` for details
- Reveal speed controllers (character-by-character reveal)
- Animation system (fade, slide effects)
- Virtual scrolling for long conversations
- Advanced performance optimizations

---

## System Architecture

```
User sends message
        ↓
   [Session]
        ↓
   [Parser] → Creates frame with blocks (text, code, etc.)
        ↓
   [Pipeline] → Runs processors in dependency order
        ↓
   [Processors]
   • Markdown (required)
   • Shiki (syntax highlighting)
   • Mermaid (diagrams)
   • Math (KaTeX)
        ↓
   [React UI] → Updates via state/hooks
```

---

## Starting Points by Role

### I Want to...

**...understand the architecture**
- Read: `framework-design.md`
- Then: `rendering-engine-design.md`

**...use the chat system**
- Read: `pipeline-guide.md`
- Try: `packages/framework/src/react/chat/__tests__/pipeline-preset-validation.test.ts`

**...add a new processor**
- Read: `pipeline-guide.md` (Processors section)
- Copy: `packages/framework/src/react/chat/pipeline/processors/markdown.ts`
- Look at: Tests in `__tests__/` for patterns

**...write tests**
- Read: `docs/testing.md`
- See: `pipeline-preset-validation.test.ts` for examples

**...migrate old code using settlers**
- Read: `migration-guide.md`
- Key change: Use parser + processors instead of settlers

**...debug a rendering issue**
- Check: `rendering-checklist.md` for what's been implemented
- Read: `pipeline/runner.ts` for execution logic
- Test: Use `pipeline-preset-validation.test.ts` as reproduction cases

---

## Key Concepts

### Frames
**Immutable snapshots of document state**
- Contains blocks (text, code)
- Each block has raw content + HTML rendering
- Never modified in-place - returns new frame

### Blocks
**Content units**
- `type`: 'text' | 'code'
- `raw`: Original source
- `html`: Rendered HTML
- `language`: Code language (for code blocks)
- `status`: pending | streaming | complete

### Processors
**Enhance frames**
- Input: Frame with blocks
- Output: Frame with HTML/enriched data
- Examples: markdown (parses to HTML), shiki (highlights code)

### Progressive Enhancement
**Two render passes per processor**
- `quick`: Fast regex-based rendering (~10-50ms)
- `full`: Complete async rendering (~100-500ms)

User sees quick version immediately, full version appears after.

---

## File Reference

### Core Pipeline

| File | Purpose |
|------|---------|
| `pipeline/runner.ts` | Main execution loop, runs processors in order |
| `pipeline/parser.ts` | Parses markdown into block structure |
| `pipeline/frame.ts` | Frame creation and manipulation utilities |
| `pipeline/types.ts` | Core type definitions |
| `pipeline/resolver.ts` | Dependency resolution for processors |
| `pipeline/processors/markdown.ts` | Built-in markdown processor |
| `pipeline/processors/shiki.ts` | Syntax highlighting processor |

### Chat Integration

| File | Purpose |
|------|---------|
| `useChat.ts` | React hook for chat functionality |
| `useChat Session.ts` | Session management hook |
| `session.ts` | Core session logic |
| `transforms.ts` | Channel buffering and chaining |
| `streamChatOnce.ts` | One-shot streaming function |

### Types

| File | Purpose |
|------|---------|
| `types/metadata.ts` | Content metadata (code fence info, etc.) |
| `types/state.ts` | Chat state types |
| `types/patch.ts` | Streaming patch types |
| `types/processor.ts` | Processor interface |

### Tests

| File | Tests | Purpose |
|------|-------|---------|
| `pipeline-preset-validation.test.ts` | 25 | All presets, edge cases |
| `full-pipeline-e2e.test.ts` | 16 | End-to-end pipeline |
| `mermaid-e2e.test.ts` | 6 | Diagram rendering |
| `math-processor.test.ts` | 13 | Math rendering |

---

## Common Tasks

### Running Tests
```bash
npm run test                    # All tests
npm run test -- FILE_PATTERN   # Specific test
npm run test -- --watch        # Watch mode
```

### Building
```bash
npm run build                   # Build distribution
npm run typecheck              # Type checking
```

### Debugging
```bash
# Check type errors
npm run typecheck

# Run specific test with output
npm run test -- code-fence-streaming

# Build with source maps
npm run build
```

---

## Quick Command Reference

```bash
# Setup
npm install
pnpm install  # If using pnpm

# Verify everything works
npm run typecheck && npm run test && npm run build

# During development
npm run test -- --watch

# Before committing
npm run typecheck
npm run test
npm run build
```

---

## Documentation Map

**Start here:** `framework-design.md` - Understanding the vision  
**Then read:** `pipeline-guide.md` - How to use the system  
**Reference:** `rendering-engine-design.md` - How it works internally  
**Cleanup info:** `CLEANUP.md` - What's been done, what's next  

**Specific topics:**
- Testing: `docs/testing.md`
- Migration: `migration-guide.md`
- Status: `rendering-checklist.md`

**Historical:** `docs/archive/` - Old documentation

---

## Session Checklist

When starting a new session, verify:

- [ ] Run `npm run typecheck` - No TS errors
- [ ] Run `npm run test` - All tests pass (288 pass | 1 skipped)
- [ ] Run `npm run build` - Build succeeds
- [ ] Read this file - Refresh context
- [ ] Check CLEANUP.md - See what was done and what's pending
- [ ] Pick your task from CLEANUP.md or plan file

---

## Dependencies & Key Technologies

| Tech | Purpose | Docs |
|------|---------|------|
| **Effection** | Structured concurrency with generators | effectionjs.com |
| **React 19** | UI rendering | react.dev |
| **Marked** | Markdown parsing | marked.js.org |
| **Shiki** | Code syntax highlighting | shiki.matsu.io |
| **Mermaid** | Diagram rendering | mermaid.js.org |
| **KaTeX** | Math rendering | katex.org |

---

## Asking for Help

When you're stuck or need help, provide:

1. **What you were trying to do** - Which file, which feature
2. **What happened** - Error message, unexpected behavior
3. **What you expected** - What should have happened
4. **Environment** - `npm run typecheck` output, test results
5. **Code snippet** - Minimal reproduction if possible

---

## Next Steps

See `CLEANUP.md` for:
- What's been completed
- What maintenance tasks are pending
- Future enhancement ideas
