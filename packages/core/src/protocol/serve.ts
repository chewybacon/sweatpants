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
    // Check if method exists on the protocol. Built-in transport requests use
    // `type` for UI-specific elicit kinds (for example "confirmation"), so
    // fall back to the transport `kind` when the kind names a protocol method.
    const usedKindFallback = !(type in handle.protocol.methods) &&
      request.kind in handle.protocol.methods;
    const methodName = (type in handle.protocol.methods
      ? type
      : usedKindFallback
        ? request.kind
        : undefined) as keyof M | undefined;

    if (!methodName) {
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

    // Send final response. Generic protocol methods are wrapped as accepted
    // transport responses. Built-in requests that fell back from UI-specific
    // `type` values to protocol `kind` methods already return transport-shaped
    // values and need to be normalized instead of double-wrapped.
    let finalResponse: ResponseMessage["response"];
    if (usedKindFallback && request.kind === "notify") {
      finalResponse = streamResult.value as ResponseMessage["response"];
    } else if (usedKindFallback && request.kind === "elicit") {
      const elicitResult = streamResult.value as {
        status: "accepted" | "declined" | "cancelled";
        value?: unknown;
      };
      if (elicitResult.status === "accepted") {
        finalResponse = { status: "accepted", content: elicitResult.value };
      } else if (elicitResult.status === "declined") {
        finalResponse = { status: "declined" };
      } else {
        finalResponse = { status: "cancelled" };
      }
    } else {
      finalResponse = {
        status: "accepted",
        content: streamResult.value,
      };
    }

    const response: ResponseMessage = {
      type: "response",
      id,
      response: finalResponse,
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
