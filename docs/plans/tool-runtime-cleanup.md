# Tool Runtime Cleanup Plan

## Context

The tool runtime code in `packages/framework/src/lib/chat/mcp-tools/` has accumulated dead code, duplicates, and backward compatibility layers from 4-5 rewrites. This plan tracks the cleanup effort.

## Status: Phase 1 Complete, Phase 2 Pending

---

## Phase 1: Remove Branch System - COMPLETE

The branch-based agent-to-agent transport is being replaced by a new approach in `sweatpants/core`. All branch-* code is now dead.

### Files Deleted

| # | File | Lines | Status |
|---|------|-------|--------|
| 1 | `packages/framework/src/lib/chat/mcp-tools/branch-runtime.ts` | 698 | [x] Deleted |
| 2 | `packages/framework/src/lib/chat/mcp-tools/branch-mock.ts` | 350 | [x] Deleted |
| 3 | `packages/framework/src/lib/chat/mcp-tools/__tests__/branch.test.ts` | ~600 | [x] Deleted |
| 4 | `apps/yo-mcp/src/tools/pick-card-branch.ts` | 157 | [x] Deleted |

### Files Edited

| # | File | Change | Status |
|---|------|--------|--------|
| 5 | `packages/framework/src/lib/chat/mcp-tools/index.ts` | Remove branch exports (lines 176-194) | [x] Done |
| 6 | `apps/yo-mcp/src/tools/index.ts` | Remove pickCardBranchTool import/export | [x] Done |
| 7 | `apps/yo-mcp/playwright.config.ts` | Remove pick_card_branch comment | [x] Done |

### Validation

- [x] TypeScript compiles clean
- [x] E2E tests pass: 9 passed, 1 skipped (1.2m)

**Total lines removed: ~1,800**

---

## Phase 2: Other Dead Code Cleanup (Pending)

### Delete

| # | Item | Location | Notes |
|---|------|----------|-------|
| 1 | `runMCPToolOrThrow` | `mock-runtime.ts:367-380` | Exported but never imported |
| 2 | Duplicate error classes | `types.ts:431-478` | `MCPCapabilityError`, `MCPTimeoutError`, `MCPDisconnectError` |
| 3 | Underscore aliases | `types.ts:41-82` | `_MCPToolRef`, etc. - unused re-exports |

### Consolidate

| # | Item | Notes |
|---|------|-------|
| 4 | Error classes | Keep only in `mcp-tool-types.ts`, remove from `types.ts` |

### Keep (For Now)

- `builder.ts` / `createMCPTool` - Still in use, not ready to deprecate
- `mock-runtime.ts` - Used by `execution.test.ts` and `book-flight.test.ts`

---

## Findings Log

### Pre-Audit Test Results (Baseline)
- **pick-card**: 4 passed, 1 flaky (unrelated button timing)
- **book-flight**: 8 passed, 1 skipped
- **play-ttt**: 9 passed, 1 skipped

### Dead Code Evidence

1. `runMCPToolOrThrow` - grep found 0 imports outside its own file
2. Branch exports - only consumed by branch-mock.ts and pick-card-branch.ts (both deleted)
3. `pick_card_branch` - mentioned in playwright.config.ts comment but no actual e2e test existed

---

## Changelog

- **2025-01-XX**: Phase 1 complete - removed branch system (~1,800 lines)
  - Deleted: branch-runtime.ts, branch-mock.ts, branch.test.ts, pick-card-branch.ts
  - Edited: index.ts, tools/index.ts, playwright.config.ts
  - All e2e tests pass
