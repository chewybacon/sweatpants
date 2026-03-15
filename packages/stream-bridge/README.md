# @sweatpants/stream-bridge

Bridge Effection streams to HTTP responses with pull-based semantics.

## Installation

```bash
pnpm add @sweatpants/stream-bridge
```

## Usage

### Basic

```typescript
import { createStreamResponse } from '@sweatpants/stream-bridge'
import { resource } from 'effection'

// Create an Effection stream
const myStream = resource(function* (provide) {
  yield* provide({
    *next() {
      // Your streaming logic here
      return { done: false, value: 'hello' }
    }
  })
})

// Convert to HTTP Response
const { response, destroy } = yield* createStreamResponse(myStream)

// Use in HTTP handler
return response

// Cleanup when done
await destroy()
```

### With Existing Scope

```typescript
import { createReadableStream } from '@sweatpants/stream-bridge'
import { useScope } from 'effection'

const scope = yield* useScope()
const readableStream = createReadableStream(scope, myStream)
const response = new Response(readableStream)
```

### Custom Serialization

```typescript
const { response } = yield* createStreamResponse(myStream, {
  serialize: (value) => new TextEncoder().encode(value + '\n'),
  contentType: 'text/plain'
})
```

## API

### `createStreamResponse<T>(stream, options?)`

Creates a Response with a ReadableStream body that pulls from an Effection stream.

**Returns:** `{ response, scope, destroy }`

### `createReadableStream<T>(scope, stream, options?)`

Creates a ReadableStream from an Effection stream with an existing scope.

**Returns:** `ReadableStream<Uint8Array>`

## Features

- **Pull-based**: Values are only produced when the consumer requests them
- **Backpressure**: Slow consumers don't cause unbounded buffering
- **Efficient**: Minimal scope.run() overhead per item (~30-40k items/sec)
- **Type-safe**: Full TypeScript support

## Benchmark Results

| Approach | Items/sec | Avg Time/Item |
|----------|-----------|---------------|
| createStreamResponse | ~40,000 | 0.025ms |
| createReadableStream | ~40,000 | 0.025ms |

## Running Tests

```bash
pnpm test
```

## License

MIT
