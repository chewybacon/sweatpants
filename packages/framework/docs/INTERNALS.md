# Framework Internals

This document describes the post-migration framework architecture. The framework no longer defines a second first-party tool authoring model. All first-party tools are canonical `@sweatpants/core` `ToolDefinition` values, and browser interaction is represented by declared elicits plus plugin handlers.

## Architecture Overview

```txt
@sweatpants/core
  createTool
  ToolDefinition
  ToolCtx: notify, elicit, sample, log

@sweatpants/framework/chat
  durable chat/session runtime
  tool inventory and runtime contracts
  canonical AG-UI client fold

@sweatpants/framework/chat/mcp-tools
  plugin registry
  plugin elicit executor
  MCP projection/runtime utilities

@sweatpants/framework/chat/browser-rendering
  render context types
  component emission/replay primitives

runtime packages
  local worker/session runtime
  AgentCore runtime adapter
  MCP bridge/runtime adapter
```

## Client Event Fold

Canonical AG-UI events are the durable wire format and the direct input to the client chat-state fold. Live streaming and durable hydration both call the same pure `chatReducer(state, event)` function; there is no intermediate framework patch vocabulary or replay-specific event mapper.

Browser-only concerns use explicitly local actions (`LOCAL_*`) and never enter the durable log. These actions cover optimistic user messages, rendering frames, abort/reset state, and hydrated component attachments. Interactive component callbacks remain ephemeral React state keyed by durable tool-call and interrupt identifiers.

`ChatState.messageDrafts` and `ChatState.toolCallDrafts` are reducer bookkeeping for assembling AG-UI lifecycle events. They are serializable so the fold remains pure, but UI code should treat them as internal and consume `messages`, `streaming`, and the message derivation helpers instead.

AG-UI interrupts are the single mechanism for elicitation, approval, and permission requests. The framework does not maintain a separate client-tool approval protocol.

## Tool Inventory

The framework stores tools as inventory entries. An entry has two sides:

1. **Model-safe definition**: name, description, JSON Schema, annotations, and capabilities.
2. **Runtime implementation**: the canonical tool definition or remote runtime reference.

The model-safe definition is safe to serialize. The implementation payload is never sent to the model.

```ts
import { createToolInventory, createToolInventoryEntry } from '@sweatpants/framework/chat'

const inventory = createToolInventory([
  createToolInventoryEntry(bookFlightTool, { runtime: 'local' }),
])
```

Inventory construction rejects duplicate tool names.

## Canonical Tool Execution

A runtime starts a tool session from a provider tool call:

1. Validate arguments against the canonical parameter schema.
2. Execute the tool's `execute` generator.
3. Project `ctx.notify(...)` calls to progress/log events.
4. Project `ctx.elicit(...)` calls to canonical elicit request events.
5. Project `ctx.sample(...)` calls to the configured sampling provider.
6. Emit a terminal result, error, or cancellation event.

## Browser Interaction

Browser interaction is a plugin concern. A tool declares elicit keys; a plugin binds those keys to host/browser handlers.

```ts
export const pickCardPlugin = makePlugin(pickCardTool)
  .onElicit({
    pickCard: function* (request, ctx) {
      const response = yield* ctx.render(CardPicker, request.context)
      return { action: 'accept', content: response }
    },
  })
  .build()
```

The plugin registry matches incoming elicit requests by tool name and key. Missing handlers fail fast instead of leaving a tool session permanently pending.

## Rendering and Replay

`@sweatpants/framework/chat/browser-rendering` owns React-compatible render types and emission/replay primitives. Plugin handlers use this layer to render UI during an elicit request. Durable sessions persist completed render traces so refreshed clients can replay disabled/completed UI without re-executing the tool.

## Durable Chat Engine

The durable chat handler coordinates provider streaming, tool calls, runtime sessions, and AG-UI checkpoints.

Primary state transitions:

```txt
idle
  └─ provider_streaming
       ├─ tool_call_detected
       ├─ tool_session_running
       ├─ awaiting_elicit
       ├─ tool_result_received
       └─ complete
```

When a tool requests an elicit, the handler emits canonical pending-elicit state and waits for a response routed through the runtime session. When the response arrives, the same session resumes and eventually emits a result or error.

## Runtime Adapters

- **Local runtime** executes canonical tools in-process or through a worker-backed tool session.
- **MCP runtime** projects canonical tools to MCP-compatible tool/session behavior.
- **AgentCore runtime** forwards canonical tool sessions to AgentCore and maps runtime events back to framework stream events.

All adapters use the same canonical tool metadata and event vocabulary.

## Public Boundaries

The framework public surface exposes runtime, plugin, and rendering utilities. Tool authoring remains in `@sweatpants/core`.

Public framework exports SHOULD remain limited to:

- `@sweatpants/framework/chat`
- `@sweatpants/framework/chat/mcp-tools`
- `@sweatpants/framework/chat/browser-rendering`
- `@sweatpants/framework/chat/durable-streams`
- `@sweatpants/framework/server`

## Related Documents

- [GLOSSARY.md](./GLOSSARY.md)
- [TRACE.md](./TRACE.md)
