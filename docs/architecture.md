# Sweatpants Architecture

This document describes the architecture for Sweatpants, an agent framework built on Effection's structured concurrency primitives.

## Overview

Sweatpants provides a composable, middleware-driven architecture for building AI agents. The design emphasizes:

- **Structured concurrency**: All operations are coroutines with predictable lifecycle management
- **Protocol-based communication**: Declaration separate from implementation enables environment-agnostic code
- **Middleware at every level**: Intercept and transform any operation at any scope
- **Context-driven resolution**: Configuration and implementations flow down the coroutine hierarchy

## Foundation: Effection Structured Concurrency

The architecture is built on Effection's structured concurrency model:

- **Coroutines** (`function*` / `yield*`) as the execution primitive
- **Scopes** form a hierarchy (parent → child relationships)
- **Context** flows down the scope tree, can be overridden at any level
- **Resources** are bound to scope lifetime (automatic cleanup)

## Composition Hierarchy

The system has three levels of composition:

```
Program
  └── Agents (coroutines with tools, stateful or stateless)
        └── Tools (operations that use core primitives)
```

### Program Level

The program is the entry point. It sets root context, loads configuration, starts the server, and instantiates agents.

```ts
import { main } from "effection";
import { createServer, useConfig, useModel } from "@sweatpants/core";
import { Chat } from "./agents/chat";

await main(function* () {
  const config = yield* useConfig();

  const server = createServer({
    host: config.server.host,
    port: config.server.port,
  });

  yield* useModel(config.defaults.provider, config.defaults.model);

  const agent = yield* Chat;

  server.use("/chat", agent);

  yield* server;
});
```

### Agent Level

Each agent has a role defined by the tools it exposes. Agents can be stateful (maintain resources, accumulate state) or stateless (pure transformations).

```ts
const Chat = createAgent({
  bookFlight: createTool("book-flight")
    .description("Search for a flight and book it")
    .parameter(z.string().describe("Description of a trip"))
    .execute(function* (trip) {
      // Agent implementation
    }),
});
```

**Agent instantiation:**

- **Explicit**: `yield* Agent` — starts the coroutine, binds resources, puts instance in context
- **Implicit**: Call `Agent.tools.method()` — resolves agent from context (suitable for stateless agents)

**Agent identity is context-dependent**: The same code (`Flight.tools.search`) can talk to different agent instances based on what's in the coroutine context. Parent coroutines can override agent instances for their children.

### Tool Level

Tools are operations that use core primitives and can call other agents' tools.

```ts
const Chat = createAgent({
  bookFlight: createTool("book-flight")
    .execute(function* (trip) {
      // Use core primitives
      const summary = yield* sample({ prompt: `...` });
      yield* notify("Processing...", 0.5);

      // Call another agent's tool
      const result = yield* Flight.tools.search({
        destination,
        date,
      });

      return Ok(result);
    }),
});
```

Tools can be exported as standalone functions for use in distributed libraries:

```ts
export const { bookFlight } = Chat.tools;
```

## Core Primitives

The core primitives from `@sweatpants/agent` are the building blocks all other tools are built from:

| Primitive | Purpose |
|-----------|---------|
| `sample` | LLM calls with pipeline stages |
| `elicit` | Structured user input |
| `notify` | Progress/status to user |
| `log` | Logging |

### Sample Pipeline

The `sample` primitive is a pipeline with middleware points at each stage:

```
sample.input → sample.output → sample.metadata → sample.confidence
```

| Stage | Purpose | Middleware Use Case |
|-------|---------|---------------------|
| `input` | Prepare/transform prompt | PII filtering, prompt enrichment |
| `output` | Handle raw model response | Retry on invalid format, parse/validate |
| `metadata` | Extract structured data | Control extraction, transform structure |
| `confidence` | Evaluate confidence | Retry if below threshold, escalate |

When middleware at any stage decides to retry, execution returns to `input` and the full pipeline re-runs.

```ts
const result = yield* sample({
  prompt: `Extract destination and date from: ${trip}`,
  maxTokens: 150,
});
// Returns structured data with confidence
```

### Elicit Types

Elicit is a general mechanism for requesting something from the user's environment. Each elicit type has a schema and corresponding implementation.

**Framework-provided elicit types:**

```ts
import { createElicit } from "@sweatpants/agent";

export const locationElicit = createElicit({
  name: "location",
  description: "Request user location from device GPS",
  input: z.object({ accuracy: z.enum(["high", "low"]) }),
  output: z.object({ lat: z.number(), lng: z.number() }),
  actions: ["accept", "denied", "cancel"],
});

export const clipboardReadElicit = createElicit({
  name: "clipboard-read",
  description: "Read text from user clipboard",
  input: z.object({}),
  output: z.object({ text: z.string() }),
  actions: ["accept", "denied", "cancel"],
});

export const clipboardWriteElicit = createElicit({
  name: "clipboard-write",
  description: "Copy text to user clipboard",
  input: z.object({ text: z.string() }),
  output: z.object({ success: z.boolean() }),
  actions: ["accept", "denied"],
});
```

**Custom app-specific elicit types:**

```ts
const flightSelectionElicit = createElicit({
  name: "flight-selection",
  description: "User selects a flight from options",
  input: z.object({
    flights: z.array(FlightSchema),
    message: z.string(),
  }),
  output: z.object({
    flightId: z.string(),
    seat: z.string(),
  }),
});
```

**Elicit return type:**

```ts
type ElicitResult<T> =
  | { action: "accept"; content: T }
  | { action: "decline" }        // user explicitly said no
  | { action: "cancel" }         // user dismissed/closed
  | { action: "denied" }         // permission denied (device APIs)
  | { action: "other"; content: string }; // user went off-script
```

## Protocol System

The protocol system separates declaration from implementation, enabling environment-agnostic method invocation.

### Example: Location Protocol

A Location agent needs to retrieve the user's location. The backend agent doesn't know how to access GPS — that's a frontend capability. The protocol bridges this gap.

**Declaration (shared between backend and frontend):**

```ts
import { createProtocol } from "@sweatpants/core";
import { z } from "zod";

const LocationProtocol = createProtocol({
  getLocation: {
    args: z.object({ accuracy: z.enum(["high", "low"]) }),
    progress: z.object({ status: z.enum(["requesting-permission", "acquiring"]) }),
    returns: z.object({ lat: z.number(), lng: z.number() }),
  },
});
```

**Implementation (frontend — browser environment):**

```ts
import { createImplementation, call } from "@sweatpants/core";

const browserLocation = createImplementation(LocationProtocol, function* () {
  return {
    // send is passed as second argument, typed to the protocol's progress schema
    *getLocation({ accuracy }, send) {
      yield* send({ status: "requesting-permission" });

      const position = yield* call(() =>
        new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: accuracy === "high",
          });
        })
      );

      yield* send({ status: "acquiring" });

      return {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      };
    },
  };
});
```

**Implementation (CLI — prompts user to type location):**

```ts
const cliLocation = createImplementation(LocationProtocol, function* () {
  return {
    *getLocation({ accuracy }) {
      const input = yield* prompt("Enter your location (lat,lng): ");
      const [lat, lng] = input.split(",").map(Number);
      return { lat, lng };
    },
  };
});
```

**Usage in an agent (backend — doesn't know which implementation):**

```ts
const WeatherAgent = createAgent({
  getLocalWeather: createTool("get-local-weather")
    .description("Get weather for user's current location")
    .execute(function* () {
      // Backend calls protocol — transport handles routing to frontend
      const handle = yield* LocationProtocol.attach();
      const location = yield* handle.invoke({
        name: "getLocation",
        args: { accuracy: "low" },
      });

      if (location.action === "denied") {
        return Err(new Error("location_permission_denied"));
      }

      const weather = yield* fetchWeather(location.content);
      return Ok(weather);
    }),
});
```

### Key Properties

- **Methods return `Stream<Progress, Return>`**: Progress events flow during execution, final result closes the stream
- **Same protocol, multiple implementations**: UI chat, CLI, test mock, automated
- **Transport is contextual**: WebSocket, HTTP SSE, in-memory — caller doesn't know or care

### Example: Elicit Across Environments

```
┌─────────────────────────────────────────────────────────────────┐
│                         BACKEND                                 │
│                                                                 │
│   Chat Agent                                                    │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  yield* elicit({                                        │   │
│   │    type: 'form',                                        │   │
│   │    message: "Select a flight",                          │   │
│   │    schema: FlightSelectionSchema                        │   │
│   │  })                                                     │   │
│   └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              │ invoke via protocol              │
│                              ▼                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  Protocol: elicit                                       │   │
│   │  - args: { type, message, schema }                      │   │
│   │  - progress: { status }                                 │   │
│   │  - returns: { action, content }                         │   │
│   └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
└──────────────────────────────│──────────────────────────────────┘
                               │ transport (contextual)
┌──────────────────────────────│──────────────────────────────────┐
│                         FRONTEND                                │
│                              ▼                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  Implementation: elicit (UI Chat)                       │   │
│   │  - Renders flight selection form                        │   │
│   │  - Streams progress: "rendering" → "waiting"            │   │
│   │  - Returns: { action: 'accept', content: { flightId } } │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Middleware System

Middleware can intercept any operation at any level of the scope hierarchy.

### Installation

```ts
yield* api.decorate(
  {
    methodName(args, next) {
      // transform args
      const result = next(...args);
      // transform result
      return result;
    },
  },
  { at: "max" | "min" }
);
```

### Priority: max vs min

- **max**: First to see input (outer scopes outermost)
- **min**: First to see output (inner scopes closest to core)

### Execution Order

```
OUTER SCOPE (max) ────────────────────────────────────────────────────────
  │                                                                     ▲
  ▼                                                                     │
INNER SCOPE (max) ────────────────────────────────────────────────      │
  │                                                              ▲      │
  ▼                                                              │      │
INNER SCOPE (min) ────────────────────────────────────────       │      │
  │                                                      ▲       │      │
  ▼                                                      │       │      │
OUTER SCOPE (min) ────────────────────────────           │       │      │
  │                                          ▲           │       │      │
  ▼                                          │           │       │      │
                      CORE                   └───────────┴───────┴──────┘
```

### Use Cases

**PII filtering (max priority):**

```ts
yield* around(
  {
    *sample([{ prompt, maxTokens }], next) {
      const sanitizedPrompt = redactPII(prompt);
      return yield* next({ prompt: sanitizedPrompt, maxTokens });
    },
  },
  { at: "max" }
);
```

**Confidence checking (min priority):**

```ts
yield* around(
  {
    *sample([args], next) {
      const result = yield* next(args);
      if (result.confidence < 0.8) {
        // retry or escalate
      }
      return result;
    },
  },
  { at: "min" }
);
```

**Scoped configuration:**

```ts
const HttpConfig = Context.create<{ retries: number; timeout: number }>(
  "http-config",
  { retries: 3, timeout: 5000 }
);

// Increase retries for flaky services
yield* HttpConfig.with({ retries: 10, timeout: 15000 }, function* () {
  yield* ExternalServiceAgent.tools.fetchData({ endpoint: "/unstable-api" });
});
```

## Plugin System

Plugins extend agent capabilities through a unified `use` interface.

```ts
yield* agent.use(plugin);
```

- Plugins define extension points
- Agents implement required interfaces for compatibility
- Type safety + runtime validation enforce compatibility

Examples: HTTP routes, MCP exposure, transport bindings.

## Result Handling

The `Ok`/`Err` pattern distinguishes expected outcomes from unexpected failures:

```ts
import { Ok, Err } from "effection";

function* bookFlight(flightId: string) {
  const confirmation = yield* elicit(confirmationElicit);

  if (confirmation.action === "decline") {
    return Err(new Error("user_declined"));
  }

  if (confirmation.action === "cancel") {
    return Err(new Error("user_cancelled"));
  }

  // ... proceed with booking
  return Ok({ bookingId: "..." });
}
```

Callers must handle results explicitly — there's no automatic propagation.

## Agent State Management

### State Encapsulation

State is encapsulated within agents and accessed only through their tools. There is no point-to-point state communication between agents.

### Fork/Forward/Back

Parent agents can manage subagent state through fork/forward/back operations:

- **Fork**: Create a branch of execution with copied state
- **Forward**: Advance state (commit)
- **Back**: Restore to a previous checkpoint

This enables scenarios like "try this approach, if it fails, roll back and try another."

### Side Quests

Users can take tangents mid-conversation without losing context:

```
Main flow                          Side quest
──────────                         ──────────

1. Agent asks about flight
2. User selecting dates
3. yield* elicit(dateSelection)
        │
        │ ◄── User: "Wait, what's the weather in Tokyo?"
        │
        ├─────────────────────────► 4. Fork: new coroutine
        │ (suspended, not lost)        5. Weather agent responds
        │                              6. User: "Ok thanks"
        │                              7. Coroutine completes
        │ ◄────────────────────────────┘
        │
        ▼ (resume exactly here)
4. User completes date selection
5. Agent continues booking
```

**Properties:**

- Coroutine tree, not stack — suspended state preserved
- Auto-return on completion (default behavior)
- Optional explicit navigation for power users
- Serializable state for persistence (architected from start, required by 1.0)

## Elicit Use Cases

### Multiple Agents Sharing Same Elicit

- Single implementation serves all agents
- Requests queue by default; UI controls queue behavior
- Coroutine context provides agent identity for attribution

### Agent Asking User for Input via Chat

- Typed elicit components with schemas
- Calling coroutine suspends; others can continue
- `action: 'other'` for when user goes off-script

### MCP Invoking Tool Which Causes Elicit

- Agent decoupled from invocation source (MCP, HTTP) and elicit target (chat UI, CLI)
- MCP blocks until user completes elicit
- Same tool code works regardless of invocation path

### Device API Access (Location, Clipboard)

- Elicit broader than forms — device capability access
- Permission denial is `{ action: 'denied' }`, not an error
- Framework provides standard elicit types with `createElicit`

### Backend-Authoritative Interactions

- Backend controls state, validation, authorization
- Frontend is presentation layer only
- Example: "Draw a card" — backend picks, frontend reveals

### Compound Elicits (Choice + Type Something)

- Single elicit type = single UI component
- Compound schema handles multiple interaction modes
- Distinct from `action: 'other'` (designed option vs. off-script)

## Testing

Testing is a first-class concern. The context-based resolution enables clean substitution:

```ts
// Inject mock agents
yield* FlightContext.set(mockFlightAgent, function* () {
  // Chat's calls to Flight hit the mock
  yield* Chat.tools.bookFlight(...);
});

// Inject mock elicit implementation
yield* ElicitProtocol.implement(testElicitMock);
```

## Layered Architecture

The system is organized into three layers, each with distinct responsibilities:

```
┌─────────────────────────────────────────────────────────────────┐
│                     STATE MANAGEMENT                            │
│                                                                 │
│  - Conversation history (event sourcing)                        │
│  - Coroutine tree (parent/child messages)                       │
│  - Rewind = return to higher node in tree                       │
│  - Cancel = halt current subtree                                │
│  - Context = history up to current node                         │
│  - Compaction via middleware (summarization)                    │
│  - Reflog for recovery of discarded branches                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        PROTOCOL                                 │
│                                                                 │
│  - Invoke method in another environment                         │
│  - Declaration (schema) / Implementation separation             │
│  - Progress streaming (send)                                    │
│  - Middleware: retry, validation, PII filtering                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       TRANSPORT                                 │
│                                                                 │
│  - Move bytes between environments                              │
│  - Backend-driven request/response                              │
│  - SSE+POST, WebSocket, etc.                                    │
│  - No semantic understanding                                    │
└─────────────────────────────────────────────────────────────────┘
```

## Backend-Driven Communication

Communication between backend and frontend is **backend-driven**. The backend always initiates, the frontend always responds. There is no frontend-initiated communication.

**The loop:**

```
Backend (driver)                    Frontend (reactor)
──────────────────                  ──────────────────

loop {
  decide next action
       │
       ▼
  send message ──────────────────►  receive message
                                    render/execute
                                    wait for user
                                    send response
  receive response  ◄──────────────   
       │
       ▼
  process response
  continue loop
}
```

**Key properties:**

- Backend controls the flow
- Frontend is reactive (receives instructions, sends back results)
- Backend controls asynchrony — when new input arrives while processing, backend decides what to do (queue, interrupt, merge)

**Response interpretation:**

- **Structured response** (user clicked specific UI element) → Backend processes directly
- **Unstructured/text response** (user typed something) → Backend sends to LLM to interpret

The backend doesn't know the nature of user's response until it sends the response to the LLM for interpretation.

## Transport Layer

Transport moves bytes between environments. It has no semantic understanding.

**Interface:**

```ts
// Backend side
interface BackendTransport {
  /**
   * Send a message and get back a stream.
   * Stream yields progress events from frontend, closes with final response.
   */
  send<TRequest, TProgress, TResponse>(message: TRequest): Stream<TProgress, TResponse>;
}

// Frontend side
interface FrontendTransport {
  messages: Stream<BackendMessage, void>;
}

interface BackendMessage<T = unknown> {
  elicitId: string;
  type: string;  // elicit type (e.g., 'location', 'flight-selection')
  payload: T;
  
  /**
   * Send incremental progress back to backend
   */
  progress(data: unknown): Operation<void>;
  
  /**
   * Complete with final response
   */
  respond(data: unknown): Operation<void>;
}

// Message types (over the wire)
type FrontendMessage = 
  | { type: 'progress'; elicitId: string; payload: unknown }
  | { type: 'response'; elicitId: string; payload: unknown }
  | { type: 'cancel' }
  | { type: 'rewind'; toElicitId: string };
```

**Example flow with progress:**

```
Backend                              Frontend
───────                              ────────

send({ type: 'location' }) ────────► receive message

    (backend waiting on stream)      calls geolocation API
                                     
progress({ status: 'requesting' }) ◄─ permission prompt shown
    ▲ (yielded from stream)          
                                     user grants permission
progress({ status: 'acquiring' })  ◄─ GPS acquiring
    ▲ (yielded from stream)
                                     position acquired
response({ lat, lng })             ◄─ final response
    ▲ (stream closes with value)
```

**Transport implementations:**

| Transport | Backend → Frontend | Frontend → Backend |
|-----------|-------------------|-------------------|
| SSE + POST | Server-Sent Events | HTTP POST |
| WebSocket | WebSocket message | WebSocket message |

Transport is swappable — agent code doesn't change when switching from SSE to WebSocket.

## Coroutine Tree Model

Every message in a chat is a coroutine, child of the parent message. The conversation forms a tree, not a linear sequence.

```
[greeting]
    │
    └── [user message 1]
            │
            ├── [elicit: pick flight]
            │       │
            │       └── [response: FL001]
            │               │
            │               └── [elicit: pick seat]
            │                       │
            │                       └── [response: 3A]
            │
            └── [notify: "Booking complete!"]
```

**Operations on the tree:**

| Operation | Meaning |
|-----------|---------|
| **Rewind** | Return to a higher node, continue from there with new input |
| **Cancel** | Halt current node and its children |
| **Fork** | Create a branch (side quest) |

**Context** at any point = path from root to current node.

## State Management: Event Sourcing + Reflog

### Event Sourcing

The conversation history is an append-only log of events. The current state is derived by replaying events from root to current node.

### Compaction via Middleware

Long conversation branches can be compacted (summarized) without destroying history:

```
Before compaction:

[greeting]
    └── [user msg 1]
            └── [elicit: pick flight]
                    └── [response: FL001]
                            └── [elicit: pick seat]
                                    └── [response: 3A]
                                            └── [notify: booked!]
                                                    └── [user msg 2: "weather?"]
                                                            └── (current)

After compaction:

[greeting]
    └── [user msg 1]
            └── [summary: "User booked flight FL001, seat 3A to Tokyo"]  ← compressed
                    └── [user msg 2: "weather?"]
                            └── (current)
```

Compaction is controlled by middleware — different conversations can have different compression strategies.

### Reflog for Recovery

Like git reflog, all states ever reached are preserved. Discarded branches (from rewind, edit, cancel) are recoverable.

```
Main conversation (current HEAD):

[greeting] ── [msg1] ── [summary: booked] ── [msg2: weather?] ── [location]
                                                                     ▲
                                                                   HEAD

Reflog (all states ever reached):

abc123  HEAD@{0}  location elicit
def456  HEAD@{1}  msg2: "what's the weather?"  
789abc  HEAD@{2}  summary created (compacted flight booking)
...
fed321  HEAD@{8}  response: seat 3A        ← still recoverable
cba987  HEAD@{9}  elicit: pick seat
...
```

**Reflog operations:**

- `recover(reflogEntry)` — restore a discarded branch
- `inspect(reflogEntry)` — view without restoring
- `gc()` — clean up old entries (middleware-controlled)

**Benefits:**

- Compaction doesn't destroy history
- Discarded branches are preserved
- Recovery is always possible ("undo my last edit")
- Debugging — inspect how conversation evolved

## User Interrupts

Users can interrupt the current flow:

| Action | Effect |
|--------|--------|
| **Stop/Cancel** | Halt current operation, return to waiting state |
| **Edit previous message** | Rewind to that point in the tree, continue with edited input |
| **Change mind** | May trigger rewind or be interpreted as new input by LLM |

These are **not** transport-level concerns — they are state management operations. The transport just delivers the signal; the state management layer interprets it.

```ts
type FrontendMessage = 
  | { type: 'response'; elicitId: string; payload: unknown }
  | { type: 'cancel' }
  | { type: 'rewind'; toElicitId: string };
```

## Open Areas

The following areas require further design:

- Exact rules for implicit vs explicit agent instantiation
- Plugin extension point interface design
- MCP bidirectional integration (exposing tools + consuming external tools)
- Pipeline stages for `elicit`/`notify`
- Tangent detection (system-level vs agent-level)
- Reflog retention policies and garbage collection
