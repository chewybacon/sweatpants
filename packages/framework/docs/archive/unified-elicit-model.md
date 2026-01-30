# Unified Elicit Model

## Overview

This document describes the refactoring to unify isomorphic tools and MCP tools under a single "elicit" primitive. The goal is to simplify the chat state, reduce code duplication, and provide a cleaner mental model.

## Problem Statement

The `ChatState` currently tracks 3-4 parallel concepts for the same fundamental operation ("tool suspends, waits for client value"):

| Current State | Purpose | Used By |
|---------------|---------|---------|
| `pendingHandoffs` | Old handoff pattern | Isomorphic tools |
| `toolEmissions` | ctx.render() emissions | Both (merged in useChatSession) |
| `pluginElicitations` | MCP elicit requests | MCP plugin tools |
| ExecutionTrail* | Legacy step pattern | Unused in apps |

This creates:
- Duplicated state management code
- Parallel patch types (4 emission patches + 4 elicit patches)
- Confusion about which pattern to use
- Client-side merging logic in `useChatSession`

## Core Insight

**MCP's `elicit` is the better primitive.** An isomorphic tool is really just an MCP tool where:
- `before()` produces context for the elicit
- `yield* elicit(key, context)` suspends and waits
- `after(result)` transforms the result before returning to the model

**Emissions are a client-side concern.** The tool runtime doesn't care *how* the client gets the value - it just wants the value back. Multiple `ctx.render()` calls are an implementation detail of the client-side handler.

## Architecture

### Transport Layer (ChatState)

```typescript
interface ChatState {
  // ... existing fields ...
  
  // UNIFIED: Single tracking for "tool waiting for client"
  pendingElicits: Record<callId, PendingElicitState>
  
  // REMOVED:
  // - pendingHandoffs (folded into pendingElicits)
  // - toolEmissions (moved to React-local state)
  // - pluginElicitations (renamed to pendingElicits)
}

interface PendingElicitState {
  callId: string
  toolName: string
  elicitId: string
  key: string              // elicit key (e.g., 'pickFlight', '__handoff__')
  context: unknown         // typed context from before() or tool
  schema?: Record<string, unknown>
  status: 'pending' | 'responded'
  timestamp: number
}
```

### Client-Side (useChatSession)

Emissions become purely local React state (already happening for plugins). The hook exposes:

```typescript
interface UseChatSessionReturn {
  state: ChatState
  send: (content: string) => void
  abort: () => void
  reset: () => void
  capabilities: ChatState['capabilities']
  
  // Client tool approval (unchanged)
  pendingApprovals: PendingClientToolState[]
  approve: (callId: string) => void
  deny: (callId: string, reason?: string) => void
  
  // UNIFIED elicit API
  pendingElicits: PendingElicitState[]
  respondToElicit: (callId: string, elicitId: string, result: ElicitResult) => void
  
  // Emissions (React-local only, for rendering)
  toolEmissions: ToolEmissionTrackingState[]
  respondToEmission: (callId: string, emissionId: string, response: unknown) => void
}
```

### Tool Definition API

Keep `createTool` (renamed from `createIsomorphicTool`) as sugar over MCP internally:

```typescript
// User writes:
const pickCard = createTool('pick_card')
  .handoff({
    *before(params) { return { cards: shuffle(params.count) } },
    *client(handoff, ctx) { 
      return yield* ctx.render(CardPicker, { cards: handoff.cards }) 
    },
    *after(handoff, clientResult) { 
      return `You picked the ${clientResult.card}` 
    },
  })
  .build()

// Framework internally generates:
// 1. MCP tool with single '__handoff__' elicit
// 2. Plugin with onElicit handler that calls the user's client() function
```

The tool returns:
```typescript
pickCard.name        // 'pick_card'
pickCard.execute     // the MCP execute function
pickCard.plugin      // auto-generated plugin client registration
```

### Auto-Generated Plugin

When an isomorphic tool has a `client()` function, we auto-generate a plugin handler:

```typescript
// Internal translation in builder.ts .build():

const mcpTool = createMcpTool(config.name)
  .elicits({
    __handoff__: {
      response: z.unknown(),
      context: z.unknown(),
    }
  })
  .execute(function*(params, ctx) {
    const context = before ? yield* before(params) : params
    const result = yield* ctx.elicit('__handoff__', { message, ...context })
    if (result.action !== 'accept') return { cancelled: true }
    return after ? yield* after(context, result.content) : result.content
  })
  .build()

const autoPlugin = makePlugin(mcpTool)
  .onElicit({
    __handoff__: function*(req, ctx) {
      const context = getElicitContext(req)
      const result = yield* client(context, ctx, params)
      return { action: 'accept', content: result }
    }
  })
  .build()
```

## Unified Patches

### Before (8 patch types):
```
tool_emission_start, tool_emission, tool_emission_response, tool_emission_complete
plugin_elicit_start, plugin_elicit, plugin_elicit_response, plugin_elicit_complete
```

### After (4 patch types):
```
elicit_start    - tool is starting, may elicit
elicit          - tool wants client input (with key, context, schema)
elicit_response - client responded
elicit_complete - tool finished
```

## Key Decisions

1. **Keep both APIs** - `createTool` becomes sugar over MCP internally
2. **Drop client authority** - unused in apps, just "don't define before()" achieves same thing
3. **Breaking change** - power through, no deprecation period
4. **Unified patches** - rename `plugin_elicit_*` -> `elicit_*`, use for both tool types
5. **Auto-plugin** - isomorphic tools with `client()` auto-generate `.plugin`
6. **Emissions local** - `toolEmissions` purely React state, not in ChatState

## Migration for Consumers

### Before
```tsx
const { pendingHandoffs, respondToHandoff, toolEmissions, respondToEmission } = useChatSession({
  tools: [pickCard],
  plugins: [bookFlightPlugin.client],
})
```

### After
```tsx
const { pendingElicits, respondToElicit, toolEmissions, respondToEmission } = useChatSession({
  tools: [pickCard, bookFlightTool],
  plugins: [pickCard.plugin, bookFlightPlugin.client],
})
```

## Files Changed

### Delete
- `patches/emission.ts` (move types to React package)
- `isomorphic-tools/step-context.ts` (ExecutionTrail dead code)

### Rename
- `patches/plugin.ts` -> `patches/elicit.ts`
- `usePluginExecutor.ts` -> `useElicitExecutor.ts`
- `createIsomorphicTool` -> `createTool`

### Major Refactor
- `state/chat-state.ts` - simplify to `pendingElicits`
- `state/reducer.ts` - remove emission/handoff handlers
- `react/chat/useChatSession.ts` - unified API
- `isomorphic-tools/builder.ts` - produce MCP tool + auto `.plugin`
- `isomorphic-tools/executor.ts` - delegate to MCP path

## Implementation Phases

See `unified-elicit-progress.md` for detailed progress tracking.
