import { spawn, type Operation, type Subscription } from "effection";
import type { Handle, Methods } from "./types.ts";
import type {
  OperativeTransport,
  TransportRequest,
  ProgressMessage,
  ResponseMessage,
  RequestKind,
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
  request: TransportRequest<RequestKind>,
): Operation<void> {
  const { id, kind, type, payload } = request;

  // For built-in protocol, dispatch based on kind (elicit/notify/sample)
  // For custom protocols, dispatch based on type (the method name)
  const methodName = (kind in handle.protocol.methods ? kind : type) as keyof M;

  try {
    // Check if method exists on the protocol
    if (!(methodName in handle.protocol.methods)) {
      const response: ResponseMessage<typeof kind> = {
        type: "response",
        id,
        kind,
        response: {
          status: "other",
          content: `Unknown method: ${String(methodName)}`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any, // Response shape depends on kind, but error is consistent
      };
      yield* transport.send(response);
      return;
    }

    // Invoke the method
    // Type assertion needed since payload comes from transport as unknown
    // The protocol could validate against schemas if needed
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
    // For built-in protocol (SweatpantsProtocol), the result includes status
    // and uses 'value' instead of 'content'. Map appropriately.
    const resultValue = streamResult.value as { status?: string; value?: unknown; ok?: boolean; text?: string };
    
    // Determine the response based on the result structure
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let responsePayload: any;
    
    if (kind === "notify") {
      // Notify responses use { ok: boolean }
      responsePayload = resultValue;
    } else if (resultValue && typeof resultValue === "object" && "status" in resultValue) {
      // Elicit/sample responses that have status - map 'value' to 'content'
      const { status, value, ...rest } = resultValue;
      responsePayload = value !== undefined 
        ? { status, content: value, ...rest }
        : { status, ...rest };
    } else {
      // Fallback: wrap as accepted with content
      responsePayload = { status: "accepted", content: resultValue };
    }
    
    const response: ResponseMessage<typeof kind> = {
      type: "response",
      id,
      kind,
      response: responsePayload,
    };
    yield* transport.send(response);
  } catch (error) {
    // Send error response
    const response: ResponseMessage<typeof kind> = {
      type: "response",
      id,
      kind,
      response: {
        status: "other",
        content: error instanceof Error ? error.message : String(error),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any, // Response shape depends on kind, but error is consistent
    };
    yield* transport.send(response);
  }
}
