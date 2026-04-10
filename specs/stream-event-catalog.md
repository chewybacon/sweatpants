# Stream Event Catalog

- **Status:** Draft
- **Version:** 2026-04-10
- **Parent:** [Durable Stream Protocol](./durable-stream-protocol.md)

## Overview

This document catalogs every member of the `StreamEvent` discriminated union.
Each event is identified by its `type` field. Events are grouped into
categories for filtering and display purposes.

A conforming consumer MUST tolerate unknown event types (skip them gracefully).
A conforming producer MUST NOT emit events with a `type` value not defined in
this catalog or a future revision of it.

### Provenance

Each event is marked with its provenance:

| Label | Meaning |
|---|---|
| **AG-UI** | Defined by the AG-UI protocol specification. |
| **Framework** | Extension defined by the Sweatpants framework. Not part of the AG-UI base spec. |

---

## Categories

| Category | Event Types | Description |
|---|---|---|
| **Lifecycle** | `session_info`, `ag_ui_run_started`, `ag_ui_run_finished` | Session and run boundaries |
| **Text** | `thinking`, `ag_ui_text_message_start`, `ag_ui_text_message_content`, `ag_ui_text_message_end` | Text generation and reasoning |
| **Tool** | `ag_ui_tool_call_start`, `ag_ui_tool_call_args`, `ag_ui_tool_call_end`, `ag_ui_tool_call_result`, `ag_ui_tool_call_error`, `isomorphic_handoff`, `elicit_request`, `tool_session_status`, `tool_session_error` | Tool invocation lifecycle |
| **State** | `ag_ui_messages_snapshot`, `ag_ui_state_snapshot`, `ag_ui_checkpoint` | Conversation state snapshots |
| **Error** | `error` | Protocol and runtime errors |

---

## Lifecycle Events

### `session_info`

**Provenance:** Framework

Emitted once at the start of a session to report server capabilities and
persona configuration.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"session_info"` | MUST | Discriminator |
| `capabilities` | `Capabilities` | MUST | Server capability flags |
| `persona` | `string \| null` | MUST | Active persona name, or `null` |

**`Capabilities` shape:**

| Field | Type | Description |
|---|---|---|
| `thinking` | `boolean` | Whether the model supports thinking/reasoning traces |
| `streaming` | `boolean` | Whether the model supports streaming responses |
| `tools` | `string[]` | List of enabled tool names |

### `ag_ui_run_started`

**Provenance:** AG-UI

Emitted when an LLM run begins.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"ag_ui_run_started"` | MUST | Discriminator |
| `run` | `AgUiRunMetadata` | MUST | Run identification |
| `input` | `{ messages: Message[] }` | MAY | Input messages for this run |

### `ag_ui_run_finished`

**Provenance:** AG-UI

Emitted when an LLM run completes.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"ag_ui_run_finished"` | MUST | Discriminator |
| `run` | `AgUiRunMetadata` | MUST | Run identification |

**`AgUiRunMetadata` shape:**

| Field | Type | Required | Description |
|---|---|---|---|
| `threadId` | `string` | MUST | Thread/conversation identifier |
| `runId` | `string` | MUST | Unique run identifier |
| `parentRunId` | `string` | MAY | Parent run ID for nested runs |

---

## Text Events

### `thinking`

**Provenance:** Framework

Emitted when the model produces reasoning/thinking content. MAY be emitted
multiple times as thinking content streams in.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"thinking"` | MUST | Discriminator |
| `content` | `string` | MUST | Thinking/reasoning text content |

### `ag_ui_text_message_start`

**Provenance:** AG-UI

Signals the beginning of a text message from the model.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"ag_ui_text_message_start"` | MUST | Discriminator |
| `messageId` | `string` | MUST | Unique message identifier |
| `role` | `"assistant" \| "user" \| "system"` | MUST | Message role |

### `ag_ui_text_message_content`

**Provenance:** AG-UI

A delta of text content within an open text message. MAY be emitted many times
between a `text_message_start` and `text_message_end`.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"ag_ui_text_message_content"` | MUST | Discriminator |
| `messageId` | `string` | MUST | Message identifier (matches the `start` event) |
| `delta` | `string` | MUST | Incremental text content |

### `ag_ui_text_message_end`

**Provenance:** AG-UI

Signals the end of a text message.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"ag_ui_text_message_end"` | MUST | Discriminator |
| `messageId` | `string` | MUST | Message identifier (matches the `start` event) |

---

## Tool Events

### `ag_ui_tool_call_start`

**Provenance:** AG-UI

Signals the beginning of a tool call.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"ag_ui_tool_call_start"` | MUST | Discriminator |
| `toolCallId` | `string` | MUST | Unique tool call identifier |
| `toolCallName` | `string` | MUST | Name of the tool being called |
| `parentMessageId` | `string` | MAY | ID of the parent assistant message |

### `ag_ui_tool_call_args`

**Provenance:** AG-UI

A delta of tool call arguments (streamed as a JSON string). MAY be emitted
many times between `tool_call_start` and `tool_call_end`.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"ag_ui_tool_call_args"` | MUST | Discriminator |
| `toolCallId` | `string` | MUST | Tool call identifier |
| `delta` | `string` | MUST | Incremental JSON argument fragment |

The concatenation of all `delta` values for a given `toolCallId` MUST produce
a valid JSON string when the tool call ends.

### `ag_ui_tool_call_end`

**Provenance:** AG-UI

Signals the end of a tool call's argument streaming.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"ag_ui_tool_call_end"` | MUST | Discriminator |
| `toolCallId` | `string` | MUST | Tool call identifier |

### `ag_ui_tool_call_result`

**Provenance:** AG-UI

Reports the result of a tool call execution.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"ag_ui_tool_call_result"` | MUST | Discriminator |
| `toolCallId` | `string` | MUST | Tool call identifier |
| `toolCallName` | `string` | MUST | Name of the tool |
| `content` | `string` | MUST | Serialized result content |
| `trace` | `ToolExecutionTrace` | MAY | Execution trace for isomorphic tools |

### `ag_ui_tool_call_error`

**Provenance:** AG-UI

Reports an error during tool call execution.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"ag_ui_tool_call_error"` | MUST | Discriminator |
| `toolCallId` | `string` | MUST | Tool call identifier |
| `toolCallName` | `string` | MUST | Name of the tool |
| `message` | `string` | MUST | Error message |

### `isomorphic_handoff`

**Provenance:** Framework

Emitted when an isomorphic tool's server-side execution completes and the
framework is handing off to the client for client-side execution.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"isomorphic_handoff"` | MUST | Discriminator |
| `callId` | `string` | MUST | Unique tool call identifier |
| `toolName` | `string` | MUST | Name of the isomorphic tool |
| `params` | `unknown` | MUST | Original parameters from the LLM |
| `serverOutput` | `unknown` | MUST | Output from server-side execution |
| `usesHandoff` | `boolean` | MAY | Whether this uses the two-phase handoff pattern |

### `elicit_request`

**Provenance:** Framework

Emitted when a tool requires user input (elicitation) before it can proceed.
The stream pauses until the client responds.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"elicit_request"` | MUST | Discriminator |
| `sessionId` | `string` | MUST | Tool session identifier |
| `callId` | `string` | MUST | Tool call identifier from the LLM |
| `toolName` | `string` | MUST | Name of the tool |
| `elicitId` | `string` | MUST | Unique identifier for this elicitation request |
| `key` | `string` | MUST | Elicitation key (e.g., `"pickFlight"`, `"pickSeat"`) |
| `message` | `string` | MUST | Human-readable message for the user |
| `schema` | `object` | MUST | JSON Schema for the expected response (may contain `x-model-context`) |

### `tool_session_status`

**Provenance:** Framework

Reports a status change for a long-running tool session (e.g., MCP plugin
tools).

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"tool_session_status"` | MUST | Discriminator |
| `sessionId` | `string` | MUST | Tool session identifier |
| `callId` | `string` | MUST | Tool call identifier |
| `toolName` | `string` | MUST | Name of the tool |
| `status` | `string` | MUST | One of: `"running"`, `"awaiting_elicit"`, `"completed"`, `"failed"`, `"aborted"` |

### `tool_session_error`

**Provenance:** Framework

Reports a terminal error in a tool session.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"tool_session_error"` | MUST | Discriminator |
| `sessionId` | `string` | MUST | Tool session identifier |
| `callId` | `string` | MUST | Tool call identifier |
| `error` | `string` | MUST | One of: `"SESSION_NOT_FOUND"`, `"SESSION_ABORTED"`, `"INTERNAL_ERROR"` |
| `message` | `string` | MUST | Human-readable error description |

---

## State Events

### `ag_ui_messages_snapshot`

**Provenance:** AG-UI

A snapshot of the full message history at a point in the run. The server MAY
emit this at any time to synchronize the client's view of the conversation.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"ag_ui_messages_snapshot"` | MUST | Discriminator |
| `run` | `AgUiRunMetadata` | MUST | Run identification |
| `messages` | `Message[]` | MUST | Full message history |

### `ag_ui_state_snapshot`

**Provenance:** AG-UI

A snapshot of custom application state at a point in the run.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"ag_ui_state_snapshot"` | MUST | Discriminator |
| `run` | `AgUiRunMetadata` | MUST | Run identification |
| `state` | `AgUiCustomState` | MUST | Application state snapshot |

**`AgUiCustomState` shape:**

| Field | Type | Required | Description |
|---|---|---|---|
| `replay` | `ConversationReplayState` | MAY | Replay metadata for durable UI state restoration |
| `pendingClientActions` | `array` | MAY | Pending handoff/elicit actions to restore on replay |

### `ag_ui_checkpoint`

**Provenance:** AG-UI

A consolidated checkpoint containing both messages and state snapshots. This
is the preferred event for durable replay and state restoration.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"ag_ui_checkpoint"` | MUST | Discriminator |
| `checkpoint` | `AgUiCheckpoint` | MUST | Checkpoint data |

**`AgUiCheckpoint` shape:**

| Field | Type | Required | Description |
|---|---|---|---|
| `run` | `AgUiRunMetadata` | MUST | Run identification |
| `messages` | `AgUiMessagesSnapshot` | MUST | Message history snapshot |
| `state` | `AgUiStateSnapshot` | MUST | Application state snapshot |

**`AgUiStateSnapshot` shape:**

| Field | Type | Required | Description |
|---|---|---|---|
| `assistantContent` | `string` | MUST | Text content generated by the assistant |
| `toolCalls` | `ToolCallInfo[]` | MUST | Tool calls made during this turn |
| `serverToolResults` | `ServerToolResult[]` | MUST | Results from server-side tool execution |
| `replay` | `ConversationReplayState` | MAY | Replay metadata |

---

## Error Events

### `error`

**Provenance:** Framework

Reports a protocol or runtime error. This is an in-band error — it is
delivered as a regular frame in the NDJSON stream.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"error"` | MUST | Discriminator |
| `message` | `string` | MUST | Human-readable error description |
| `recoverable` | `boolean` | MUST | Whether the stream can continue after this error |

When `recoverable` is `false`, the producer MUST close the stream after
emitting this event. When `recoverable` is `true`, the stream MAY continue
with subsequent events.

---

## Event Ordering Constraints

Within a session, the following ordering invariants MUST hold:

### Text message lifecycle

```
ag_ui_text_message_start
  └─► ag_ui_text_message_content  (zero or more)
        └─► ag_ui_text_message_end
```

A `text_message_content` event MUST NOT appear without a preceding
`text_message_start` with the same `messageId`. A `text_message_end` event
MUST appear exactly once for each `text_message_start`.

### Tool call lifecycle

```
ag_ui_tool_call_start
  └─► ag_ui_tool_call_args  (zero or more)
        └─► ag_ui_tool_call_end
              └─► ag_ui_tool_call_result | ag_ui_tool_call_error  (exactly one)
```

A `tool_call_args` event MUST NOT appear without a preceding
`tool_call_start` with the same `toolCallId`. A `tool_call_end` MUST appear
exactly once per `tool_call_start`. Either `tool_call_result` or
`tool_call_error` MUST appear exactly once after `tool_call_end` for the same
`toolCallId`.

### Run lifecycle

```
ag_ui_run_started
  └─► (text events, tool events, state events, interleaved)
        └─► ag_ui_run_finished
```

`ag_ui_run_started` MUST precede all other AG-UI events in a run.
`ag_ui_run_finished` MUST be the last AG-UI event in a run.

### Framework events

`session_info` SHOULD be the first event in the stream (before
`ag_ui_run_started`). `error` events MAY appear at any point.

---

## References

- [Durable Stream Protocol](./durable-stream-protocol.md) — parent specification
- Source of truth: `packages/framework/src/lib/chat/session/streaming.ts`
