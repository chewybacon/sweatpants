# Effection Tutorial

A hands-on tutorial for learning [Effection](https://frontside.com/effection) - structured concurrency for JavaScript.

## What is Effection?

Effection brings structured concurrency to JavaScript. Unlike Promises, every async operation has a clear parent-child relationship, guaranteed cleanup, and proper cancellation support.

## Tutorial Structure

The tutorial is organized in `docs/tutorial/`:

| Chapter | Topic |
|---------|-------|
| 01 | The Problem with Promises |
| 02 | Operations |
| 03 | Actions |
| 04 | Spawn |
| 05 | Combinators (all, race) |
| 06 | Resources |
| 07 | Channels & Streams |
| 08 | Signals |
| 09 | Context |
| 10 | Scope API |
| 11 | Capstone Architecture |

## Setup

```bash
npm install
```

## Running Examples

All runnable TypeScript examples are in `docs/ts/`. Run any example with:

```bash
npx tsx docs/ts/<example>.ts
```

Examples:

```bash
# Basic operations
npx tsx docs/ts/countdown.ts
npx tsx docs/ts/slow-add.ts

# Spawning concurrent tasks
npx tsx docs/ts/spawn-example.ts
npx tsx docs/ts/parallel-fetch.ts

# Combinators
npx tsx docs/ts/effection-all.ts
npx tsx docs/ts/timeout-pattern.ts

# Resources
npx tsx docs/ts/resource-socket.ts
npx tsx docs/ts/http-server-resource.ts

# Channels & Streams
npx tsx docs/ts/channel-basics.ts
npx tsx docs/ts/event-bus.ts

# Signals
npx tsx docs/ts/signal-basics.ts

# Context
npx tsx docs/ts/context-basics.ts
npx tsx docs/ts/request-context.ts
```

## Available Examples

```
docs/ts/
├── all-with-error.ts
├── api-fallback.ts
├── await-event-horizon.ts
├── channel-basics.ts
├── chat-room.ts
├── children-halted.ts
├── composed-resources.ts
├── context-basics.ts
├── context-scoped.ts
├── countdown.ts
├── database-context.ts
├── each-pattern.ts
├── effection-all.ts
├── effection-race.ts
├── emitter-events.ts
├── ensure-example.ts
├── error-propagation.ts
├── event-bus.ts
├── file-watcher.ts
├── fire-and-forget.ts
├── guaranteed-cleanup.ts
├── http-server-resource.ts
├── keyboard-stream.ts
├── leaky-race.ts
├── leaky-timers.ts
├── logger-context.ts
├── multiple-subscribers.ts
├── parallel-countdown.ts
├── parallel-fetch.ts
├── request-context.ts
├── resource-socket.ts
├── signal-basics.ts
├── sleep-with-logging.ts
├── slow-add.ts
├── spawn-example.ts
├── timeout-pattern.ts
└── xhr-fetch.ts
```
