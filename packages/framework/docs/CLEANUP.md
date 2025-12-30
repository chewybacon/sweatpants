# Framework Cleanup & Maintenance

This document tracks completed cleanup work and provides guidance for future maintenance.

---

## ✅ Completed Cleanup (Dec 30, 2025)

### Phase 1: Documentation Archival
- **Action:** Archived 5 outdated documentation files
- **Location:** `/docs/archive/`
- **Files:** settlers.md, processors.md, processor-design-notes.md, refactor-plan-effection-chat.md, chat-streaming.md
- **Status:** ✅ Complete

### Phase 2: Remove Deprecated Exports
- **Action:** Removed settler re-exports from public API
- **Removed From:**
  - `packages/framework/src/react/chat/index.ts` - Removed settler exports
  - `packages/framework/src/react/chat/types/index.ts` - Removed settler types
  - `packages/framework/src/react/chat/types/settler.ts` - Deleted entire file
- **Added:** `packages/framework/src/react/chat/types/metadata.ts` - Generic content metadata type
- **Updated:** patch.ts, useChat.ts, state.ts, processor.ts, types.ts with ContentMetadata
- **Status:** ✅ Complete

### Phase 3: Delete Test Files
- **Action:** Removed tests that only covered deprecated code
- **Deleted:**
  - `test-utils.ts` - Unused settler test helper
  - `settlers.test.ts` - 48 tests of deprecated API
  - `code-fence-streaming.test.ts` - 19 tests of deprecated API
- **Impact:** 328 → 263 tests (kept all pipeline-relevant tests)
- **Status:** ✅ Complete

### Phase 4: Delete Settler Implementation
- **Action:** Removed entire deprecated settler system
- **Deleted:**
  - `settlers/` directory (8 implementation files)
  - `settlers.ts` wrapper file
  - `types/settler.ts` type definitions
- **Status:** ✅ Complete

### Phase 5: Documentation Updates
- **Action:** Updated docs to reflect modern pipeline
- **Updated:**
  - `CLEANUP.md` - Completion summary (this file)
  - `docs/testing.md` - Modern pipeline examples
  - All framework docs - @dynobase/@sweatpants → @tanstack references
- **Status:** ✅ Complete

### Phase 6: New Integration Tests
- **Action:** Added critical-path integration tests
- **Added:** `pipeline-preset-validation.test.ts` (25 new tests)
- **Coverage:** All presets (markdown, shiki, mermaid, math, full)
- **Impact:** 263 → 288 tests
- **Status:** ✅ Complete

### Phase 7: Documentation Consolidation
- **Action:** Consolidated framework docs
- **Moved:** Root `/docs/framework-design.md` → `packages/framework/docs/`
- **Archived:** `packages/framework/docs/transcripts/` → `docs/archive/framework-transcripts/`
- **Updated:** All package name references to @tanstack/framework
- **Status:** ✅ Complete

### Phase 8: Type Consolidation
- **Action:** Unified type system with single source of truth in lib/chat
- **Created:**
  - `lib/chat/core-types.ts` - Shared primitives (Capabilities, AuthorityMode, TokenUsage, etc.)
  - `lib/chat/patches/` - Organized patch types by category (base, buffer, tool, handoff)
  - `lib/chat/state/` - Timeline and ChatState types
  - `lib/chat/session/` - Streaming and session configuration types
- **Deleted:**
  - `react/chat/types/metadata.ts` - Moved to core-types
  - `react/chat/types/processor.ts` - Deprecated settler-era types
  - `react/chat/types/patch.ts` - Now in lib/chat/patches
  - `react/chat/types/state.ts` - Now in lib/chat/state
  - `react/chat/types/session.ts` - Now in lib/chat/session
- **Refactored:**
  - `lib/chat/isomorphic-tools/runtime/types.ts` - From 1314 lines to ~120 lines (re-exports only)
  - `handler/types.ts` - Removed internal duplicates, now imports from lib/chat
  - `react/chat/types/index.ts` - Now re-exports from lib/chat
  - `personas/types.ts` - Now imports Capabilities from core-types
- **Benefits:**
  - Single source of truth for all shared types
  - Types organized by domain (patches, state, session)
  - ChatPatch union now grouped into sub-categories with type guards
  - No more duplicate type definitions
- **Status:** ✅ Complete

---

## Current Architecture

### Core Systems (All Active)

| Component | Purpose | Location | Status |
|-----------|---------|----------|--------|
| **Parser** | Automatic block structure detection | `pipeline/parser.ts` | ✅ Active |
| **Pipeline** | Frame-based rendering | `pipeline/runner.ts` | ✅ Active |
| **Processors** | Content enhancement (markdown, shiki, mermaid, math) | `pipeline/processors/` | ✅ Active |
| **Transforms** | Channel buffering & chaining | `transforms.ts` | ✅ Active |
| **Session** | Chat session orchestration | `session.ts` | ✅ Active |

### Removed Systems

| Component | Removal Date | Reason |
|-----------|--------------|--------|
| **Settlers** | Dec 30, 2025 | Replaced by automatic parser |
| **dualBufferTransform** | Dec 30, 2025 | Part of old settler system |
| **Old test suite** | Dec 30, 2025 | Only covered deprecated code |

---

## Test Coverage

**Total:** 288 tests (1 skipped)

### By Category
- **Rendering Pipeline:** 16 tests (full-pipeline-e2e.test.ts)
- **Preset Validation:** 25 tests (pipeline-preset-validation.test.ts)
- **Processor Tests:** 19 tests (math-processor.test.ts, mermaid-e2e.test.ts)
- **Session & State:** 9 tests (step-lifecycle.test.ts, state.test.ts)
- **Framework Tools:** 55+ tests (tool-discovery, di-integration, etc.)
- **Other:** 164 tests (isomorphic-tools, chat integration, etc.)

---

## Verification Status

✅ **TypeScript:** `npm run typecheck` - No errors  
✅ **Tests:** `npm run test` - 288 pass | 1 skipped  
✅ **Build:** `npm run build` - CJS + DTS success  

---

## Future Maintenance Tasks

### High Priority (Tool Types Deep Dive)

- [ ] Fix `IsomorphicTool` type in `handler/types.ts`
  - **Problem:** Uses `any` types as escape hatch to accept various tool shapes
  - **Why:** `FinalizedIsomorphicTool<...>` from builder pattern has specific generics that don't assign to `unknown`
  - **Impact:** Loses type safety at the handler boundary
  - **Solution Ideas:**
    1. Create a proper base interface that builder tools extend
    2. Use a mapped type or conditional type to erase generics properly
    3. Consider `AnyIsomorphicTool` pattern from `lib/chat/isomorphic-tools/types.ts`
  - **Files to examine:**
    - `handler/types.ts` - `IsomorphicTool`, `PersonaResolver`
    - `lib/chat/isomorphic-tools/types.ts` - `AnyIsomorphicTool`
    - `lib/chat/isomorphic-tools/builder.ts` - `FinalizedIsomorphicTool`

### Low Priority (Can Do Later)

- [ ] ~~Consolidate `types/` directory structure~~ ✅ Done in Phase 8
  - ~~Current: Types split between `types/` and `pipeline/types.ts`~~
  - ~~Possible: Move all chat types to `pipeline/types.ts`~~

- [ ] Simplify transform pipeline
  - Current: `useTransformPipeline` wraps `createPipelineTransform`
  - Proposed: Merge buffering logic into `createPipelineTransform`
  - Trade-off: Loses general-purpose transform chaining (not currently used)
  - Status: Works well as-is, refactor only if needed

- [ ] Add reveal speed controllers
  - Not yet implemented
  - Would allow character-by-character, word-by-word reveal
  - Enhancement-only feature

- [ ] Performance optimizations
  - Incremental garbage collection
  - Background processor execution
  - Virtual scrolling for long conversations

### Never Do

- [ ] Don't re-add settlers - The parser handles all their responsibilities
- [ ] Don't create new mutable buffer patterns - Frames are intentionally immutable
- [ ] Don't make processors depend on settlers - They only work with frames

---

## Documentation Structure

### Framework Package Docs (`packages/framework/docs/`)
- **framework-design.md** - Framework philosophy and architecture
- **pipeline-guide.md** - Complete pipeline API documentation
- **migration-guide.md** - Migrating from old settler system
- **rendering-engine-design.md** - Rendering engine implementation
- **rendering-checklist.md** - Feature implementation status
- **notes.md** - Archived design notes reference

### Root Docs (`docs/`)
- **testing.md** - Testing patterns and best practices
- **hydra-isomorphic-tools-migration.md** - Hydra migration guide
- **runtime-base-path.md** - Runtime base path configuration
- **archive/** - Archived historical documentation

---

## Quick Reference

### To Get Up to Speed

1. **New to the codebase?** Start with `framework-design.md`
2. **Using the pipeline?** Read `pipeline-guide.md`
3. **Writing tests?** Check `docs/testing.md`
4. **Migrating old code?** See `migration-guide.md`

### Key Files by Purpose

| Purpose | File |
|---------|------|
| Pipeline types | `pipeline/types.ts` |
| Parser logic | `pipeline/parser.ts` |
| Pipeline execution | `pipeline/runner.ts` |
| Markdown processor | `pipeline/processors/markdown.ts` |
| Session orchestration | `session.ts` |
| Channel buffering | `transforms.ts` |
| Chat hook | `useChat.ts` |

---

## Checklist for Future Cleanups

Before starting any cleanup:

- [ ] Run `npm run typecheck` - Verify no TS errors
- [ ] Run `npm run test` - Ensure tests pass
- [ ] Create a branch: `git checkout -b cleanup/DESCRIPTION`
- [ ] Document changes in this file
- [ ] Update related documentation
- [ ] Run tests again
- [ ] Create a commit with clear message

After completing cleanup:

- [ ] Verify `npm run build` succeeds
- [ ] Verify full test suite passes
- [ ] Update CLEANUP.md with completion info
- [ ] Create PR with comprehensive description
