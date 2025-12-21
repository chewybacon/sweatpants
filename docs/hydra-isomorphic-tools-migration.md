# Hydra Tools Migration to Isomorphic Pattern

## Context

The `apps/hydra/docs/ts/` directory contains tutorial/documentation files that define their own legacy-style tool system:

- `shared/tools.ts` - `ToolDef`, `ToolRegistry`, `createToolRegistry`, `executeToolCall`
- `tool-calling.ts` - Full tutorial with inline tool definitions
- `structured-output.ts` - Uses shared tools
- `test-tool-calling.ts` - Test harness with inline tools

These are **terminal-focused** tools that run in a Node.js CLI context. They currently use a simple `execute` function pattern that runs entirely on the "server" (the terminal process).

## Goal

Migrate hydra tools to the **isomorphic tool pattern** used in `apps/dynobase`, enabling:

1. Tools that can execute in terminal context (like current behavior)
2. Tools that could hand off to a "client" (e.g., a TUI, web UI, or other interface)
3. Two-phase execution where terminal collects input, server validates/processes

## Current Legacy Pattern

```ts
interface ToolDef<TParams extends z.ZodType, TReturn> {
  name: string
  description: string
  parameters: TParams
  execute: (args: z.infer<TParams>) => Operation<TReturn>
}

const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Get weather for a location',
  parameters: z.object({ location: z.string() }),
  *execute({ location }) {
    // Runs entirely in terminal process
    return { location, temperature: 22 }
  },
})
```

## Target Isomorphic Pattern

The isomorphic pattern from `apps/dynobase/src/lib/chat/isomorphic-tools/` supports:

### Server-Only Tools (simplest migration path)

For tools that don't need client interaction, use `defineServerOnlyTool`:

```ts
import { defineServerOnlyTool } from './isomorphic-tools'

const weatherTool = defineServerOnlyTool({
  name: 'get_weather',
  description: 'Get weather for a location',
  parameters: z.object({ location: z.string() }),
  *server({ location }) {
    // Runs on server, result goes directly to LLM
    return { location, temperature: 22 }
  },
})
```

### Server-Authority with Client Side Effects

For tools where server computes result but client needs to display/act on it:

```ts
import { defineServerAuthorityTool } from './isomorphic-tools'

const displayResultTool = defineServerAuthorityTool({
  name: 'display_result',
  description: 'Display a computed result to the user',
  parameters: z.object({ query: z.string() }),
  *server({ query }) {
    const result = yield* computeExpensiveResult(query)
    return { kind: 'handoff', output: result }
  },
  *client(serverOutput) {
    // Terminal/TUI displays the result
    console.log(formatResult(serverOutput))
    return { displayed: true }
  },
})
```

### Client-Authority Tools (user input required)

For tools where client must gather input before server can proceed:

```ts
import { defineClientAuthorityTool } from './isomorphic-tools'

const confirmActionTool = defineClientAuthorityTool({
  name: 'confirm_action',
  description: 'Ask user to confirm a dangerous action',
  parameters: z.object({ action: z.string(), risk: z.string() }),
  *client({ action, risk }) {
    // Terminal prompts user for confirmation
    const confirmed = yield* promptUser(`Confirm ${action}? Risk: ${risk} [y/n]`)
    return { confirmed }
  },
  *server({ action }, clientOutput) {
    if (!clientOutput.confirmed) {
      return { status: 'cancelled' }
    }
    yield* performDangerousAction(action)
    return { status: 'completed' }
  },
})
```

## Migration Steps

### Step 1: Copy isomorphic tool infrastructure

Copy or adapt from `apps/dynobase/src/lib/chat/isomorphic-tools/`:
- `types.ts` - Core type definitions
- `define.ts` - `defineServerOnlyTool`, `defineServerAuthorityTool`, `defineClientAuthorityTool`
- `registry.ts` - `createIsomorphicToolRegistry`
- `execute.ts` - `executeServerPart` for server-side execution

### Step 2: Create terminal-specific client executor

The dynobase client executor assumes browser context. For hydra, create a terminal executor:

```ts
// hydra/src/terminal-tool-executor.ts
import type { IsomorphicToolDef } from './isomorphic-tools/types'

function* executeClientPart<T extends IsomorphicToolDef>(
  tool: T,
  params: unknown,
  serverOutput: unknown
): Operation<unknown> {
  if (!tool.client) {
    return undefined
  }
  
  // Terminal-specific: might use readline, blessed, ink, etc.
  return yield* tool.client(params, serverOutput)
}
```

### Step 3: Update chat loop for isomorphic flow

Current hydra chat loop:
```ts
// Execute all tools, feed results back
const results = yield* all(
  result.toolCalls.map((tc) => executeToolCall(registry, tc))
)
```

New isomorphic chat loop:
```ts
for (const tc of result.toolCalls) {
  const tool = registry.get(tc.function.name)
  
  // Phase 1: Server execution
  const serverResult = yield* executeServerPart(tool, tc.function.arguments)
  
  if (serverResult.kind === 'result') {
    // Server-only tool, add result to messages
    messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(serverResult.output) })
  } else {
    // Handoff: execute client part
    const clientOutput = yield* executeClientPart(tool, tc.function.arguments, serverResult.output)
    
    if (tool.authority === 'client') {
      // Client-authority: run server phase 2
      const finalResult = yield* executeServerPart(tool, tc.function.arguments, clientOutput)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(finalResult.output) })
    } else {
      // Server-authority: client output is informational
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(serverResult.output) })
    }
  }
}
```

### Step 4: Migrate existing tools

| Current Tool | Migration Strategy |
|--------------|-------------------|
| `get_weather` | `defineServerOnlyTool` - no client interaction needed |
| `calculator` | `defineServerOnlyTool` - pure computation |
| `search` | `defineServerOnlyTool` - server fetches, returns result |
| (future) `confirm_delete` | `defineClientAuthorityTool` - needs user confirmation |
| (future) `select_option` | `defineClientAuthorityTool` - user picks from list |
| (future) `display_chart` | `defineServerAuthorityTool` - server computes, client renders |

## Terminal Client Considerations

### Readline Integration

For client-authority tools that need user input:

```ts
import * as readline from 'node:readline/promises'

function* promptUser(question: string): Operation<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  
  try {
    return yield* call(() => rl.question(question))
  } finally {
    rl.close()
  }
}
```

### TUI Libraries

For richer terminal UIs, consider:
- **Ink** (React for CLI) - component-based terminal UI
- **Blessed** - curses-like terminal widgets
- **Enquirer/Prompts** - interactive prompts

### Async Display

Server-authority tools with client side effects might update a status line:

```ts
*client(serverOutput) {
  // Update terminal UI without blocking
  updateStatusBar(`Processing: ${serverOutput.status}`)
  return { acknowledged: true }
}
```

## Benefits of Migration

1. **Unified tool model** - Same pattern across web and terminal apps
2. **Testability** - Server parts can be tested without terminal
3. **Future flexibility** - Easy to add web UI to hydra tools later
4. **Two-phase validation** - Server can validate after client gathers input
5. **Clear authority model** - Explicit about who owns the result

## Files to Update

1. `apps/hydra/docs/ts/shared/tools.ts` - Replace with isomorphic exports
2. `apps/hydra/docs/ts/tool-calling.ts` - Update tutorial for isomorphic pattern
3. `apps/hydra/docs/ts/structured-output.ts` - Update tool usage
4. `apps/hydra/docs/ts/test-tool-calling.ts` - Update test harness
5. Create `apps/hydra/src/terminal-executor.ts` - Terminal-specific client execution

## Non-Goals (for initial migration)

- Don't add network layer between terminal "client" and "server" - they run in same process
- Don't require full handoff protocol for server-only tools
- Don't break existing tutorial flow - keep examples pedagogically clear
