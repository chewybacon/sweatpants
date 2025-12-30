# Cleanup Checklist

This document tracks items that are no longer needed and should be removed or archived.

## 1. Deprecated Files in packages/framework

### 1.1 Old Settler System

**Status:** The settler system is deprecated. The parser now handles structure automatically.
**Used by:** Tests (`settlers.test.ts`, `code-fence-streaming.test.ts`)

| File | Status | Action |
|------|--------|--------|
| `src/react/chat/settlers.ts` | Deprecated | Keep for tests, re-exports only |
| `src/react/chat/settlers/index.ts` | Deprecated | Keep for tests, re-exports only |
| `src/react/chat/settlers/paragraph.ts` | Deprecated | Keep for tests |
| `src/react/chat/settlers/line.ts` | Deprecated | Keep for tests |
| `src/react/chat/settlers/sentence.ts` | Deprecated | Keep for tests |
| `src/react/chat/settlers/code-fence.ts` | Deprecated | Keep for tests |
| `src/react/chat/settlers/timeout.ts` | Deprecated | Keep for tests |
| `src/react/chat/settlers/max-size.ts` | Deprecated | Keep for tests |
| `src/react/chat/settlers/combinators.ts` | Deprecated | Keep for tests |
| `src/react/chat/types/settler.ts` | Deprecated | Keep for tests |

**Note:** Settlers should remain for backward compatibility with tests. They can be removed once tests are migrated to the new pipeline.

**Migration:** Settlers are replaced by the parser. New code should use the pipeline API.

### 1.2 Transform Infrastructure (`transforms.ts`)

**Status:** ACTIVE - Channel infrastructure for buffering and chaining.

| File | Purpose |
|------|---------|
| `useBufferedChannel` | Buffers messages until subscriber is ready (solves subscribe-before-send) |
| `useTransformPipeline` | Chains multiple transforms together with buffered input |
| `passthroughTransform` | No-op transform for debugging |
| `loggingTransform` | Debug transform that logs all patches |

**Current Usage:**
```typescript
// In session.ts line 277-280
const streamPatches = yield* useTransformPipeline(
  patches,
  options.transforms ?? []  // Usually [createPipelineTransform(config)]
)
```

**Architecture:**
```
streamChatOnce → [useTransformPipeline: buffered input] → [createPipelineTransform] → patches → React
                              ↑                                              ↑
                        Buffers messages                         Processes rendering
                        Chains transforms                        Emits HTML patches
```

**What it provides:**
1. **Buffering** - Messages are queued until the transform subscribes
2. **Chaining** - Multiple transforms can be composed in sequence
3. **Passthrough** - If no transforms, just passes through

---

## Simplification Opportunity

The `useTransformPipeline` wrapper adds an extra layer. Currently:
- `useChat` creates `[createPipelineTransform]`
- `session.ts` wraps with `useTransformPipeline`
- `createPipelineTransform` has its own subscription loop

**Potential simplification:** Move buffering directly into `createPipelineTransform` and remove `useTransformPipeline` wrapper.

**Before:**
```
streamChatOnce → [useTransformPipeline] → [createPipelineTransform] → patches
```

**After (simpler):**
```
streamChatOnce → [createPipelineTransform with built-in buffering] → patches
```

**Benefits:**
- Fewer abstraction layers
- Clearer data flow
- Easier to understand

**Trade-off:**
- Loses general-purpose transform chaining (not currently used anyway)
- Creates coupling between buffering and rendering logic

**Decision:** Leave as-is for now since it works. Consider simplifying in future refactor.

| File | Status | Action |
|------|--------|--------|
| `src/react/chat/types/index.ts` | Review | Consolidate with pipeline/types.ts |
| `src/react/chat/types/processor.ts` | Review | Consolidate with pipeline/types.ts |
| `src/react/chat/types/session.ts` | Review | Check if needed |
| `src/react/chat/types/state.ts` | Review | Check if needed |

**Note:** Some types may be duplicated between `types/` and `pipeline/types.ts`.

### 1.4 Old Exports in index.ts

Check `packages/framework/src/react/chat/index.ts`:

```ts
// Lines to review/remove:
export * from './settlers'           // Remove - settlers deprecated
// export * from './transforms'       // Remove or update - transforms deprecated
```

---

## 2. Old Documentation Files

### 2.1 Root /docs Directory (Duplicated/Outdated)

These docs are duplicated or outdated. They should be removed or marked as legacy.

| File | Status | Action |
|------|--------|--------|
| `docs/settlers.md` | Outdated | Remove - content moved to `packages/framework/docs/migration-guide.md` |
| `docs/processors.md` | Outdated | Remove - content moved to `packages/framework/docs/pipeline-guide.md` |
| `docs/chat-streaming.md` | Uses old API | Update to new pipeline or archive |
| `docs/framework-design.md` | Uses @dynobase | Update to @sweatpants or archive |
| `docs/processor-design-notes.md` | Outdated design | Archive or integrate into pipeline-guide.md |
| `docs/testing.md` | Review | Check if still accurate |

### 2.2 Old Doc References

| File | Status | Action |
|------|--------|--------|
| `docs/runtime-base-path.md` | Unrelated | Keep (not about rendering) |
| `docs/hydra-isomorphic-tools-migration.md` | Unrelated | Keep (not about rendering) |
| `docs/refactor-plan-effection-chat.md` | Historical | Archive or integrate |
| `docs/test-prompt.md` | Unrelated | Keep or remove as needed |

---

## 3. Legacy Code in apps/dynobase

The dynobase app still uses the old dualBufferTransform. This is expected as it's the prototype.

| File | Status | Action |
|------|--------|--------|
| `apps/dynobase/src/demo/effection/chat/dualBuffer.ts` | Legacy | Keep for prototype, don't migrate |
| `apps/dynobase/src/demo/effection/chat/processors.ts` | Legacy | Keep for prototype |
| `apps/dynobase/src/demo/effection/chat/settlers.ts` | Legacy | Keep for prototype |
| All demos using `dualBufferTransform` | Legacy | Keep for prototype, demonstrate old API |

**Note:** Dynobase is the "early prototype" - it doesn't need to be migrated. It's a historical reference.

---

## 4. Outdated @dynobase References

### 4.1 Documentation Files

| File | Status | Action |
|------|--------|--------|
| `docs/framework-design.md` | Has @dynobase | Update to @sweatpants or remove |

### 4.2 Code References (Expected - Framework Name Pending)

These files use `@dynobase/framework` which is expected until we finalize the package name:

- All files importing from `@dynobase/framework/*` - Update when name finalized
- Documentation mentioning package name - Update when name finalized

---

## 5. Archive Candidates

### 5.1 Design Notes and Transcripts

| File | Status | Action |
|------|--------|--------|
| `packages/framework/docs/transcripts/` | Historical | Keep as reference, not main docs |
| `docs/processor-design-notes.md` | Outdated | Archive |
| `docs/refactor-plan-effection-chat.md` | Historical | Archive |

### 5.2 Old Documentation

| File | Status | Action |
|------|--------|--------|
| `packages/framework/docs/rendering-engine-design.md` | Now reflects implemented | Keep as current docs |
| `packages/framework/docs/rendering-checklist.md` | Now status tracker | Keep as status tracker |
| `packages/framework/docs/notes.md` | Archived | Keep as archive note |

---

## 6. Priority Cleanup Items

### High Priority (Breakage Risk)

- [x] Remove re-exports of deprecated settlers from `packages/framework/src/react/chat/index.ts` **COMPLETED**
- [x] Remove unused `transforms.ts` import from index if deprecated **NOT NEEDED** (transforms.ts is active)
- [x] Delete `docs/settlers.md` (duplicated content in migration-guide.md) **COMPLETED**
- [x] Delete `docs/processors.md` (duplicated content in pipeline-guide.md) **COMPLETED**

### Medium Priority (Cleanup)

- [x] Archive `docs/processor-design-notes.md` **COMPLETED**
- [x] Archive `docs/refactor-plan-effection-chat.md` **COMPLETED**
- [x] Archive `docs/chat-streaming.md` **COMPLETED**
- [x] Review and consolidate duplicate types in `packages/framework/src/react/chat/types/` **REFACTORED** - Created `types/metadata.ts` with generic `ContentMetadata`

### Low Priority (Nice to Have)

- [ ] Update `docs/framework-design.md` @dynobase references (when package name finalized)
- [x] Remove unused settler files from `packages/framework/src/react/chat/settlers/` **COMPLETED** - Entire settlers/ directory deleted
- [ ] Consolidate `types/` directory with `pipeline/types.ts`
- [ ] Archive old design transcripts

---

## 7. Breaking Changes Checklist

Before removing deprecated code, verify:

- [ ] `pipeline-guide.md` covers all processor use cases
- [ ] `migration-guide.md` covers all settler → pipeline migration
- [ ] No apps depend on deprecated exports
- [ ] Tests are updated to use new API
- [ ] TypeScript compiles without deprecated imports

---

## 8. Safe to Remove (No Dependencies)

### 8.1 Files with No External Dependencies

These files can be safely removed once no imports reference them:

```bash
# Check for imports before removing
grep -r "from.*settlers" --include="*.ts" --include="*.tsx" packages/framework/
grep -r "from.*transforms" --include="*.ts" --include="*.tsx" packages/framework/
```

### 8.2 Documentation Safe to Delete

- `docs/settlers.md` - Replaced by `packages/framework/docs/migration-guide.md`
- `docs/processors.md` - Replaced by `packages/framework/docs/pipeline-guide.md`

---

## 9. Commands for Cleanup

### Find all references to deprecated exports

```bash
# Find settlers references
grep -r "from.*settlers" --include="*.ts" --include="*.tsx" packages/framework/

# Find transforms references  
grep -r "from.*transforms" --include="*.ts" --include="*.tsx" packages/framework/

# Find dualBufferTransform usage
grep -r "dualBufferTransform" --include="*.ts" --include="*.tsx" packages/framework/
```

### Find documentation referencing old API

```bash
# Find @dynobase in docs
grep -r "@dynobase" docs/ --include="*.md"

# Find settlers in root docs
grep -r "settler" docs/ --include="*.md" | grep -v "settlers.md"
```

---

## 10. Post-Cleanup Verification

After cleanup, verify:

- [ ] `npm run typecheck` passes
- [ ] `npm run test` passes
- [ ] `npm run build` passes
- [ ] Framework docs build correctly
- [ ] No broken imports in source files
- [ ] Documentation links work

---

## 11. Summary

### ✅ FULL CLEANUP COMPLETED (Dec 30, 2025)

**All phases executed successfully:**

#### Phase 1: Documentation Archival ✅
- Archived 5 outdated docs to `/docs/archive/`
- Created archive README with migration guide

#### Phase 2: Remove Public API Exports ✅
- Removed settler re-exports from `index.ts`
- Removed settler types from `types/index.ts`
- **Refactored:** Created `types/metadata.ts` with generic `ContentMetadata` type
- Updated all references in `patch.ts`, `useChat.ts`, `state.ts`, `processor.ts`, `types.ts`

#### Phase 3: Delete Test Files ✅
- Deleted `test-utils.ts` (unused)
- Deleted `settlers.test.ts` (48 tests - only tested deprecated code)
- Deleted `code-fence-streaming.test.ts` (19 tests - only tested deprecated code)
- **Result:** 328 → 263 tests (removed 65 settler-specific tests)

#### Phase 4: Delete Settler Implementation ✅
- Deleted entire `settlers/` directory (8 files)
- Deleted `settlers.ts` wrapper
- Deleted `types/settler.ts`
- Updated `types.ts` reference to use `ContentMetadata`

### ✅ Final Verification

- `npm run typecheck` → **PASS** (no errors)
- `npm run test` → **PASS** (263 tests | 1 skipped)
- `npm run build` → **PASS** (CJS + DTS + TSup)

### ✅ What IS Deprecated (Removed)

| Item | Status | Location |
|------|--------|----------|
| Settlers (paragraph, codeFence, etc.) | ❌ REMOVED | Was in `settlers/` |
| Settler types (SettleContext, etc.) | ❌ REMOVED | Was in `types/settler.ts` |
| dualBufferTransform (rendering) | ❌ REMOVED | Was in `settlers/` |
| Settler test files | ❌ REMOVED | Deleted 3 test files |

### ✅ What is ACTIVE (Kept)

| Item | Status | Location |
|------|--------|----------|
| transforms.ts (channel buffering) | ✅ ACTIVE | `packages/framework/src/react/chat/transforms.ts` |
| createPipelineTransform (rendering) | ✅ ACTIVE | `packages/framework/src/react/chat/pipeline/runner.ts` |
| useTransformPipeline (channel chaining) | ✅ ACTIVE | `packages/framework/src/react/chat/transforms.ts` |
| Pipeline processors (markdown, shiki, mermaid, math) | ✅ ACTIVE | `packages/framework/src/react/chat/pipeline/processors/` |

### Remaining Low-Priority Tasks

- [ ] Update `docs/framework-design.md` @dynobase references (when package name finalized)
- [ ] Consolidate `types/` directory with `pipeline/types.ts` (optional refactor)
- [ ] Add new integration tests for critical paths (recommended)

### Keep (Not About Rendering)

- [ ] `docs/runtime-base-path.md`
- [ ] `docs/hydra-isomorphic-tools-migration.md`
- [ ] `docs/test-prompt.md`
- [ ] `docs/testing.md`
- [ ] `packages/framework/docs/transcripts/` - Historical reference

### Keep (Active Code)

- [ ] `packages/framework/src/react/chat/transforms.ts` - Channel infrastructure (NOT deprecated)
- [ ] `packages/framework/src/react/chat/session.ts` - Session orchestration
- [ ] All pipeline/ files - Active rendering system

### Remove from Root /docs (Duplicates)

- [ ] `docs/settlers.md` - Replaced by `packages/framework/docs/migration-guide.md`
- [ ] `docs/processors.md` - Replaced by `packages/framework/docs/pipeline-guide.md`

### Clarification: transforms.ts vs pipeline/

| File | Purpose | Status |
|------|---------|--------|
| `transforms.ts` | Channel buffering and chaining | ACTIVE |
| `pipeline/runner.ts` | Rendering pipeline (createPipelineTransform) | ACTIVE |
| `settlers/` | Old settler system | DEPRECATED |

These are separate systems:
- `transforms.ts`: Infrastructure for streaming patches (subscribe-before-send)
- `pipeline/`: Frame-based rendering system
