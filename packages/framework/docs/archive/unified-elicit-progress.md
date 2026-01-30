# Unified Elicit Model - Implementation Progress

## Status: In Progress

## Phases

### Phase 1: Clean Up Dead Code ✅
Remove unused/parallel concepts to reduce noise before the main refactor.

| Task | Status | Notes |
|------|--------|-------|
| Remove ExecutionTrail types from `patches/handoff.ts` | ✅ done | Lines 56-134 removed |
| Remove ExecutionTrail exports from `patches/index.ts` | ✅ done | |
| Delete `isomorphic-tools/step-context.ts` | ✅ done | Entire file deleted |
| Remove `.authority('client')` path from builder | deferred | Phase 7 |
| Remove client-authority handling from executor | deferred | Phase 7 |
| Simplify types - remove client authority types | deferred | Phase 7 |

### Phase 2: Unify Patch Types ✅
Rename and consolidate patch types.

| Task | Status | Notes |
|------|--------|-------|
| Rename `patches/plugin.ts` -> `patches/elicit.ts` | ✅ done | Created new file, deleted old |
| Rename types `PluginElicit*` -> `Elicit*` | ✅ done | Legacy aliases kept |
| Move emission types to React package (local only) | ✅ done | Still in emission.ts for re-export |
| Update `patches/index.ts` exports | ✅ done | |

### Phase 3: Simplify ChatState ✅
| Task | Status | Notes |
|------|--------|-------|
| Remove `pendingHandoffs` from ChatState | ✅ done | |
| Remove `toolEmissions` from ChatState | ✅ done | |
| Rename `pluginElicitations` -> `pendingElicits` | ✅ done | |
| Update `initialChatState` | ✅ done | |

### Phase 4: Update Reducer ✅
| Task | Status | Notes |
|------|--------|-------|
| Remove `tool_emission_*` handlers | ✅ done | |
| Rename `plugin_elicit_*` -> `elicit_*` handlers | ✅ done | |
| Remove `pending_handoff` handlers | ✅ done | |

### Phase 5: Refactor useChatSession ✅
| Task | Status | Notes |
|------|--------|-------|
| Remove `toolEmissions` from session state sync | ✅ done | Emissions now React-local only |
| Keep `localEmissions` as only emission source | ✅ done | |
| Rename `pluginElicitations` -> `pendingElicits` | ✅ done | |
| Remove `pendingHandoffs` / `respondToHandoff` | ✅ done | Returns empty array (backward compat) |
| Add unified `respondToElicit` | deferred | Phase 7 |
| Update return type | ✅ done | |

### Phase 6: Rename usePluginExecutor (deferred)
| Task | Status | Notes |
|------|--------|-------|
| Rename file to `useElicitExecutor.ts` | deferred | Low priority, can do later |
| Update to read from `pendingElicits` | ✅ done | Uses pendingElicits now |
| Update imports across codebase | deferred | |

### Phase 7: Isomorphic Tool -> MCP Translation
| Task | Status | Notes |
|------|--------|-------|
| Update `builder.ts` to produce MCP tool | pending | |
| Add `.plugin` accessor with auto-generated handler | pending | |
| Update return shape from `.build()` | pending | |
| Rename `createIsomorphicTool` -> `createTool` | pending | |

### Phase 8: Unified Registry
| Task | Status | Notes |
|------|--------|-------|
| Create unified registry that handles both tool types | pending | |
| Auto-extract plugins from tools that bundle them | pending | |
| Simplify registration API | pending | |

### Phase 9: Update Session/Streaming ✅
| Task | Status | Notes |
|------|--------|-------|
| Update `stream-chat.ts` for unified elicit handling | ✅ done | Now emits `elicit_*` patches |
| Remove handoff-specific paths from `create-session.ts` | deferred | Phase 7 |
| Emit `elicit_*` patches for isomorphic tools | deferred | Phase 7 |

### Phase 10: Update Apps
| Task | Status | Notes |
|------|--------|-------|
| Update `yo-chat/src/routes/chat/cards/` | pending | |
| Update `yo-chat/src/routes/chat/flight/` | pending | |
| Update `yo-chat/src/routes/chat/play-ttt/` | pending | |
| Update `yo-chat/src/routes/api.chat.ts` | pending | |
| Update tool registrations | pending | |

### Phase 11: Clean Up Old Code ✅
| Task | Status | Notes |
|------|--------|-------|
| Remove dead isomorphic-specific executor paths | deferred | Phase 7 |
| Remove old handoff handling | deferred | Phase 7 |
| Clean up unused imports | ✅ done | |
| Update tests | ✅ done | Deleted obsolete tests, fixed remaining |

## Estimated Scope

| Phase | Files | Complexity |
|-------|-------|------------|
| 1. Clean up dead code | ~6 files | Low |
| 2. Unify patches | ~4 files | Medium |
| 3. Simplify ChatState | ~2 files | Low |
| 4. Update reducer | ~1 file | Medium |
| 5. Refactor useChatSession | ~1 file | Medium |
| 6. Rename usePluginExecutor | ~2 files | Low |
| 7. Isomorphic -> MCP translation | ~3 files | High |
| 8. Unified registry | ~2 files | Medium |
| 9. Update session/streaming | ~3 files | Medium |
| 10. Update apps | ~6 files | Medium |
| 11. Clean up old code | ~4 files | Low |

**Total: ~34 files**

## Log

- 2026-01-19: Created design doc and progress tracking
- 2026-01-19: Completed Phases 1-4 (clean up, unify patches, simplify ChatState, update reducer)
- 2026-01-19: Completed Phases 5, 9, 11 (useChatSession refactor, stream-chat.ts patches, tests fixed)
  - Emissions are now React-local only (removed from ChatState)
  - `pluginElicitations` renamed to `pendingElicits`
  - Patch types renamed: `plugin_elicit_*` → `elicit_*`
  - Deleted obsolete emission-reducer.test.ts
  - All 731 tests pass
