import { spawn, type Operation, type Subscription } from "effection";
import type { Handle, Methods } from "./types.ts";
import type {
  OperativeTransport,
  TransportRequest,
  ProgressMessage,
  ResponseMessage,
} from "../types/transport.ts";

/**
 * Serve a protocol over an operative transport.
 * 
 * Listens for incoming requests, dispatches them to the handle's methods,
 * streams progress updates, and sends final responses.
 * 
 * @example
 * ```ts
 * // Create protocol and implementation
 * const protocol = createProtocol({ ... });
 * const inspector = createImplementation(protocol, function*() { ... });
 * const handle = yield* inspector.attach();
 * 
 * // Get operative transport (from pair, websocket, etc.)
 * const [principal, operative] = yield* createTransportPair();
 * 
 * // Serve the protocol - handles all incoming requests
 * yield* serveProtocol(handle, operative);
 * ```
 */
export function* serveProtocol<M extends Methods>(
  handle: Handle<M>,
  transport: OperativeTransport,
): Operation<void> {
  const subscription: Subscription<TransportRequest, void> = yield* transport;

  for (;;) {
    const result = yield* subscription.next();
    if (result.done) break;

    const request = result.value;

    // Handle each request in its own spawned task
    yield* spawn(function* () {
      yield* handleRequest(handle, transport, request);
    });
  }
}

/**
 * Handle a single request by dispatching to the protocol and streaming the response.
 */
function* handleRequest<M extends Methods>(
  handle: Handle<M>,
  transport: OperativeTransport,
  request: TransportRequest,
): Operation<void> {
  const { id, type, payload } = request;

  try {
    // Check if method exists on the protocol
    if (!(type in handle.protocol.methods)) {
      const response: ResponseMessage = {
        type: "response",
        id,
        response: {
          status: "other",
          content: `Unknown method: ${type}`,
        },
      };
      yield* transport.send(response);
      return;
    }

    // Invoke the method
    // Type assertion needed since payload comes from transport as unknown
    // The protocol could validate against schemas if needed
    const methodName = type as keyof M;
    const stream = handle.invoke({
      name: methodName,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: payload as any,
    });

    // Subscribe to the stream
    const subscription = yield* stream;

    // Process stream: send progress updates until done
    let streamResult = yield* subscription.next();
    while (!streamResult.done) {
      // Send progress update
      const progress: ProgressMessage = {
        type: "progress",
        id,
        data: streamResult.value,
      };
      yield* transport.send(progress);

      streamResult = yield* subscription.next();
    }

    // Send final response
    const response: ResponseMessage = {
      type: "response",
      id,
      response: {
        status: "accepted",
        content: streamResult.value,
      },
    };
    yield* transport.send(response);
  } catch (error) {
    // Send error response
    const response: ResponseMessage = {
      type: "response",
      id,
      response: {
        status: "other",
        content: error instanceof Error ? error.message : String(error),
      },
    };
    yield* transport.send(response);
  }
}
