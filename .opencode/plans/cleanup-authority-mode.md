# Plan: Remove Authority Mode from Isomorphic Tools

**Created:** 2026-02-03
**Status:** READY TO IMPLEMENT
**Supersedes:** unified-tool-runtime-design.md, unified-tool-runtime-progress.md

---

## Summary

Remove the `authority` mode complexity from isomorphic tools. All isomorphic tools 
are now implicitly server-first. The `.authority()` builder method is removed 
entirely (not backward compatible).

## Rationale

1. **No apps use client-first execution** - only test fixtures
2. **Simpler mental model** - tools always run server-first
3. **User clarification** - "client-first is really just server with passthrough"
4. **Cleanup focus** - not a rewrite, just removal of unused complexity

## Layering Goal

After cleanup, the layering should be:

```
@sweatpants/core (foundation - middleware + TransportContext)
    ↑
mcp-tools (wrapper adding elicit, sample, branch patterns)
    ↑
isomorphic-tools (convenience: single elicit + before/after)
```

---

## Implementation Phases

### Phase 1: Core Types (`isomorphic-tools/types.ts`)

Remove authority-related types and simplify the type system.

**Changes:**
- Remove `AuthorityMode` type (`export type AuthorityMode = 'server' | 'client'`)
- Remove `ClientAuthorityToolDef<>` type  
- Update `AnyIsomorphicTool` to remove `authority`
- Remove `server_validating` from `IsomorphicToolState`
- Update `IsomorphicHandoffEvent` to remove `authority`
- Update JSDoc comments referencing client-first execution

### Phase 2: Builder (`isomorphic-tools/builder.ts`)

Remove the `.authority()` method and client-first builder path.

**Changes:**
- Remove `.authority<TAuth>()` method from `IsomorphicToolBuilderWithContext`
- Remove `IsomorphicToolBuilderClientAuthority` interface entirely
- Remove `IsomorphicToolBuilderServerAuthority` references (now only one path)
- Simplify builder state machine - no authority branching
- Update all `.context()` to not return client-first types
- Update example docstrings (remove `.authority('server')`)

### Phase 3: Executor (`isomorphic-tools/executor.ts`)

Remove client-first execution paths.

**Changes:**
- Remove client-first branches in `executePhase1`
- Remove client-first branches in `completePhase2`
- Remove client-first branches in `executeOnClient`
- Remove `server_validating` state handling
- Simplify handoff flow - always server-first
- Update comments referencing client-first

### Phase 4: Tool Handlers (`isomorphic-tools/tool-handlers.ts`)

Simplify type inference.

**Changes:**
- Remove `ClientAuthorityToolDef` from imports
- Remove `ClientAuthorityToolDef` path from `InferClientOutput` type
- Remove `ClientAuthorityToolDef` path from `InferParams` type
- Simplify type inference (no more client-first branching)

### Phase 5: Handler & Session Files

Update handler and session code that references client-first.

**Files:**
- `handler/durable/chat-engine.ts` - Remove client-first checks
- `handler/durable/types.ts` - Remove client-first fields
- `handler/types.ts` - Remove client-first fields
- `session/create-session.ts` - Remove client-first references
- `session/streaming.ts` - Update types and comments
- `session/stream-chat.ts` - Update comments

### Phase 6: App Tools (7 files)

Remove `.authority('server')` line from each tool.

**Files:**
- `apps/yo-chat/src/tools/calculator.ts`
- `apps/yo-agent/src/tools/read-file.ts`
- `apps/yo-agent/src/tools/git-log.ts`
- `apps/yo-agent/src/tools/grep-search.ts`
- `apps/yo-agent/src/tools/glob-files.ts`
- `apps/yo-agent/src/tools/git-status.ts`
- `apps/yo-agent/src/tools/git-diff.ts`

### Phase 7: Tests

Update test files - delete client-first tests, convert others.

**Delete:**
- Client-first specific tests in `builder.test.ts`

**Convert to server-first:**
- `v7-handoff-executor.test.ts` - "client-first tool" describe block
- `v7-handoff-basic.test.ts` - test at line 351
- `builder-runtime.test.ts` - 2 tests with `.authority('client')`
- `tool-handlers.test.ts` - "infer params for client-first tools" test

**Remove `.authority('server')` from:**
- `tool-discovery.test.ts` - test fixtures
- All other test files

### Phase 8: Examples & Documentation

Update examples and documentation.

**Files:**
- `docs/archive/examples/example-builtin-tools.ts`
- `isomorphic-tools/card-game.ts`
- `isomorphic-tools/client-hooks.ts`
- `isomorphic-tools/index.ts`

### Phase 9: Cleanup Old Plans

Archive or delete superseded plan files.

**Files:**
- `.opencode/plans/unified-tool-runtime-design.md`
- `.opencode/plans/unified-tool-runtime-progress.md`

### Phase 10: Verification

Run all verification commands.

**Commands:**
```bash
pnpm --filter @sweatpants/framework test
pnpm --filter @sweatpants/framework build
cd packages/framework && pnpm tsc --noEmit
pnpm --filter yo-chat dev
pnpm --filter yo-agent dev
```

---

## Files Summary

| Category | Count | Action |
|----------|-------|--------|
| Core types/builder | 4 | Refactor |
| Handler/Session | 6 | Update |
| App tools | 7 | Remove 1 line each |
| Test files | 10+ | Update/Convert |
| Examples/Docs | 5 | Update |
| Old plan files | 2 | Archive |

**Total: ~35-40 files**

---

## Rollback Plan

If issues are discovered:
1. All changes are in a single commit
2. Git revert available
3. No external API changes (internal-only cleanup)

---

## References

- Progress tracking: `.opencode/plans/cleanup-authority-mode-progress.md`
- Architecture: `packages/framework/docs/INTERNALS.md`
- Core tools: `packages/core/src/tool/`
