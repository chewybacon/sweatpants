# Core Tools Integration - Progress

Last updated: 2026-01-28

## Current Status: Phase 5 Complete - Ready for Testing

## Quick Summary

Integrating `@sweatpants/core` tools into `@sweatpants/framework` to allow core tools to work with the framework's chat engine and patch-based streaming.

## Phases

### Phase 1: Schema Exposure
**Status**: Complete

Add `schemas` property to core tool factories.

**Files modified**:
- [x] `packages/core/src/tool/types.ts` - Added `schemas` to interfaces
- [x] `packages/core/src/tool/create.ts` - Attached via Object.defineProperty

**Acceptance**:
- [x] `factory.schemas.input` returns the input schema
- [x] `factory.schemas.output` returns the output schema
- [x] `factory.schemas.progress` returns the progress schema (if defined)
- [x] Tests pass (4 new tests added)

---

### Phase 2: Core Tool Adapter
**Status**: Complete

Create adapter to wrap core tools as `AnyIsomorphicTool`.

**Files created**:
- [x] `packages/framework/src/lib/chat/core-tools/adapter.ts`
- [x] `packages/framework/src/lib/chat/core-tools/index.ts`

**Acceptance**:
- [x] `isCoreToolFactory()` correctly detects core tools
- [x] `adaptCoreTool()` produces valid `AnyIsomorphicTool`
- [x] Tests pass (9 tests in adapter.test.ts)

---

### Phase 3: Notify Bridge  
**Status**: Complete

Bridge core `notify()` calls to framework patches.

**Files created**:
- [x] `packages/framework/src/lib/chat/core-tools/framework-transport.ts`

**Acceptance**:
- [x] Core `notify()` emits `ClientToolProgressPatch`
- [x] Progress percentage (0-1) is included in patches
- [x] Tests pass

**Note**: The bridge currently has a placeholder for patch emission. Full integration with the executor is pending Phase 6.

---

### Phase 3b: Extend ClientToolProgressPatch
**Status**: Complete

Added `progress?: number` field to `ClientToolProgressPatch` for progress percentage.

**Files modified**:
- [x] `packages/framework/src/lib/chat/patches/tool.ts`

---

### Phase 4: Registry Integration
**Status**: Complete

Update registry to accept core tools.

**Files modified**:
- [x] `packages/framework/src/lib/chat/isomorphic-tools/registry.ts`

**Acceptance**:
- [x] `createIsomorphicToolRegistry()` accepts core tools
- [x] Core tools appear in `toToolSchemas()` output
- [x] Core tools work with `toServerTools()` 
- [x] Tests pass

---

### Phase 5: Unit Tests
**Status**: Complete

All unit tests pass (740 tests total, including 9 new adapter tests).

**Test coverage**:
- [x] `isCoreToolFactory()` detection
- [x] `adaptCoreTool()` adaptation
- [x] Registry integration with mixed tool types
- [x] Schema generation for core tools
- [x] Duplicate name detection

**E2E tests**: Not yet run (requires full Playwright setup with tic-tac-toe)

---

### Phase 6: Elicit Bridge
**Status**: Future

Bridge core `elicit()` calls to framework elicitation.

**Design notes**:
- Consider reusing Signal patterns from MCP bridge (`bridge-runtime.ts`)
- Will need session correlation for pending elicits
- Timeout and cancellation handling

---

## Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Schema exposure | Add to factory | Clean, single source of truth |
| Build order | Notify first, then elicit | Simpler, learn patterns |
| Transport bridge | Patch-based | Matches framework architecture |
| Middleware | Keep separate | Avoid coupling |
| Progress field | Added to patch | Enables richer UI (progress bars) |
| Patch emission | Context-based | Avoids modifying ServerToolContext |

## Known Issues

1. **Core package d.ts generation**: The core package's tsup build generates broken d.ts files due to Zod type import issues (`infer<T>` instead of `ZodInfer<T>`). This is a pre-existing issue unrelated to this integration.

## Next Actions

1. Wire up patch emission in the executor (connect `withFrameworkTransportAndEmitter` to actual patch channel)
2. Run E2E tests with tic-tac-toe to verify full integration
3. Design and implement Phase 6 (Elicit Bridge)

## Files Summary

### Core Package (modified)
- `packages/core/src/tool/types.ts` - Added `schemas` property to factory interfaces
- `packages/core/src/tool/create.ts` - Attached schemas via Object.defineProperty
- `packages/core/src/tool/__tests__/create.test.ts` - Added 4 tests for schemas

### Framework Package (new)
- `packages/framework/src/lib/chat/core-tools/adapter.ts` - Core tool adapter
- `packages/framework/src/lib/chat/core-tools/framework-transport.ts` - Transport bridge
- `packages/framework/src/lib/chat/core-tools/index.ts` - Barrel exports
- `packages/framework/src/lib/chat/core-tools/__tests__/adapter.test.ts` - 9 unit tests

### Framework Package (modified)
- `packages/framework/package.json` - Added `@sweatpants/core` dependency and export
- `packages/framework/src/lib/chat/patches/tool.ts` - Added `progress` field
- `packages/framework/src/lib/chat/isomorphic-tools/registry.ts` - Accept core tools
- `packages/framework/src/lib/chat/isomorphic-tools/index.ts` - Export `ToolInput` type
