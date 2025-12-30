# Design Notes (Archived)

This file contained exploratory design notes from the rendering engine development. Key concepts have been moved to proper documentation.

## Archived Content

### Triple Buffer Concepts

Original exploration of raw/settled/renderable streams - now implemented as frame-based pipeline with parser.

### React Hook Design

Exploration of `useChatSession` vs simplified API - now documented in pipeline-guide.md.

### Vocabulary Cleanup

Ideas for renaming (chunker → settler, enhancer → processor) - now finalized as:
- Parser (handles structure)
- Processor (enhances content)
- Frame (immutable snapshot)

## Current Documentation

- [pipeline-guide.md](./pipeline-guide.md) - Complete pipeline documentation
- [framework-design.md](./framework-design.md) - Rendering architecture
- [migration-guide.md](./migration-guide.md) - Migration from old system

## Transcripts

Development session transcripts are preserved in `transcripts/` for historical reference but are not part of the main documentation.
