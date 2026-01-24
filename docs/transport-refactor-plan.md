# Transport Refactor Plan: Channels and @effectionx/websocket

## Current State

The transport layer uses `createSignal` to bridge progress/response events into Effection streams. This forced `receiveProgress()` and `receiveResponse()` to be regular functions (not generators) because signals are designed for external callbacks.

## Problem

Since we're assuming everything runs inside Effection, we should use `createChannel` instead:

| Primitive | Use Case | `send()`/`close()` |
|-----------|----------|-------------------|
| `createSignal` | Bridging external callbacks (DOM events, HTTP handlers) | Regular functions |
| `createChannel` | Communication between Effection operations | Operations (require `yield*`) |

## Proposed Changes

### 1. SSE Backend Transport (`transport/sse/backend.ts`)

**Before:**
```ts
const progressSignal = createSignal<TProgress, TResponse>();

// Regular functions - can't yield*
receiveProgress(id: string, data: unknown): void {
  request.progressSignal.send(data);
}

receiveResponse(id: string, response: ElicitResponse | NotifyResponse): void {
  request.progressSignal.close(response);
}
```

**After:**
```ts
import { createChannel, type Channel } from "effection";

const progressChannel = createChannel<TProgress, TResponse>();

// Now proper Operations
*receiveProgress(id: string, data: unknown): Operation<void> {
  const request = pending.get(id);
  if (request) {
    yield* request.progressChannel.send(data);
  }
}

*receiveResponse(id: string, response: ElicitResponse | NotifyResponse): Operation<void> {
  const request = pending.get(id);
  if (request) {
    yield* request.progressChannel.close(response);
    pending.delete(id);
  }
}
```

**Interface update:**
```ts
export interface SSEBackendTransport extends BackendTransport {
  receiveProgress(id: string, data: unknown): Operation<void>;
  receiveResponse(id: string, response: ElicitResponse | NotifyResponse): Operation<void>;
}
```

### 2. WebSocket Backend Transport (`transport/websocket/backend.ts`)

Use `@effectionx/websocket` for clean WebSocket handling:

```ts
import { useWebSocket, type WebSocketResource } from "@effectionx/websocket";
import { createChannel, each, spawn, resource } from "effection";

export function* createWebSocketBackendTransport(
  url: string
): Operation<WebSocketBackendTransport> {
  const socket = yield* useWebSocket<string>(url);
  const pending = new Map<string, Channel<unknown, unknown>>();
  
  // Spawn a listener for incoming messages (progress/response from frontend)
  yield* spawn(function* () {
    for (const event of yield* each(socket)) {
      const message: WebSocketMessage = JSON.parse(event.data);
      
      if (message.type === "progress") {
        const channel = pending.get(message.id);
        if (channel) {
          yield* channel.send(message.data);
        }
      } else if (message.type === "response") {
        const channel = pending.get(message.id);
        if (channel) {
          yield* channel.close(message.response);
          pending.delete(message.id);
        }
      }
      yield* each.next();
    }
  });
  
  return {
    send<TPayload, TProgress, TResponse>(message: TransportRequest<TPayload>) {
      return resource(function* (provide) {
        const channel = createChannel<TProgress, TResponse>();
        pending.set(message.id, channel as Channel<unknown, unknown>);
        
        try {
          // Send request to frontend via WebSocket
          const wireMessage: WebSocketMessage = { type: "request", payload: message };
          socket.send(JSON.stringify(wireMessage));
          
          // Provide the channel subscription to the caller
          const subscription = yield* channel;
          yield* provide(subscription);
        } finally {
          pending.delete(message.id);
        }
      });
    }
  };
}
```

### 3. WebSocket Frontend Transport (`transport/websocket/frontend.ts`)

```ts
import { useWebSocket } from "@effectionx/websocket";
import { createChannel, each, spawn, resource } from "effection";

export function* createWebSocketFrontendTransport(
  url: string
): Operation<FrontendTransport> {
  const socket = yield* useWebSocket<string>(url);
  const messageChannel = createChannel<IncomingMessage, void>();
  
  // Spawn a listener for incoming requests from backend
  yield* spawn(function* () {
    for (const event of yield* each(socket)) {
      const wireMessage: WebSocketMessage = JSON.parse(event.data);
      
      if (wireMessage.type === "request") {
        const request = wireMessage.payload;
        
        const message: IncomingMessage = {
          id: request.id,
          kind: request.kind,
          type: request.type,
          payload: request.payload,
          
          // These send back to the backend via WebSocket
          *progress(data) {
            socket.send(JSON.stringify({
              type: "progress",
              id: request.id,
              data,
            }));
          },
          
          *respond(response) {
            socket.send(JSON.stringify({
              type: "response",
              id: request.id,
              response,
            }));
          },
        };
        
        yield* messageChannel.send(message);
      }
      yield* each.next();
    }
  });
  
  // Return transport with messages stream
  return {
    messages: resource(function* (provide) {
      const subscription = yield* messageChannel;
      yield* provide(subscription);
    })
  };
}
```

### 4. Update Tests

Tests become simpler without setTimeout workarounds:

**Before:**
```ts
// Had to wrap in setTimeout because signal.close() from Effection didn't wake up consumers
simulateHttpCallback(() => {
  transport.receiveResponse("msg-1", { status: "accepted", content: {...} });
});
yield* sleep(50);  // Wait for callback
```

**After:**
```ts
// Direct yield* works because channel.close() is an Operation
yield* transport.receiveProgress("msg-1", { status: "requesting-permission" });
yield* transport.receiveResponse("msg-1", { status: "accepted", content: {...} });
// No extra sleep needed
```

### 5. Dependencies

Add to `packages/core/package.json`:

```json
{
  "peerDependencies": {
    "@effectionx/websocket": "^2.3.0",
    "effection": "^4.0.0"
  },
  "devDependencies": {
    "@effectionx/websocket": "catalog:"
  }
}
```

Add to `pnpm-workspace.yaml` catalog:
```yaml
catalog:
  '@effectionx/websocket': ^2.3.0
```

## Questions to Resolve

### 1. SSE Transport: Signal vs Channel?

The SSE transport is different from WebSocket:
- Backend sends SSE events (via HTTP response stream)
- Frontend POSTs responses back

If the POST handler is a standard HTTP handler (Express, Hono, etc.), it might be an external callback, not inside Effection. In that case:

**Option A: Keep `createSignal` for SSE**
- `receiveProgress`/`receiveResponse` remain regular functions
- HTTP POST handlers can call them directly without being in Effection

**Option B: Use `createChannel` for SSE**
- HTTP POST handlers must wrap in `run()` or be inside an Effection server
- More consistent with WebSocket transport

**Recommendation:** Go with Option B (use `createChannel`) since we're assuming Effection throughout. If someone needs external callback support, they can wrap in `run()`.

### 2. WebSocket URL vs Socket Object?

**Current:** Accept a `WebSocket` object
**Proposed:** Accept a URL string, let `@effectionx/websocket` create the socket

**Recommendation:** Accept URL string for simplicity. The `useWebSocket()` function handles:
- Connection establishment
- Ready state management
- Error handling
- Automatic cleanup

If someone needs custom WebSocket creation, they can use:
```ts
yield* useWebSocket(() => new CustomWebSocket(url));
```

### 3. Server-Side WebSocket?

`@effectionx/websocket` is for client-side connections. For server-side:
- The server accepts incoming WebSocket connections
- Each connection is a new client

This is a different pattern - we'd need to handle it separately, possibly with a different transport or by integrating with a WebSocket server library.

**Recommendation:** For now, focus on client-side transport. Server-side can be added later when we have a concrete use case.

## Implementation Order

1. Update `pnpm-workspace.yaml` to add `@effectionx/websocket` to catalog
2. Update `packages/core/package.json` to add dependency
3. Refactor `transport/sse/backend.ts` to use `createChannel`
4. Update tests to use `yield*` directly
5. Refactor `transport/websocket/backend.ts` to use `@effectionx/websocket`
6. Refactor `transport/websocket/frontend.ts` to use `@effectionx/websocket`
7. Add WebSocket tests

## Benefits After Refactor

1. **Simpler tests** - No setTimeout workarounds
2. **Consistent API** - All methods are Operations
3. **Better WebSocket support** - Uses well-tested `@effectionx/websocket`
4. **Proper resource cleanup** - WebSocket automatically closes when out of scope
5. **Better error handling** - Socket errors propagate through Effection
