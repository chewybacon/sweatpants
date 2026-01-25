# Protocol Layer Plan

## Goal

Make each tool that's passed into `createAgent` invoke a protocol method and send the payload over its appropriate transport. The entire tool invocation should be wrappable in middleware.

## Key Insight

We will use `createApi` from `effection/experimental` directly. This gives us:
- Middleware support via `.decorate()` (we'll expose as `.around()`)
- Scoped middleware that inherits down the Effection scope tree
- Operations that are yieldable

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     TOOL / AGENT                                │
│                                                                 │
│  Standalone Tool = Single-function API                          │
│  Agent = Multi-function API (one per tool)                      │
│                              │                                  │
│                              ▼                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  createApi (from effection/experimental)                │   │
│   │  - Provides middleware via .decorate()                  │   │
│   │  - Scoped to Effection scope                            │   │
│   └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              ▼                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  IMPL (innermost handler)                               │   │
│   │  - Local impl: runs provided function                   │   │
│   │  - No impl: routes to transport                         │   │
│   └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              ▼                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  TRANSPORT (already built)                              │   │
│   │  - CorrelatedTransport.request()                        │   │
│   │  - Returns Stream<Progress, Response>                   │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## API Design

### Standalone Tool (Single-function API)

**Tool with impl in config:**

```ts
const Search = createTool({
  name: "search",
  description: "Search for flights by destination and date",
  input: z.object({ destination: z.string(), date: z.string() }),
  progress: z.object({ status: z.string() }),
  output: z.object({ flight: FlightSchema }),
  impl: function* ({ destination, date }, send) {
    yield* send({ status: "searching" });
    const flights = yield* searchFlights({ destination, date });
    return { flight: selectedFlight };
  },
});

// Call to activate - no args needed when impl is in config
const search = yield* Search();

// Invoke
const result = yield* search({ destination: "Tokyo", date: "2024-01-15" });

// Override behavior via middleware (not by passing impl)
yield* Search.around(function* (args, next) {
  console.log("before search");
  const result = yield* next(...args);
  console.log("after search");
  return result;
});
```

**Tool without impl (call with impl to activate - same environment):**

```ts
const GetLocation = createTool({
  name: "get-location",
  description: "Get the user's current geographic location",
  input: z.object({ accuracy: z.enum(["high", "low"]) }),
  progress: z.object({ status: z.string() }),
  output: z.object({ lat: z.number(), lng: z.number() }),
});

// GetLocation is a function - call with impl to get Operation
const getLocation = yield* GetLocation(function* ({ accuracy }, send) {
  yield* send({ status: "requesting-permission" });
  const pos = yield* getGPSPosition(accuracy);
  return { lat: pos.lat, lng: pos.lng };
});

// Invoke
const location = yield* getLocation({ accuracy: "high" });

// Middleware
yield* GetLocation.around(function* (args, next) {
  return yield* next(...args);
});
```

**Tool without impl (Principal invokes, Operative fulfills over transport):**

```ts
// ═══════════════════════════════════════════════════════════════════════════
// SHARED: Tool definition (used by both Principal and Operative)
// ═══════════════════════════════════════════════════════════════════════════

const GetLocation = createTool({
  name: "get-location",
  description: "Get the user's current geographic location",
  input: z.object({ accuracy: z.enum(["high", "low"]) }),
  progress: z.object({ status: z.string() }),
  output: z.object({ lat: z.number(), lng: z.number() }),
});

// ═══════════════════════════════════════════════════════════════════════════
// PRINCIPAL SIDE: Invokes tool (routes to transport, no local impl)
// ═══════════════════════════════════════════════════════════════════════════

function* principalMain() {
  // Set up transport to Operative
  yield* TransportContext.set(transport);
  
  // Activate tool WITHOUT providing impl - will route to transport
  const getLocation = yield* GetLocation();
  
  // Invoke - this sends TransportRequest to Operative, waits for response
  const location = yield* getLocation({ accuracy: "high" });
  
  // Use the result
  console.log(`User is at ${location.lat}, ${location.lng}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// OPERATIVE SIDE: Provides impl and handles requests from transport
// ═══════════════════════════════════════════════════════════════════════════

function* operativeMain() {
  // Activate tool WITH impl - registers handler for incoming requests
  yield* GetLocation(function* ({ accuracy }, send) {
    yield* send({ status: "requesting-permission" });
    
    const pos = yield* getGPSPosition(accuracy);
    
    yield* send({ status: "acquired" });
    
    return { lat: pos.lat, lng: pos.lng };
  });
  
  // Handle incoming requests from transport
  yield* useTransport(transport);
}
```

**Flow diagram:**

```
Principal                              Operative
─────────                              ─────────

const getLocation = yield* GetLocation();
// No impl provided - tool routes to transport

yield* getLocation({ accuracy: "high" })
       │
       │  TransportRequest
       │  { id, kind: "elicit", type: "get-location", payload: { accuracy: "high" } }
       │
       └──────────────────────────────────► impl executes
                                            │
                                            │ yield* send({ status: "requesting-permission" })
                              ◄─────────────┘
       ProgressMessage                      │
       { type: "progress", id, data: {...} }│
                                            │ yield* send({ status: "acquired" })
                              ◄─────────────┘
       ProgressMessage                      │
                                            │ return { lat, lng }
                              ◄─────────────┘
       ResponseMessage
       { type: "response", id, response: { status: "accepted", content: { lat, lng } } }
       │
       ▼
location = { lat, lng }
```

### Type Discrimination

```ts
// With impl in config - no argument needed
createTool({ name, description, input, output, impl }) 
  → () => Operation<Tool>

// Without impl - optional impl argument
createTool({ name, description, input, output }) 
  → (impl?: ImplFn) => Operation<Tool>

// Activation patterns:

// 1. Tool with impl in config - call with no args
const Search = createTool({ ..., impl: fn });
const search = yield* Search();  // ✅ Uses impl from config

// 2. Tool without impl - provide impl at activation (same environment)
const GetLocation = createTool({ ... });  // no impl
const getLocation = yield* GetLocation(implFn);  // ✅ Runs locally with provided impl

// 3. Tool without impl - no impl at activation (routes to transport)
const GetLocation = createTool({ ... });  // no impl
const getLocation = yield* GetLocation();  // ✅ Routes to Operative via transport

// Override behavior? Use middleware, not impl override
yield* Search.around(function* (args, next) {
  // intercept, modify, or replace behavior
  return yield* next(...args);
});
```

### Agent (Multi-function API)

```ts
const Flight = createAgent({
  name: "flight",
  description: "Flight booking agent",
  tools: {
    search: Search,
    book: Book,
  },
});

// Instantiate agent (always callable, even without config)
const flight = yield* Flight();
// or with config
const flight = yield* Flight({ apiKey: "..." });

// Use tools
yield* flight.tools.search({ destination: "Tokyo", date: "2024-01-15" });

// Agent-level middleware (object form for multiple tools)
yield* Flight.around({
  search(args, next) {
    return yield* next(...args);
  },
  book(args, next) {
    return yield* next(...args);
  },
});
```

### Built-in Tools (Framework API)

```ts
// Framework defines built-in API
const BuiltInApi = createApi("sweatpants", {
  *elicit(options) { /* routes to transport */ },
  *notify(message, progress?) { /* routes to transport */ },
  *sample(options) { /* routes to transport */ },
});

// Export operations for direct use
export const { elicit, notify, sample } = BuiltInApi.operations;

// Export freestanding around for built-ins
export function around(handlers: {
  elicit?: Middleware,
  notify?: Middleware,
  sample?: Middleware,
}) {
  return BuiltInApi.decorate(handlers);
}

// Usage:
yield* elicit({ type: "form", message: "...", schema: z.object({...}) });
yield* notify("Processing...", 0.5);
yield* sample({ prompt: "...", maxTokens: 150 });

// Middleware for built-ins:
yield* around({
  *sample(args, next) {
    // redact PII, etc.
    return yield* next(...args);
  },
});
```

## Tool Config

```ts
interface ToolConfig<TInput, TProgress, TOutput> {
  name: string;
  description: string;
  input: ZodSchema<TInput>;
  output: ZodSchema<TOutput>;
  progress?: ZodSchema<TProgress>;
  impl?: ToolImplFn<TInput, TProgress, TOutput>;
}

type ToolImplFn<TInput, TProgress, TOutput> = (
  args: TInput,
  send: (progress: TProgress) => Operation<void>
) => Operation<TOutput>;

type Tool<TInput, TOutput> = (args: TInput) => Operation<TOutput>;
```

## Implementation Phases

### Phase 1: Core Tool Infrastructure

**1.1 Tool Types**

```ts
// packages/core/src/tool/types.ts

interface ToolConfig<TInput, TProgress, TOutput> {
  name: string;
  description: string;
  input: ZodSchema<TInput>;
  output: ZodSchema<TOutput>;
  progress?: ZodSchema<TProgress>;
  impl?: ToolImplFn<TInput, TProgress, TOutput>;
}

type ToolImplFn<TInput, TProgress, TOutput> = (
  args: TInput,
  send: (progress: TProgress) => Operation<void>
) => Operation<TOutput>;

type Tool<TInput, TOutput> = (args: TInput) => Operation<TOutput>;
```

**1.2 createTool**

```ts
// packages/core/src/tool/create.ts
import { createApi } from "effection/experimental";

// With impl in config - returns no-arg callable
function createTool<TInput, TProgress, TOutput>(
  config: ToolConfig<TInput, TProgress, TOutput> & { impl: ToolImplFn<...> }
): ToolFactoryWithImpl<TInput, TOutput>;

// Without impl - returns callable that accepts optional impl
function createTool<TInput, TProgress, TOutput>(
  config: ToolConfig<TInput, TProgress, TOutput> & { impl?: never }
): ToolFactoryWithoutImpl<TInput, TProgress, TOutput>;

interface ToolFactoryWithImpl<TInput, TOutput> {
  (): Operation<Tool<TInput, TOutput>>;
  around(middleware: MiddlewareFn): Operation<void>;
}

interface ToolFactoryWithoutImpl<TInput, TProgress, TOutput> {
  (impl?: ToolImplFn<TInput, TProgress, TOutput>): Operation<Tool<TInput, TOutput>>;
  around(middleware: MiddlewareFn): Operation<void>;
}
```

**1.3 Tool activation**

When called (e.g., `yield* Search()` or `yield* GetLocation(impl)`):
- Creates API with the impl as the single operation
- If no impl provided and none in config, uses default impl that routes to transport
- Returns the activated tool function
- Exposes `.around()` that delegates to `api.decorate()`

### Phase 2: Transport Integration

**2.1 Transport Context**

```ts
// packages/core/src/context/transport.ts
import { createContext } from "effection";

export const TransportContext = createContext<CorrelatedTransport>("transport");
```

**2.2 Default impl (routes to transport)**

When a tool has no impl and is invoked:

```ts
function* defaultImpl(name, args) {
  const transport = yield* TransportContext.expect();
  const stream = transport.request({
    id: generateId(),
    kind: "elicit",
    type: name,
    payload: args,
  });
  // Consume stream, return response
  const response = yield* stream;
  return response.content;
}
```

**2.3 Progress via transport**

Even for local impls, `send()` routes progress through transport for consistency.

### Phase 3: Built-in API

**3.1 Create framework API**

```ts
// packages/core/src/builtins/api.ts
import { createApi } from "effection/experimental";

export const BuiltInApi = createApi("sweatpants", {
  *elicit(options) { ... },
  *notify(message, progress?) { ... },
  *sample(options) { ... },
});

export const { elicit, notify, sample } = BuiltInApi.operations;
export const around = (handlers) => BuiltInApi.decorate(handlers);
```

### Phase 4: Agent Infrastructure

**4.1 createAgent**

```ts
// packages/core/src/agent/create.ts
import { createApi } from "effection/experimental";

function createAgent(config: AgentConfig) {
  // Build operations object from tools
  const operations = {};
  for (const [name, tool] of Object.entries(config.tools)) {
    operations[name] = tool.asOperation();
  }
  
  const api = createApi(config.name, operations);
  
  // Return callable that instantiates agent
  function Agent(agentConfig?) {
    return {
      *[Symbol.iterator]() {
        // Set up agent context with config
        // Return handle with tools accessor
      }
    };
  }
  
  Agent.around = (handlers) => api.decorate(handlers);
  
  return Agent;
}
```

### Phase 5: Operative Handler

**5.1 useTransport**

```ts
// packages/core/src/operative/handler.ts

export function* useTransport(transport: OperativeTransport): Operation<void> {
  const subscription = yield* transport;
  
  for (;;) {
    const { value: request, done } = yield* subscription.next();
    if (done) break;
    
    // Look up registered impl for request.type
    // Execute impl
    // Send progress/response back via transport
  }
}
```

## File Structure

```
packages/core/src/
├── tool/
│   ├── index.ts
│   ├── create.ts          # createTool
│   └── types.ts
├── agent/
│   ├── index.ts
│   ├── create.ts          # createAgent
│   └── types.ts
├── builtins/
│   ├── index.ts
│   ├── api.ts             # BuiltInApi
│   └── around.ts          # freestanding around()
├── operative/
│   ├── index.ts
│   └── handler.ts
├── context/
│   ├── index.ts
│   └── transport.ts
├── transport/             # (already exists)
└── types/                 # (already exists)
```

## Implementation Order

1. **Phase 1.1-1.2**: `createTool` types and basic structure
2. **Phase 1.3**: Tool with impl (yieldable)
3. **Test**: Tool with impl using `createTransportPair`
4. **Phase 1.4**: Tool without impl (callable)
5. **Phase 2**: Transport integration
6. **Test**: Tool without impl, impl on operative side
7. **Phase 3**: Built-in API (elicit, notify, sample)
8. **Phase 4**: Agent infrastructure
9. **Phase 5**: Operative handler

## Open Questions

1. **effection import path**: Need to verify - is it `effection/experimental` or `@effectionx/context-api`?

2. **Agent config access**: When tools inside an agent need config, they access it via context set up by `yield* Flight(config)`.

3. **Progress for local impl**: Routes through in-memory transport for consistency.

## Future Considerations

### Tool Initialization Args

Tools may need initialization arguments separate from invocation input. This could be useful for:
- Timeout settings
- Cache configuration
- API keys
- Tool-specific setup needed by Operative

**Potential API (not implemented now):**

```ts
// Activation with init args
const getLocation = yield* GetLocation(impl, initArgs);
const getLocation = yield* GetLocation(initArgs);  // routes to transport + init

// Init args would flow to Operative for remote tools
// Operative impl would receive init args alongside input
```

**Open questions for init args:**
- Should `createTool` accept an `initArgs` schema?
- How do init args flow across the transport to Operative?
- Are init args sent once at activation or with each invocation?

This will be designed and implemented in a future iteration.
