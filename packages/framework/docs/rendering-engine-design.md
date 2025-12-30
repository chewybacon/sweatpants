# Rendering Engine Design (Implemented)

This document describes the **implemented** frame-based rendering pipeline architecture.

## Architecture Summary

The rendering engine has been completely redesigned around **immutable frames** and **processor pipelines**:

```
Raw Tokens → Parser (auto) → Frame₀ → [Processors in DAG order] → Frame₁ → Frame₂ → UI
                                    ↓
                              Progressive Enhancement
                              (none → quick → full)
```

## Implemented Features

### Frame-Based Architecture

- **Frames** are immutable snapshots of document state
- **Blocks** represent content units (text/code)
- **Parser** automatically detects code fences
- **No more settlers** - structure is parsed, not negotiated

### Processor System

- **Dependency-based ordering** via topological sort
- **Preload** async assets eagerly
- **isReady** check for loading states
- **Process** transforms frames

### Progressive Enhancement

- **none**: Raw content (instant)
- **quick**: Fast regex-based rendering (~10-50ms)
- **full**: Complete async rendering (~100-500ms+)

## Built-in Processors

| Processor | Dependencies | Purpose |
|-----------|--------------|---------|
| `markdown` | none | Parse markdown to HTML |
| `shiki` | markdown | Syntax highlighting |
| `mermaid` | markdown | Diagram rendering |
| `math` | markdown | LaTeX rendering |

## Usage

```tsx
import { useChat } from '@tanstack/framework/react/chat'
import { markdown, shiki, mermaid, math } from '@tanstack/framework/react/chat/pipeline'

useChat({
  processors: 'full',  // All processors
  // or: processors: [markdown, shiki, mermaid]
})
```

## Key Files

- `packages/framework/src/react/chat/pipeline/index.ts` - Public API
- `packages/framework/src/react/chat/pipeline/types.ts` - Core types
- `packages/framework/src/react/chat/pipeline/runner.ts` - Pipeline execution
- `packages/framework/src/react/chat/pipeline/frame.ts` - Frame utilities
- `packages/framework/src/react/chat/pipeline/resolver.ts` - Dependency resolution
- `packages/framework/src/react/chat/pipeline/parser.ts` - Block parsing

## Documentation

- [framework-design.md](./framework-design.md) - Full framework architecture
- [pipeline-guide.md](./pipeline-guide.md) - Detailed pipeline documentation
- [migration-guide.md](./migration-guide.md) - Migration from settlers

## Historical Context

This document previously contained design proposals for the rendering evolution. The core ideas were implemented:

- Processor composition system ✓
- Frame-based rendering ✓
- Progressive enhancement (quick → full) ✓
- Dependency resolution ✓
- Annotation system ✓

Remaining from original proposals:

- Reveal speed controllers (character/word/sentence) - Not implemented
- Animation system - Not implemented
- Multi-phase processing - Partial (parser + processors)
- User experience controls - Partial (render passes)

These remaining features may be added in future iterations based on use case needs.
