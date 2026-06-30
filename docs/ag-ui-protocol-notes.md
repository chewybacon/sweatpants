# AG-UI Protocol Notes

## Strict public event contract

New public durable chat runs emit AG-UI `BaseEvent` JSON objects using standard uppercase event types such as `RUN_STARTED`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `TOOL_CALL_RESULT`, `MESSAGES_SNAPSHOT`, `STATE_SNAPSHOT`, `ACTIVITY_SNAPSHOT`, `RUN_FINISHED`, and `RUN_ERROR`.

Legacy lowercase Sweatpants frames (`ag_ui_*`, `elicit_request`, `ag_ui_checkpoint`, `conversation_state`) are compatibility-reader concepts only and must not be produced by strict public streams for new sessions.

## Request and resume shape

Public clients start or resume runs with a `RunAgentInput`-compatible JSON body:

```json
{
  "threadId": "conversation-1",
  "runId": "run-2",
  "parentRunId": "run-1",
  "state": {},
  "messages": [],
  "tools": [],
  "context": [],
  "resume": [
    {
      "interruptId": "elicit-pick-flight-1",
      "status": "resolved",
      "payload": { "action": "accept", "content": { "flightId": "FL001" } }
    }
  ],
  "forwardedProps": {
    "sweatpants": {
      "clientReplayTraces": {
        "elicit-pick-flight-1": {
          "version": 1,
          "startedAt": 1730000000000,
          "completedAt": 1730000000100,
          "emissions": []
        }
      }
    }
  }
}
```

`resume[].payload` is business response data only. Framework replay metadata belongs under `forwardedProps.sweatpants.clientReplayTraces[interruptId]`.

## Elicitation

Plugin/user input pauses are represented by terminal `RUN_FINISHED` events with interrupt outcomes:

```json
{
  "type": "RUN_FINISHED",
  "threadId": "conversation-1",
  "runId": "run-1",
  "outcome": {
    "type": "interrupt",
    "interrupts": [
      {
        "id": "elicit-pick-flight-1",
        "reason": "input_required",
        "message": "Pick a flight",
        "toolCallId": "call-1",
        "responseSchema": { "type": "object" },
        "metadata": {
          "sweatpants/sessionId": "call-1",
          "sweatpants/toolName": "bookFlight",
          "sweatpants/key": "pickFlight",
          "sweatpants/componentMode": "plugin-render"
        }
      }
    ]
  }
}
```

Accept and decline are sent as `status: "resolved"` with `{ action: "accept", content }` or `{ action: "decline" }`. Cancel is sent as `status: "cancelled"` without a business payload.

## Plugin replay activity

Completed browser-rendered plugin UI is projected as AG-UI activity data:

```json
{
  "type": "ACTIVITY_SNAPSHOT",
  "messageId": "sweatpants:plugin-replay:call-1",
  "activityType": "sweatpants:plugin-replay",
  "replace": true,
  "content": {
    "version": 1,
    "toolCallId": "call-1",
    "toolName": "bookFlight",
    "trace": {
      "version": 1,
      "startedAt": 1730000000000,
      "completedAt": 1730000000100,
      "emissions": [
        {
          "order": 0,
          "emissionId": "elicit-pick-flight-1-em-1",
          "sourceInterruptId": "elicit-pick-flight-1",
          "componentKey": "FlightList",
          "props": {},
          "response": { "flightId": "FL001" },
          "timestamp": 1730000000050
        }
      ]
    }
  }
}
```

One activity message is used per tool call. Repeated snapshots use the same `messageId` and `replace: true` so retries update the canonical activity instead of appending duplicates.

## Trace safety and limits

Replay traces are untrusted browser metadata. The framework validates and normalizes them before serialization and again before server projection.

Limits:

- maximum 32 emissions per incoming interrupt trace
- maximum 128 merged emissions per tool call
- maximum JSON depth 20
- maximum serialized incoming trace size 64 KiB
- maximum serialized merged per-call activity content size 256 KiB

Trace `props` and `response` values must be JSON-safe. Circular values, `BigInt`, functions, symbols, non-finite numbers, unsupported object instances, over-depth data, and oversized traces are omitted from replay metadata; the resume itself continues when the business payload is valid.

## Persistence and privacy

Accepted replay trace props and responses may be persisted in durable history as `ACTIVITY_SNAPSHOT` content. The framework performs shape/size validation, not semantic PII redaction. Plugin authors should keep replay props compact and avoid including sensitive data unless durable replay persistence is intended.

## Ordering

The emissions array order is the canonical replay order. `order` is derived from array position after normalization/merge. `timestamp` is client wall-clock display/debug metadata only and is never used as a replay ordering key.

## Transport purity

Public AG-UI SSE `data:` blocks contain only AG-UI event JSON. Durable cursor metadata is carried out-of-band via headers or SSE `id:` fields, not separate JSON control data frames.
