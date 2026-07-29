# Canonical Tool Execution Trace

This document traces a browser-interactive tool after the canonical tool migration.
Tool authoring lives in `@sweatpants/agent-sdk`; framework plugins bind browser UI to declared elicit keys.

## 1. Authoring

```ts
import { createTool } from '@sweatpants/agent-sdk'
import { makePlugin } from '@sweatpants/framework/chat/mcp-tools'

export const bookFlightTool = createTool('book_flight')
  .description('Book a flight')
  .parameters(BookFlightParams)
  .elicits({ pickFlight, pickSeat })
  .samples()
  .execute(function* (params, ctx) {
    const flights = yield* searchFlights(params)
    const picked = yield* ctx.elicit('pickFlight', {
      message: 'Select a flight',
      context: { flights },
    })

    if (picked.action !== 'accept') return { success: false }

    const seat = yield* ctx.elicit('pickSeat', {
      message: 'Select a seat',
      context: { flight: picked.content.flightId },
    })

    if (seat.action !== 'accept') return { success: false }

    const summary = yield* ctx.sample({
      prompt: `Summarize booking ${picked.content.flightId} seat ${seat.content.seat}`,
    })

    return { success: true, summary: summary.text }
  })

export const bookFlightPlugin = makePlugin(bookFlightTool)
  .onElicit({
    pickFlight: function* (request, ctx) {
      const response = yield* ctx.render(FlightPicker, request.context)
      return { action: 'accept', content: response }
    },
    pickSeat: function* (request, ctx) {
      const response = yield* ctx.render(SeatPicker, request.context)
      return { action: 'accept', content: response }
    },
  })
  .build()
```

## 2. Registration

1. The app registers canonical tools with the framework tool inventory.
2. The app registers plugins for tools that need browser/user input.
3. The provider receives model-safe tool definitions only: names, descriptions, schemas, annotations, and capabilities.
4. Runtime implementation payloads stay in local inventory entries or remote runtime adapters.

## 3. Model Calls A Tool

1. The model emits a tool call with JSON arguments.
2. The framework validates arguments against the canonical tool schema.
3. The selected runtime starts a tool session.
4. The tool session executes the canonical `execute` generator.

## 4. Tool Requests User Input

1. Tool code calls `ctx.elicit(key, request)`.
2. The runtime emits a canonical elicit request event containing:
   - tool call id,
   - tool name,
   - elicit id,
   - elicit key,
   - message,
   - JSON Schema,
   - optional typed context payload.
3. The React chat client routes the request to the matching plugin handler.
4. The plugin handler renders UI through browser rendering primitives.
5. The user's accept/decline/cancel response resumes the same tool session.

## 5. Tool Requests Model Sampling

1. Tool code calls `ctx.sample(...)`.
2. The runtime emits a sample request to the configured sampling provider.
3. The sample response resumes tool execution.
4. Sampling behavior is identical for local, MCP, and AgentCore adapters when the runtime supports it.

## 6. Completion and Replay

1. Tool completion emits a canonical result event.
2. The durable stream stores events with LSN ordering.
3. Rendered UI emissions are stored with the elicit trace.
4. Reconnecting clients replay completed render traces without re-running tool code.

## 7. Final Mental Model

There is one first-party tool authoring model:

- `createTool(...)` defines what the model can call and what interactions the tool may request.
- `ctx.elicit(...)` pauses for user/browser input.
- `ctx.sample(...)` pauses for model input.
- `makePlugin(tool).onElicit(...)` binds browser UI to declared elicit keys.
- Runtime adapters decide where and how a canonical tool session executes.
