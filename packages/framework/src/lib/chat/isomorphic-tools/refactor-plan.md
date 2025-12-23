# Refactor Plan: Unified Isomorphic Tool Protocol

We are consolidating three distinct tool systems (Server-only, Client-only, and Isomorphic) into a single, unified Isomorphic Tool protocol. This eliminates technical debt, simplifies the codebase, and provides a consistent mental model: "Everything is an Isomorphic Tool."

## 1. Goal

Eliminate the legacy "Client Tools" and "Server Tools" distinct implementation paths.
- **Server Tools** become Isomorphic Tools with `authority: 'server'` and no client logic.
- **Client Tools** become Isomorphic Tools with `authority: 'client'` (client execution first, server validation second).

## 2. Architecture Changes

### current
- **Server Tools**: Executed on server; tool result returned to LLM.
- **Isomorphic Tools**: Server emits `isomorphic_handoff`, client executes, then server validates/continues.

### proposed
- **All Tools**: Handled via `isomorphic_handoff`.
- `session.ts` and `useChatSession` accept only `isomorphicTools`; legacy `clientTools` has been removed.

## 3. Implementation Steps

### Phase 1: Client Session Unification (Completed)
- [x] **Modify `session.ts`** to remove `clientTools` support.
- [x] **Modify `useChatSession`** to remove `clientTools` prop.

### Phase 2: Cleanup (Completed)
- [x] Delete `apps/dynobase/src/demo/effection/chat/tools/` (Legacy Client Tools system) once confirmed unused.
- [x] Remove legacy converter/test scaffolding.

## 4. Safety & Verification

Verify with:
- `pnpm -C apps/dynobase exec tsc -p tsconfig.json --noEmit`
- `pnpm -C apps/dynobase test`

**Critical Checks during Refactor:**
1. **Type Safety**: Ensure the `zod` schema conversion preserves optional fields and defaults.
2. **Approvals**: Verify that the "approval" flow for legacy client tools is correctly mapped to the Isomorphic `approval` config.

## 5. Builder API Plan (Isomorphic Tools)

We want the builder API to be the "one true" tool definition system.

### 5.1 API Surface

Keep the builder API limited to:
- `.authority('server' | 'client')`
- `.server(...)`
- `.client(...)`
- `.handoff(...)` (server authority only)

We intentionally do **not** expose `parallel` in the builder API.

### 5.2 Security / Middleware Principle

Secure-by-default execution semantics:
- If the client is involved at all, there must always be a server phase.
- Client-only tools still define a server phase (a default passthrough) so we can insert server middleware/plugins, auditing, validation hooks, etc.

### 5.3 Semantics by Authority

- `authority('server')`:
  - `.handoff({ before, client, after })` finalizes immediately.
  - `.server(fn).build()` produces a server-only tool.
  - `.server(fn).client(fn)` produces a server-first tool where server output is the LLM result.

- `authority('client')`:
  - `.client(fn).server(fn)` produces a client-first tool.
  - `.client(fn).build()` produces a client-first tool with a default server passthrough:
    `server(_params, _ctx, clientOutput) => clientOutput`.
  - `.handoff(...)` is not available.

### 5.4 State of Implementation

Completed in:
- `apps/dynobase/src/lib/chat/isomorphic-tools/builder.ts`
- `apps/dynobase/src/lib/chat/isomorphic-tools/__tests__/builder.test.ts`
- `apps/dynobase/src/lib/chat/isomorphic-tools/__tests__/builder-runtime.test.ts`

Specifically:
- Removed builder/runtime support for `parallel`.
- Added `.build()` support for client-authority tools (default server passthrough).
- Added tests for the new semantics.

## 6. Next Steps (Runtime Unification)

1. **Refactor `session.ts`**: Merge `clientTools` into `isomorphicTools`.
2. **Refactor `streamChatOnce.ts`**: Unify tool execution.
3. **Verify E2E**: Run `session-e2e.test.ts` to ensure everything still works.
