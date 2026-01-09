---
theme: default
title: "Structured Concurrency in the Wild: Building MCP-Native"
info: |
  ## Sweatpants Framework
  A love letter to Effection
author: Grove Team
keywords: effection,structured-concurrency,generators,mcp
class: text-center
highlighter: shiki
drawings:
  persist: false
transition: slide-left
mdc: true
colorSchema: light
---

# Structured Concurrency in the Wild

## Building MCP-Native with Effection

<div class="pt-12">
  <span class="px-2 py-1 rounded cursor-pointer bg-gray-100">
    Sweatpants Framework
  </span>
</div>

<div class="abs-br m-6 flex gap-2 text-sm opacity-50">
  a love letter to effection
</div>

---

# The Problem We're Solving

Build a runtime where **tool generators stay alive across HTTP requests**.

```ts
.execute(function* (params, ctx) {
  const flights = yield* searchFlights(params)
  
  // HTTP request ends here. Generator suspends.
  const flight = yield* ctx.elicit('pickFlight', { flights })
  // Minutes/hours later... new HTTP request. Generator resumes.
  
  const seat = yield* ctx.elicit('pickSeat', { seatMap })
  // Another suspend/resume cycle...
  
  const tip = yield* ctx.sample({ prompt: 'Travel tip?' })
  // And another...
  
  return { flight, seat, tip }
})
```

<v-click>

<div class="mt-4 p-3 bg-amber-50 rounded-lg text-sm">

This is **durable execution** without serializing the generator. The hard way. The fun way.

</div>

</v-click>

---
layout: center
class: text-center
---

# The Concurrency Challenges

<v-clicks>

<div class="text-xl mt-4">

**Session Management** - Generators live longer than requests

</div>

<div class="text-xl mt-4">

**Multiplexed I/O** - Multiple tools, multiple clients, one process

</div>

<div class="text-xl mt-4">

**Backpressure** - User takes 10 minutes to pick a flight

</div>

<div class="text-xl mt-4">

**Cancellation** - User closes tab mid-flow

</div>

<div class="text-xl mt-4">

**Error Propagation** - Tool throws, session must cleanup

</div>

</v-clicks>

---

# Why Effection?

Without structured concurrency, this is a nightmare:

```ts
// The callback hell version
async function runTool(params) {
  const sessionId = uuid()
  sessions.set(sessionId, { status: 'running', cleanup: [] })
  
  try {
    const flights = await searchFlights(params)
    sessions.get(sessionId).cleanup.push(() => cancelFlightHold())
    
    return new Promise((resolve, reject) => {
      pendingElicits.set(sessionId, { resolve, reject })
      sessions.get(sessionId).cleanup.push(() => pendingElicits.delete(sessionId))
      emit('elicit', { sessionId, key: 'pickFlight', flights })
      // Now we wait... and hope nothing goes wrong
      // What if the session times out? What if the user disconnects?
      // What about the cleanup handlers? Did we remember all of them?
    })
  } catch (e) {
    sessions.get(sessionId).cleanup.forEach(fn => fn()) // Did we catch everything?
    throw e
  }
}
```

---

# The Effection Version

```ts
.execute(function* (params, ctx) {
  const flights = yield* searchFlights(params)
  
  const flight = yield* ctx.elicit('pickFlight', { flights })
  const seat = yield* ctx.elicit('pickSeat', { seatMap })
  const tip = yield* ctx.sample({ prompt: 'Travel tip?' })
  
  return { flight, seat, tip }
})
```

<v-click>

<div class="mt-6 text-center text-2xl">

That's it. Cancellation, cleanup, error propagation - all handled.

</div>

</v-click>

<v-click>

<div class="mt-4 p-4 bg-green-50 rounded-lg">

**Structured concurrency guarantee:** When this generator is halted, everything it spawned is halted too. No cleanup handlers. No forgotten listeners. No leaked resources.

</div>

</v-click>

---

# Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    HTTP Handler (per request)                   │
│  - Stateless, can hit any instance                              │
├─────────────────────────────────────────────────────────────────┤
│                 ToolSessionRegistry                             │
│  - acquire(sessionId) → ToolSession                             │
│  - Refcount pattern (like your TokenBuffer!)                    │
├─────────────────────────────────────────────────────────────────┤
│                    ToolSession                                  │
│  - The durable execution context                                │
│  - Queue<ToolSessionEvent> for output                           │
│  - Signal<ElicitResponse> for suspend/resume                    │
├─────────────────────────────────────────────────────────────────┤
│                 Tool Generator (long-lived)                     │
│  - yield* ctx.elicit() suspends on Signal                       │
│  - yield* ctx.sample() suspends on Signal                       │
│  - Lives until completion, error, or cancellation               │
└─────────────────────────────────────────────────────────────────┘
```

---

# Pattern 1: Signal for Suspend/Resume

The core primitive for `ctx.elicit()`:

````md magic-move
```ts
// Inside the tool execution runtime
function* elicit<T>(key: string, data: unknown): Operation<ElicitResult<T>> {
  // Create a signal that will receive the response
  const responseSignal = createSignal<ElicitResponse, void>()
  
  // Emit the elicit request (goes to client via SSE)
  yield* events.send({
    type: 'elicit_request',
    id: uuid(),
    key,
    data,
    responseSignal,  // The client will send() to this
  })
  
  // Suspend until response arrives
  const response = yield* responseSignal
  
  return response
}
```
```ts
// When the HTTP response comes in (different request!)
function* handleElicitResponse(sessionId: string, elicitId: string, result: ElicitResult) {
  const session = yield* registry.acquire(sessionId)
  
  try {
    // Find the pending elicit request
    const pending = session.pendingElicits.get(elicitId)
    
    // Resume the suspended generator!
    pending.responseSignal.send(result)
    //                     ^^^^^^^^^^^^
    // This unblocks the yield* in the tool generator
  } finally {
    yield* registry.release(sessionId)
  }
}
```
```ts
// The beautiful part: cancellation is automatic
function* elicit<T>(key: string, data: unknown): Operation<ElicitResult<T>> {
  const responseSignal = createSignal<ElicitResponse, void>()
  
  yield* events.send({ type: 'elicit_request', responseSignal, ... })
  
  // If the tool is cancelled while waiting here...
  const response = yield* responseSignal
  // ...we never reach here, and the signal is cleaned up
  
  return response
}
// No try/finally needed. Structured concurrency handles it.
```
````

---

# Pattern 2: Queue for Event Buffering

Tool emits events, SSE stream consumes them:

```ts
function* createToolSession(tool, params): Operation<ToolSession> {
  // Event buffer - producer and consumer can run at different rates
  const events = createChannel<ToolSessionEvent>()
  
  // Spawn the tool execution as a child task
  yield* spawn(function* () {
    try {
      const result = yield* tool.execute(params, createContext(events))
      yield* events.send({ type: 'result', value: result })
    } catch (error) {
      yield* events.send({ type: 'error', error })
    } finally {
      events.close()
    }
  })
  
  return {
    // SSE handler pulls from this
    getEvents: () => events,
  }
}
```

<v-click>

<div class="mt-2 p-3 bg-blue-50 rounded-lg text-sm">

**Backpressure for free:** If SSE consumer is slow, channel buffers. If tool is slow, consumer waits. No callbacks, no manual coordination.

</div>

</v-click>

---

# Pattern 3: Resource for Lifecycle

Server pool that spawns backends on demand:

````md magic-move
```ts
function useServerPool(config): Operation<ServerPool> {
  return resource(function* (provide) {
    const servers = new Map<string, ServerInfo>()
    const scope = yield* useScope()  // Capture for spawning from callbacks
    
    const pool: ServerPool = {
      async getOrCreate(hostname) {
        if (servers.has(hostname)) return servers.get(hostname)
        
        // Spawn server as child of the pool
        return await scope.run(function* () {
          return yield* spawnServer(hostname)
        })
      },
    }
    
    yield* provide(pool)
    // When pool is shut down, ALL spawned servers are halted automatically
  })
}
```
```ts
// The spawnServer uses the daemon pattern
function* spawnServer(hostname: string): Operation<ServerInfo> {
  const handle = yield* useExpressServerDaemon(port, hostname)
  
  // Server is now running as a daemon
  // If it crashes unexpectedly, this throws
  // If parent is halted, server is shut down
  
  yield* suspend()  // Keep alive until halted
}
```
```ts
// Real code from hydra/server-pool.ts
const task = scope.run(function* (): Operation<void> {
  try {
    const handle = yield* useExpressServerDaemon(port, hostname)
    info.app = handle.app
    info.server = handle.server
    
    emitEvent({ type: 'started', hostname, port })
    resolveReady!(info)
    
    yield* suspend()  // Keep running until halted
  } catch (error) {
    emitEvent({ type: 'error', hostname, error })
    rejectReady!(error)
    throw error
  } finally {
    emitEvent({ type: 'stopped', hostname })
    servers.delete(hostname)  // Cleanup on any exit path
  }
})
```
````

---

# Pattern 4: Scope Escape Hatch

The `useScope()` pattern for async callbacks:

```ts
function useServerPool(config): Operation<ServerPool> {
  return resource(function* (provide) {
    const scope = yield* useScope()  // Capture the scope
    
    const pool = {
      // This is an async function called from Express middleware!
      async getOrCreate(hostname: string): Promise<ServerInfo> {
        // But we can still spawn Effection tasks
        return await scope.run(function* () {
          return yield* doSpawnServer(hostname)
        })
      },
    }
    
    yield* provide(pool)
  })
}
```

<v-click>

<div class="mt-4 p-3 bg-purple-50 rounded-lg">

**The bridge:** `scope.run()` lets you enter Effection-land from callback-land. The spawned task is still a child of the resource - structured concurrency preserved.

</div>

</v-click>

---

# Pattern 5: The Switchboard

HTTP proxy that routes to dynamic backends:

```ts
function useSwitchboard(config, pool): Operation<SwitchboardHandle> {
  return resource(function* (provide) {
    const app = express()
    const proxy = httpProxy.createProxyServer({ ws: true })
    
    // Main proxy handler - async callback, but pool.getOrCreate handles it
    app.use(async (req, res, next) => {
      const hostname = extractHostname(req)
      const server = await pool.getOrCreate(hostname)  // May spawn!
      proxy.web(req, res, { target: `http://localhost:${server.port}` })
    })
    
    const server = yield* call(() => new Promise(resolve => {
      const srv = app.listen(config.port, () => resolve(srv))
    }))
    
    try {
      yield* provide({ app, server, port: config.port })
    } finally {
      proxy.close()
      server.close()
      yield* call(() => new Promise(resolve => server.on('close', resolve)))
    }
  })
}
```

---

# The Full Stack

```ts
// start.ts - the entire runtime in ~20 lines
import { main } from 'effection'
import { useServerPool } from './server-pool'
import { useSwitchboard } from './switchboard'

await main(function* () {
  // Create the server pool (manages backend instances)
  const pool = yield* useServerPool({ basePort: 9000, maxServers: 100 })
  
  // Create the switchboard (HTTP proxy)
  const switchboard = yield* useSwitchboard({ port: 8000 }, pool)
  
  console.log(`Switchboard ready on port ${switchboard.port}`)
  
  // Subscribe to pool events
  yield* spawn(function* () {
    for (const event of yield* each(pool.events)) {
      console.log(`[Pool] ${event.type}:`, event.hostname)
      yield* each.next()
    }
  })
  
  yield* suspend()  // Run forever (until Ctrl+C)
})
// Ctrl+C → main halts → switchboard halts → pool halts → all servers halt
```

---

# What This Enables: Tool Portability

Same tool definition, multiple runtimes:

```ts
const bookFlightTool = createMcpTool('book_flight')
  .elicits({ pickFlight, pickSeat })
  .execute(function* (params, ctx) {
    const flights = yield* searchFlights(params)
    const flight = yield* ctx.elicit('pickFlight', { flights })
    const seat = yield* ctx.elicit('pickSeat', { seatMap })
    return { flight, seat }
  })
```

<v-click>

<div class="grid grid-cols-2 gap-4 mt-6">

<div class="p-4 bg-blue-50 rounded-lg">

**In-App Runtime**
- `ctx.elicit()` → React component
- Signal bridges to UI
- Same process

</div>

<div class="p-4 bg-green-50 rounded-lg">

**MCP Server Runtime**
- `ctx.elicit()` → MCP protocol
- Signal bridges to HTTP
- Durable across requests

</div>

</div>

</v-click>

<v-click>

<div class="mt-4 text-center">

The generator doesn't know or care which runtime it's in. **Effection operations compose.**

</div>

</v-click>

---

# The Joy of Building This

<v-clicks>

**No cleanup handlers.** When a session is cancelled, everything cleans up. We didn't write a single `finally` block for resource cleanup.

**No race conditions.** Signals and channels are the only coordination primitives. No mutexes, no locks, no "did I remember to release this?"

**No callback hell.** Express handlers call async functions that spawn Effection tasks. The boundary is clean.

**No leaked resources.** Server pool spawns 50 backends? Ctrl+C shuts them all down. No stragglers.

**Testable.** We can run the entire runtime in a test, simulate user responses, and verify the tool executes correctly.

</v-clicks>

---

# Things We Learned

<v-clicks>

**1. `useScope()` is essential** - Async callbacks need to spawn tasks. This is the bridge.

**2. Signals > Promises for suspend/resume** - A promise resolves once. A signal can be sent multiple times, closed, etc.

**3. Resources compose beautifully** - Pool resource provides pool, switchboard resource uses pool. Shutdown is automatic.

**4. The daemon pattern rocks** - `yield* suspend()` keeps a task alive. If it shouldn't exit, make it a daemon.

**5. Channels handle backpressure** - Tool produces events, SSE consumes. Different rates? Channel buffers. Done.

</v-clicks>

---
layout: center
---

# Key Takeaways

<v-clicks>

1. **Structured concurrency makes durable execution tractable** - No cleanup handlers, no leaked resources

2. **Signals are the perfect suspend/resume primitive** - `yield* signal` blocks, `signal.send()` unblocks

3. **Resources + useScope() bridge to callback land** - Express, HTTP handlers, WebSockets - all work

4. **The tool generator is portable** - Same code runs in-app or as MCP server

5. **Effection made this joyful** - We focused on the domain, not the concurrency

</v-clicks>

---
layout: center
class: text-center
---

# Thank You

<div class="mt-8 text-gray-500">

```
apps/hydra/src/             # Server pool, switchboard
packages/framework/src/lib/chat/mcp-tools/  # Tool runtime
packages/framework/src/lib/chat/durable-streams/  # Session management
```

</div>

<div class="mt-8">

Questions? Let's talk about generators.

</div>

<div class="mt-12 opacity-50 text-sm">

built with effection, presented with gratitude

</div>
