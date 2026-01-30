# Execution Trace: book_flight

A line-by-line trace of what happens when a user books a flight. Follow along with the code references.

---

## Setup

**User message:** "Book me a flight to Tokyo next Tuesday"

**Tool definition:**
```typescript
const bookFlightTool = createMcpTool('book_flight')
  .description('Book a flight for the user')
  .parameters(z.object({
    destination: z.string(),
    date: z.string(),
  }))
  .elicits({
    pickFlight: {
      response: z.object({ flightId: z.string() }),
      context: z.object({ flights: z.array(FlightSchema) }),
    },
    pickSeat: {
      response: z.object({ row: z.number(), seat: z.string() }),
      context: z.object({ seatMap: SeatMapSchema }),
    },
  })
  .handoff({
    *before(params, ctx) {
      // Validate and prepare
      return { validated: true, ...params }
    },
    *client(handoff, ctx) {
      // Search for flights
      const searchResult = yield* ctx.sample({
        prompt: `Find flights to ${handoff.destination} on ${handoff.date}`,
      })
      const flights = parseFlights(searchResult.text)
      
      // First elicit: pick a flight
      const flightResult = yield* ctx.elicit('pickFlight', {
        message: 'Select your flight',
        flights,
      })
      if (flightResult.action !== 'accept') {
        return { cancelled: true }
      }
      
      // Second elicit: pick a seat
      const seatMap = getSeatMap(flightResult.content.flightId)
      const seatResult = yield* ctx.elicit('pickSeat', {
        message: 'Select your seat',
        seatMap,
      })
      if (seatResult.action !== 'accept') {
        return { cancelled: true }
      }
      
      return {
        flightId: flightResult.content.flightId,
        seat: `${seatResult.content.row}${seatResult.content.seat}`,
      }
    },
    *after(handoff, clientResult, ctx) {
      if (clientResult.cancelled) {
        return { status: 'cancelled' }
      }
      return {
        status: 'booked',
        confirmation: generateConfirmation(),
        ...clientResult,
      }
    },
  })
```

---

## Request 1: User Sends Message

### Step 1.1: HTTP Request Arrives

```
POST /api/chat
X-Session-Id: sess_abc123
Content-Type: application/json

{
  "messages": [
    {"role": "user", "content": "Book me a flight to Tokyo next Tuesday"}
  ]
}
```

### Step 1.2: Handler Processes Request

**File:** [`handler.ts#L200-L280`](../src/handler/durable/handler.ts#L200-L280)

```typescript
// Handler extracts protocol params
const { sessionId, lastLSN } = durableParamsBinder.bind(
  createBindingSource(request)
)
// sessionId = "sess_abc123", lastLSN = 0

// Get or create session
const session = yield* sessionRegistry.getOrCreate(sessionId, {
  // ... config
})
```

### Step 1.3: Chat Engine Created

**File:** [`chat-engine.ts#L429-L479`](../src/handler/durable/chat-engine.ts#L429-L479)

```typescript
const engine = createChatEngine({
  messages: [{ role: 'user', content: 'Book me a flight...' }],
  toolSchemas: [...],
  toolRegistry,
  pluginSessionManager,
  mcpToolRegistry,
  provider,
  // ...
})
```

### Step 1.4: Engine Phase: `init`

**File:** [`chat-engine.ts#L527-L553`](../src/handler/durable/chat-engine.ts#L527-L553)

```typescript
case 'init': {
  // Emit session info
  if (sessionInfo) {
    state.phase = 'start_iteration'
    return { done: false, value: sessionInfo }
  }
  // ...
}
```

**Event emitted:**
```json
{"lsn": 1, "event": {"type": "session_info", "capabilities": {...}}}
```

### Step 1.5: Engine Phase: `start_iteration`

**File:** [`chat-engine.ts#L803-L817`](../src/handler/durable/chat-engine.ts#L803-L817)

```typescript
case 'start_iteration': {
  state.iteration++  // iteration = 1
  
  // Start streaming from provider (LLM)
  const providerStream = provider.stream(state.conversationMessages, combinedTools)
  state.providerSubscription = yield* providerStream
  state.phase = 'streaming_provider'
  return yield* this.next()
}
```

### Step 1.6: Engine Phase: `streaming_provider`

**File:** [`chat-engine.ts#L819-L843`](../src/handler/durable/chat-engine.ts#L819-L843)

LLM streams response. It decides to call `book_flight`:

```typescript
case 'streaming_provider': {
  const result = yield* state.providerSubscription.next()
  
  if (result.done) {
    // Provider finished
    state.providerResult = result.value
    state.phase = 'provider_complete'
    return yield* this.next()
  }
  
  // Convert and emit streaming events
  const streamEvent = providerEventToStreamEvent(result.value)
  if (streamEvent) {
    return { done: false, value: streamEvent }
  }
}
```

**Events emitted:**
```json
{"lsn": 2, "event": {"type": "text", "content": "I'll help you book"}}
{"lsn": 3, "event": {"type": "text", "content": " a flight to Tokyo."}}
{"lsn": 4, "event": {"type": "tool_calls", "calls": [{"id": "call_xyz789", "name": "book_flight", "arguments": {"destination": "Tokyo", "date": "next Tuesday"}}]}}
```

### Step 1.7: Engine Phase: `provider_complete`

**File:** [`chat-engine.ts#L845-L877`](../src/handler/durable/chat-engine.ts#L845-L877)

```typescript
case 'provider_complete': {
  const result = state.providerResult
  
  if (result.toolCalls && result.toolCalls.length > 0) {
    // Has tool calls - execute them
    state.toolCalls = convertToolCalls(result.toolCalls)
    state.toolResults = []
    state.phase = 'executing_tools'
    return yield* this.next()
  }
  // ...
}
```

### Step 1.8: Engine Phase: `executing_tools`

**File:** [`chat-engine.ts#L879-L1019`](../src/handler/durable/chat-engine.ts#L879-L1019)

```typescript
case 'executing_tools': {
  for (const tc of toolCalls) {
    const toolName = tc.function.name  // "book_flight"
    
    // Check if this is a plugin tool
    const plugin = getPluginForTool(toolName, pluginRegistry)
    const mcpTool = mcpToolRegistry?.get(toolName)
    
    if (plugin && mcpTool && isPluginTool(mcpTool)) {
      // Create a plugin session
      const session = yield* pluginSessionManager.create({
        tool: mcpTool,
        params: tc.function.arguments,
        callId: tc.id,  // "call_xyz789"
        provider,
        signal,
      })
      
      // Track the session
      state.pendingPluginSessions.set(tc.id, {
        callId: tc.id,
        toolName: toolName,
      })
      
      // Wait for first event
      const event = yield* session.nextEvent()
      // ...
    }
  }
}
```

### Step 1.9: PluginSessionManager.create()

**File:** [`plugin-session-manager.ts#L506-L551`](../src/handler/durable/plugin-session-manager.ts#L506-L551)

```typescript
*create(config: CreatePluginSessionConfig): Operation<PluginSession> {
  const { tool, params, callId, provider, signal } = config
  
  // Create the underlying tool session
  const toolSession = yield* registry.create(tool, params, {
    sessionId: callId,  // Use callId as session ID
    signal,
  })
  
  // Create wrapper
  const pluginSession = createPluginSessionWrapper(
    toolSession,
    callId,
    provider,
    // ...
  )
  
  // Track it
  pluginSessions.set(callId, {
    session: pluginSession,
    toolSession,
    provider,
    // ...
  })
  
  return pluginSession
}
```

### Step 1.10: ToolSession Created, BridgeHost Runs

**File:** [`tool-session.ts#L103-L247`](../src/lib/chat/mcp-tools/session/tool-session.ts#L103-L247)

```typescript
export function createToolSession(tool, params, samplingProvider, options) {
  return resource(function* (provide) {
    // Create the bridge host
    const host = createBridgeHost({
      tool,
      params,
      callId: sessionId,
      // ...
    })
    
    // Spawn event processor
    yield* spawn(function* () {
      for (const event of yield* each(host.events)) {
        switch (event.type) {
          case 'elicit':
            // Convert to session event, add to queue
            eventQueue.add(createEvent({
              type: 'elicit_request',
              elicitId,
              key: event.request.key,
              message: event.request.message,
              schema: event.request.schema.json,
            }))
            break
          // ...
        }
      }
    })
    
    // Spawn tool runner
    yield* spawn(function* () {
      const result = yield* host.run()  // 👈 Tool starts executing here
      // ...
    })
  })
}
```

### Step 1.11: BridgeHost.run() Executes Tool

**File:** [`bridge-runtime.ts#L1203-L1286`](../src/lib/chat/mcp-tools/bridge-runtime.ts#L1203-L1286)

```typescript
run(): Operation<TResult> {
  return {
    *[Symbol.iterator]() {
      // Validate params
      const validatedParams = tool.parameters.parse(params)
      
      if (tool.handoffConfig) {
        // Phase 1: before()
        const handoff = yield* handoffConfig.before(validatedParams, serverCtx)
        // handoff = { validated: true, destination: 'Tokyo', date: 'next Tuesday' }
        
        // Create context for client phase
        const branchCtx = createBridgeContext(initialState)
        
        // Client phase - THIS IS WHERE THE TOOL CODE RUNS
        const clientResult = yield* handoffConfig.client(handoff, branchCtx)
        
        // Phase 2: after() - won't reach this until client phase completes
        result = yield* handoffConfig.after(handoff, clientResult, serverCtx, validatedParams)
      }
    }
  }
}
```

### Step 1.12: Tool Calls ctx.sample()

Inside `*client()`:

```typescript
*client(handoff, ctx) {
  // Search for flights
  const searchResult = yield* ctx.sample({
    prompt: `Find flights to ${handoff.destination} on ${handoff.date}`,
  })
  // ...
}
```

**File:** [`bridge-runtime.ts#L449-L610`](../src/lib/chat/mcp-tools/bridge-runtime.ts#L449-L610)

```typescript
sample: ((config: McpToolSampleConfig) => {
  return {
    *[Symbol.iterator]() {
      // Build messages
      const userMessage = { role: 'user', content: config.prompt }
      messages = [...state.messages, userMessage]
      
      // Create a signal for the response
      const responseSignal = createSignal<SampleResponse, void>()
      
      // Emit sample event
      yield* state.eventChannel.send({
        type: 'sample',
        messages,
        responseSignal,
      })
      
      // Wait for response via signal
      const subscription = yield* responseSignal
      const next = yield* subscription.next()  // Blocks until response
      const result = next.value.result
      
      return result
    }
  }
})
```

The `sample_request` event is handled by PluginSessionManager (server-side):

**File:** [`plugin-session-manager.ts#L336-L448`](../src/handler/durable/plugin-session-manager.ts#L336-L448)

```typescript
case 'sample_request': {
  // Handle sampling server-side using the provider
  const stream = provider.stream(chatMessages, streamOptions)
  const subscription = yield* stream
  
  // Collect response
  let fullText = ''
  // ... iterate subscription ...
  
  // Send response back to tool session
  yield* toolSession.respondToSample(sampleEvent.sampleId, result)
}
```

The tool continues after sample returns.

### Step 1.13: Tool Calls ctx.elicit() - SUSPENSION POINT

```typescript
*client(handoff, ctx) {
  // ... after sample ...
  
  // First elicit: pick a flight
  const flightResult = yield* ctx.elicit('pickFlight', {
    message: 'Select your flight',
    flights,
  })
  // 👆 TOOL SUSPENDS HERE
}
```

**File:** [`bridge-runtime.ts#L897-L1047`](../src/lib/chat/mcp-tools/bridge-runtime.ts#L897-L1047)

```typescript
elicit(key, options) {
  return {
    *[Symbol.iterator]() {
      // Build the request
      const request = {
        id: { toolName: state.toolName, key, callId: state.callId, seq },
        key,
        message: encodedMessage,
        schema: { zod: responseSchema, json: encodedSchema },
      }
      
      // Create a signal for the response
      const responseSignal = createSignal<ElicitResponse, void>()
      
      // Emit the elicit event
      yield* state.eventChannel.send({ type: 'elicit', request, responseSignal })
      
      // Wait for response via signal
      const subscription = yield* responseSignal
      const next = yield* subscription.next()  // 👈 SUSPENDS HERE
      
      // ... won't reach here until signal fires ...
    }
  }
}
```

### Step 1.14: Elicit Event Flows to Engine

Back in `session.nextEvent()`:

**File:** [`plugin-session-manager.ts#L297-L333`](../src/handler/durable/plugin-session-manager.ts#L297-L333)

```typescript
*nextEvent(): Operation<PluginSessionEvent | null> {
  // Pull next event from queue
  const result = yield* eventSubscription.next()
  const event = result.value
  
  switch (event.type) {
    case 'elicit_request':
      // Pass through to caller (chat engine)
      return {
        type: 'elicit_request',
        elicitId: event.elicitId,
        key: event.key,
        message: event.message,
        schema: event.schema,
      }
    // ...
  }
}
```

### Step 1.15: Engine Receives elicit_request

Back in `executing_tools`:

```typescript
const event = yield* session.nextEvent()

if (event.type === 'elicit_request') {
  // Tool needs elicitation
  const result: ToolExecutionResult = {
    ok: true,
    kind: 'plugin_awaiting',
    callId: tc.id,
    toolName,
    sessionId: session.id,
    elicitRequest: {
      sessionId: session.id,
      callId: tc.id,
      toolName,
      elicitId: event.elicitId,
      key: event.key,
      message: event.message,
      schema: event.schema,
    },
  }
  results.push(result)
}
```

### Step 1.16: Engine Phase: `tools_complete` → `awaiting_elicit`

**File:** [`chat-engine.ts#L1021-L1073`](../src/handler/durable/chat-engine.ts#L1021-L1073)

```typescript
case 'tools_complete': {
  // Check for plugin tools awaiting elicitation
  const pluginAwaitingResults = results.filter(r => r.ok && r.kind === 'plugin_awaiting')
  
  if (pluginAwaitingResults.length > 0) {
    // Add assistant message to conversation
    state.conversationMessages.push({
      role: 'assistant',
      content: providerResult.text,
      tool_calls: [...],
    })
    
    // Emit elicit events
    for (const r of pluginAwaitingResults) {
      state.pendingEvents.push({
        type: 'elicit_request',
        sessionId: r.sessionId,
        callId: r.callId,
        toolName: r.toolName,
        elicitId: r.elicitRequest.elicitId,
        key: r.elicitRequest.key,
        message: r.elicitRequest.message,
        schema: r.elicitRequest.schema,
      })
      state.awaitingElicitResult = r
    }
    
    state.phase = 'awaiting_elicit'
    return { done: false, value: state.pendingEvents.shift()! }
  }
}
```

**Event emitted:**
```json
{
  "lsn": 5,
  "event": {
    "type": "elicit_request",
    "sessionId": "call_xyz789",
    "callId": "call_xyz789",
    "toolName": "book_flight",
    "elicitId": "call_xyz789:elicit:1",
    "key": "pickFlight",
    "message": "Select your flight",
    "schema": {"type": "object", "x-elicit-context": {"flights": [...]}}
  }
}
```

### Step 1.17: Engine Phase: `awaiting_elicit` → `handoff_pending`

**File:** [`chat-engine.ts#L1169-L1241`](../src/handler/durable/chat-engine.ts#L1169-L1241)

```typescript
case 'awaiting_elicit': {
  // Emit conversation state for client
  const conversationState: StreamEvent = {
    type: 'conversation_state',
    conversationState: {
      messages: state.conversationMessages,
      assistantContent: providerResult?.text ?? '',
      toolCalls: [...],
      serverToolResults: [...],
    },
  }
  
  state.pendingEvents.push(conversationState)
  state.phase = 'handoff_pending'
}
```

**Event emitted:**
```json
{"lsn": 6, "event": {"type": "conversation_state", "conversationState": {...}}}
```

### Step 1.18: Engine Phase: `handoff_pending` → `done`

```typescript
case 'handoff_pending': {
  state.phase = 'done'
  return { done: true, value: undefined }
}
```

**HTTP Response ends.** Tool is suspended waiting for user input.

---

## Client Receives Events and Renders UI

### Step 2.1: useChatSession Parses Events

**File:** [`useChatSession.ts`](../src/react/chat/useChatSession.ts)

React receives the NDJSON stream and converts events to patches → state.

### Step 2.2: useElicitExecutor Sees Pending Elicit

**File:** [`useElicitExecutor.ts`](../src/react/chat/useElicitExecutor.ts)

```typescript
useEffect(() => {
  for (const elicit of pendingElicits) {
    const handler = plugin.handlers[elicit.key]  // 'pickFlight'
    
    // Execute handler
    const result = yield* handler(elicit, ctx)
    
    // When done, send response
    sendElicitResponse(result)
  }
}, [pendingElicits])
```

### Step 2.3: Plugin Handler Renders FlightPicker

```typescript
pickFlight: function* (req, ctx) {
  const context = getElicitContext<PickFlightContext>(req)
  
  const result = yield* ctx.render(FlightPicker, {
    flights: context.flights,
    onSelect: (selected) => { /* resolve */ }
  })
  
  return { action: 'accept', content: result }
}
```

**User sees the FlightPicker UI component.**

---

## Request 2: User Selects Flight

### Step 3.1: User Clicks "JL-401"

The `onSelect` callback fires, `ctx.render()` resolves:

```typescript
const result = { flightId: 'JL-401' }
return { action: 'accept', content: result }
```

### Step 3.2: HTTP Request with Elicit Response

```
POST /api/chat
X-Session-Id: sess_abc123
X-Last-LSN: 6
Content-Type: application/json

{
  "messages": [...],
  "elicitResponses": [{
    "sessionId": "call_xyz789",
    "callId": "call_xyz789",
    "elicitId": "call_xyz789:elicit:1",
    "result": {
      "action": "accept",
      "content": {"flightId": "JL-401"}
    }
  }]
}
```

### Step 3.3: New Engine Created

```typescript
const engine = createChatEngine({
  // ...
  elicitResponses: [{
    sessionId: 'call_xyz789',
    elicitId: 'call_xyz789:elicit:1',
    result: { action: 'accept', content: { flightId: 'JL-401' } },
  }],
})
```

### Step 3.4: Engine Phase: `init` → `process_plugin_responses`

```typescript
case 'init': {
  if (elicitResponses && elicitResponses.length > 0) {
    state.phase = 'process_plugin_responses'
  }
}
```

### Step 3.5: Engine Phase: `process_plugin_responses`

**File:** [`chat-engine.ts#L600-L765`](../src/handler/durable/chat-engine.ts#L600-L765)

```typescript
case 'process_plugin_responses': {
  for (const response of elicitResponses) {
    const { sessionId, callId, elicitId, result } = response
    
    // Look up the session (with provider for recovery)
    const session = yield* pluginSessionManager.get(sessionId, provider)
    
    if (!session) {
      // Session lost - emit error
      state.pendingEvents.push({
        type: 'tool_session_error',
        sessionId,
        callId,
        error: 'SESSION_NOT_FOUND',
        message: 'Plugin session was lost.',
      })
      continue
    }
    
    // Send the elicit response to the session
    yield* session.respondToElicit(elicitId, result)
    
    // Wait for the next event from the session
    const nextEvent = yield* session.nextEvent()
    // ...
  }
}
```

### Step 3.6: session.respondToElicit() Resumes Tool

**File:** [`tool-session.ts#L274-L292`](../src/lib/chat/mcp-tools/session/tool-session.ts#L274-L292)

```typescript
*respondToElicit(elicitId: string, response: RawElicitResult<unknown>): Operation<void> {
  const pending = state.pendingElicit
  
  // Send response via the bridge's signal
  state.pendingElicit = null
  state.status = 'running'
  pending.signal.send({ id: pending.elicitRequestId, result: response })
  // 👆 This unblocks the tool generator!
}
```

### Step 3.7: Tool Resumes, Calls Second Elicit

Back in the tool's `*client()`:

```typescript
*client(handoff, ctx) {
  // ... sample completed earlier ...
  
  const flightResult = yield* ctx.elicit('pickFlight', {...})
  // 👆 This just returned! flightResult = { action: 'accept', content: { flightId: 'JL-401' } }
  
  // Continue to second elicit
  const seatMap = getSeatMap(flightResult.content.flightId)
  const seatResult = yield* ctx.elicit('pickSeat', {
    message: 'Select your seat',
    seatMap,
  })
  // 👆 TOOL SUSPENDS AGAIN
}
```

### Step 3.8: Second Elicit Event

Back in `process_plugin_responses`:

```typescript
const nextEvent = yield* session.nextEvent()

switch (nextEvent.type) {
  case 'elicit_request': {
    // Another elicitation needed
    state.pendingEvents.push({
      type: 'elicit_request',
      sessionId,
      callId,
      toolName: session.toolName,
      elicitId: nextEvent.elicitId,
      key: nextEvent.key,  // 'pickSeat'
      message: nextEvent.message,
      schema: nextEvent.schema,
    })
    state.awaitingElicitResult = { ... }
    break
  }
}
```

### Step 3.9: Flow Repeats

Engine transitions to `awaiting_elicit` again, emits events, HTTP response ends.

**Events emitted:**
```json
{"lsn": 7, "event": {"type": "elicit_request", "key": "pickSeat", ...}}
{"lsn": 8, "event": {"type": "conversation_state", ...}}
```

---

## Request 3: User Selects Seat

Same flow:
1. User clicks seat "12A"
2. POST with `elicitResponses`
3. Engine resumes session
4. Tool continues, returns result
5. Engine emits `tool_result`
6. Engine continues to LLM
7. LLM responds with confirmation

**Final events:**
```json
{"lsn": 9, "event": {"type": "tool_result", "id": "call_xyz789", "name": "book_flight", "content": "{\"status\":\"booked\",\"confirmation\":\"ABC123\"}"}}
{"lsn": 10, "event": {"type": "text", "content": "Your flight is booked!"}}
{"lsn": 11, "event": {"type": "complete", "text": "Your flight is booked! Confirmation: ABC123"}}
```

---

## Summary

| Request | Events | Tool State |
|---------|--------|------------|
| 1 | session_info, text, tool_calls, elicit_request (pickFlight), conversation_state | Suspended at first elicit |
| 2 | elicit_request (pickSeat), conversation_state | Suspended at second elicit |
| 3 | tool_result, text, complete | Completed |

**Total:** 3 HTTP requests to complete one `book_flight` tool execution.

---

## Key Takeaways

1. **Generator state persists** across requests in the `BridgeHost`
2. **Signals** connect the suspended generator to the resume path
3. **Session ID = tool_call.id** enables correlation
4. **LSN** enables replay and reconnection
5. **Events flow**: Tool → BridgeHost → ToolSession → PluginSession → Engine → Handler → React
