# Archived Documentation

This directory contains outdated or superseded documentation that is kept for historical reference.

## Files in This Archive

### settlers.md
**Status:** Superseded by newer documentation  
**See instead:** `packages/framework/docs/migration-guide.md`  
**Reason:** The settlers API has been deprecated in favor of the pipeline system.

### processors.md
**Status:** Superseded by newer documentation  
**See instead:** `packages/framework/docs/pipeline-guide.md`  
**Reason:** Documentation has been moved to the framework package with updated examples.

### processor-design-notes.md
**Status:** Outdated design notes  
**Reason:** These are historical design discussion notes from the processor/settler architecture era. The current pipeline architecture is documented in the framework package.

### refactor-plan-effection-chat.md
**Status:** Historical planning document  
**Reason:** This is a planning document from a past refactoring effort. The current architecture is documented in `packages/framework/docs/rendering-engine-design.md`.

### chat-streaming.md
**Status:** Uses deprecated API  
**Reason:** References the old settler-based streaming API. See `packages/framework/docs/pipeline-guide.md` for current streaming documentation.

## Migration Guide

If you were using information from these archived docs:

1. **For Settlers/Processors:** See `packages/framework/docs/pipeline-guide.md` and `packages/framework/docs/migration-guide.md`
2. **For Architecture:** See `packages/framework/docs/rendering-engine-design.md` and `packages/framework/docs/framework-design.md`
3. **For Current Status:** See `packages/framework/docs/rendering-checklist.md`

## Why Archive Instead of Delete?

We keep these files for:
- Historical reference and understanding decision-making
- Learning how the architecture evolved
- Context for code archeology and git history
