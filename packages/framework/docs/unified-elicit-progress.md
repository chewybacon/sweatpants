# Unified Elicit Model - Implementation Progress

## Status: In Progress

## Phases

### Phase 1: Clean Up Dead Code
Remove unused/parallel concepts to reduce noise before the main refactor.

| Task | Status | Notes |
|------|--------|-------|
| Remove ExecutionTrail types from `patches/handoff.ts` | pending | Lines 56-134 |
| Remove ExecutionTrail exports from `patches/index.ts` | pending | |
| Delete `isomorphic-tools/step-context.ts` | pending | Entire file |
| Remove `.authority('client')` path from builder | pending | |
| Remove client-authority handling from executor | pending | |
| Simplify types - remove client authority types | pending | |

### Phase 2: Unify Patch Types
Rename and consolidate patch types.

| Task | Status | Notes |
|------|--------|-------|
| Rename `patches/plugin.ts` -> `patches/elicit.ts` | pending | |
| Rename types `PluginElicit*` -> `Elicit*` | pending | |
| Move emission types to React package (local only) | pending | |
| Update `patches/index.ts` exports | pending | |

### Phase 3: Simplify ChatState
| Task | Status | Notes |
|------|--------|-------|
| Remove `pendingHandoffs` from ChatState | pending | |
| Remove `toolEmissions` from ChatState | pending | |
| Rename `pluginElicitations` -> `pendingElicits` | pending | |
| Update `initialChatState` | pending | |

### Phase 4: Update Reducer
| Task | Status | Notes |
|------|--------|-------|
| Remove `tool_emission_*` handlers | pending | |
| Rename `plugin_elicit_*` -> `elicit_*` handlers | pending | |
| Remove `pending_handoff` handlers | pending | |

### Phase 5: Refactor useChatSession
| Task | Status | Notes |
|------|--------|-------|
| Remove `toolEmissions` from session state sync | pending | |
| Keep `localEmissions` as only emission source | pending | |
| Rename `pluginElicitations` -> `pendingElicits` | pending | |
| Remove `pendingHandoffs` / `respondToHandoff` | pending | |
| Add unified `respondToElicit` | pending | |
| Update return type | pending | |

### Phase 6: Rename usePluginExecutor
| Task | Status | Notes |
|------|--------|-------|
| Rename file to `useElicitExecutor.ts` | pending | |
| Update to read from `pendingElicits` | pending | |
| Update imports across codebase | pending | |

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

### Phase 9: Update Session/Streaming
| Task | Status | Notes |
|------|--------|-------|
| Update `stream-chat.ts` for unified elicit handling | pending | |
| Remove handoff-specific paths from `create-session.ts` | pending | |
| Emit `elicit_*` patches for isomorphic tools | pending | |

### Phase 10: Update Apps
| Task | Status | Notes |
|------|--------|-------|
| Update `yo-chat/src/routes/chat/cards/` | pending | |
| Update `yo-chat/src/routes/chat/flight/` | pending | |
| Update `yo-chat/src/routes/chat/play-ttt/` | pending | |
| Update `yo-chat/src/routes/api.chat.ts` | pending | |
| Update tool registrations | pending | |

### Phase 11: Clean Up Old Code
| Task | Status | Notes |
|------|--------|-------|
| Remove dead isomorphic-specific executor paths | pending | |
| Remove old handoff handling | pending | |
| Clean up unused imports | pending | |
| Update tests | pending | |

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
