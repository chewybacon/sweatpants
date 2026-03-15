# @sweatpants/stream-bridge

**Experimental package** for exploring different approaches to bridging Effection streams to HTTP response bodies.

## Background

Effection uses generator-based `Operation<T>` with `yield*`, while Web Streams use callback-based `pull(controller)` with Promises. This mismatch requires a "bridge" pattern.

This package experiments with different approaches to find the cleanest, most efficient solution.

## Approaches

### 1. ReadableStream Bridge (Baseline)

```typescript
import { createReadableStreamBridge } from '@sweatpants/stream-bridge'

const response = yield* createReadableStreamBridge(stream)
```

**How it works:**
- Creates a `ReadableStream` with `scope.run()` inside `pull()`
- Each pull calls `scope.run()` to get the next value

**Pros:**
- Works with standard `Response` objects
- Backpressure handled by `ReadableStream`

**Cons:**
- `scope.run()` overhead on every pull
- Mixing Effection and callback-based APIs

---

### 2. AsyncIterable Response Body

```typescript
import { createAsyncIterableResponse } from '@sweatpants/stream-bridge'

const response = yield* createAsyncIterableResponse(stream)
```

**How it works:**
- Uses `AsyncIterable<Uint8Array>` directly as `Response` body
- Avoids `ReadableStream` boilerplate

**Pros:**
- Simpler code
- Native async iteration

**Cons:**
- Still needs `scope.run()` for each iteration
- Less control over backpressure

---

### 3. Scope-Captured Stream

```typescript
import { createScopeCapturedStream } from '@sweatpants/stream-bridge'

const { response, scope, destroy } = yield* createScopeCapturedStream(stream)
```

**How it works:**
- Pre-captures subscription during setup
- Only `next()` needs `scope.run()`

**Pros:**
- Fewer `scope.run()` calls
- Cleaner separation of setup and iteration

**Cons:**
- Still needs `scope.run()` for each `next()`
- More complex state management

---

### 4. Effection-Native Server

```typescript
import { createEffectionServer } from '@sweatpants/stream-bridge'

const server = yield* createEffectionServer({
  port: 3000,
  handler: function* (req) {
    return yield* createReadableStreamBridge(stream)
  }
})
```

**How it works:**
- HTTP server runs entirely inside Effection
- Handlers return `Operation<Response>` instead of `Promise<Response>`

**Pros:**
- No bridge needed - fully Effection-native
- Clean handler API with `yield*`
- Automatic cleanup on shutdown

**Cons:**
- Requires wrapping the underlying HTTP server
- Runtime-specific (Node vs Deno)

---

## Test Results

| Test | Approach 1 | Approach 2 | Approach 3 | Approach 4 |
|------|------------|------------|------------|------------|
| Pull behavior | ✅ | ✅ | ✅ | ✅ |
| HTTP streaming | ✅ | ✅ | ✅ | ✅ |
| Error handling | ✅ | ✅ | ✅ | ✅ |

All approaches correctly implement pull-based streaming - values are only produced when the consumer requests them.

## Running Tests

```bash
pnpm test
```

## Next Steps

1. **Benchmark**: Measure performance differences between approaches
2. **Backpressure**: Test with slow consumers
3. **Memory**: Profile memory usage for long-running streams
4. **Decision**: Choose the best approach for the framework

## License

MIT
