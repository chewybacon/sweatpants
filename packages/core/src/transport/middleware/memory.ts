/**
 * Memory Transport Middleware
 *
 * In-memory transport for testing. Creates a connected pair of
 * principal and operative middleware.
 *
 * ## Usage
 *
 * ```typescript
 * const [MemoryPrincipal, MemoryOperative] = MemoryPair();
 *
 * // Principal side
 * const principal = yield* initTransport(MemoryPrincipal());
 * const response = yield* principal.request({ kind: "sample", ... });
 *
 * // Operative side
 * const operative = yield* initTransport(MemoryOperative());
 * for (const req of yield* each(yield* operative.stream())) {
 *   yield* operative.send({ type: "response", id: req.id, ... });
 *   yield* each.next();
 * }
 * ```
 *
 * @packageDocumentation
 */

import {
  createChannel,
  spawn,
  each,
  type Operation,
  type Channel,
  type Stream,
  type Subscription,
} from "effection";
import type {
  PrincipalOutgoing,
  OperativeOutgoing,
  PrincipalIncoming,
  OperativeIncoming,
  RequestKind,
  ResponseByKind,
} from "../../types/transport.ts";
import { isResponseMessage } from "../../types/transport.ts";
import {
  generateRequestId,
  type PrincipalMiddleware,
  type OperativeMiddleware,
  type TransportRequestWithoutId,
} from "../api.ts";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Pending request waiting for response.
 * Uses a channel that closes with the response value.
 */
interface PendingRequest {
  channel: Channel<never, ResponseByKind[RequestKind]>;
}

// =============================================================================
// MEMORY PAIR
// =============================================================================

/**
 * Create a connected pair of memory transport middleware.
 *
 * @returns Tuple of [MemoryPrincipal, MemoryOperative] middleware factories
 *
 * @example
 * ```typescript
 * const [MemoryPrincipal, MemoryOperative] = MemoryPair();
 *
 * // Principal side
 * const principal = yield* initTransport(MemoryPrincipal());
 *
 * // Operative side
 * const operative = yield* initTransport(MemoryOperative());
 * ```
 */
export function MemoryPair(): [
  () => Operation<PrincipalMiddleware>,
  () => Operation<OperativeMiddleware>
] {
  // Shared channels between principal and operative
  const principalToOperative: Channel<PrincipalOutgoing, void> =
    createChannel<PrincipalOutgoing, void>();
  const operativeToPrincipal: Channel<OperativeOutgoing, void> =
    createChannel<OperativeOutgoing, void>();

  /**
   * Memory principal middleware.
   * Sets up correlation and returns the middleware decoration object.
   */
  function* MemoryPrincipal(): Operation<PrincipalMiddleware> {
    // Correlation state
    const pendingRequests = new Map<string, PendingRequest>();

    // Spawn router to handle incoming responses
    yield* spawn(function* () {
      for (const msg of yield* each(operativeToPrincipal as Stream<OperativeOutgoing, void>)) {
        if (isResponseMessage(msg as PrincipalIncoming)) {
          const responseMsg = msg as { type: "response"; id: string; response: ResponseByKind[RequestKind] };
          const pending = pendingRequests.get(responseMsg.id);
          if (pending) {
            pendingRequests.delete(responseMsg.id);
            yield* pending.channel.close(responseMsg.response);
          }
        }
        yield* each.next();
      }
    });

    // Return the middleware decoration object
    return {
      *send([message]) {
        yield* principalToOperative.send(message as PrincipalOutgoing);
      },

      *request([req]) {
        const typedReq = req as TransportRequestWithoutId;
        const id = generateRequestId();
        const fullReq: PrincipalOutgoing = { ...typedReq, id } as PrincipalOutgoing;

        const responseChannel = createChannel<never, ResponseByKind[RequestKind]>();
        pendingRequests.set(id, { channel: responseChannel });

        try {
          yield* principalToOperative.send(fullReq);

          const sub: Subscription<never, ResponseByKind[RequestKind]> = yield* responseChannel;
          let result = yield* sub.next();
          while (!result.done) {
            result = yield* sub.next();
          }
          return result.value;
        } finally {
          pendingRequests.delete(id);
        }
      },

      *stream() {
        return operativeToPrincipal as Stream<PrincipalIncoming | OperativeIncoming, void>;
      },
    };
  }

  /**
   * Memory operative middleware.
   * Returns the middleware decoration object (no correlation needed).
   */
  function* MemoryOperative(): Operation<OperativeMiddleware> {
    // Return the middleware decoration object
    return {
      *send([message]) {
        yield* operativeToPrincipal.send(message as OperativeOutgoing);
      },

      *stream() {
        return principalToOperative as Stream<PrincipalIncoming | OperativeIncoming, void>;
      },
    };
  }

  return [MemoryPrincipal, MemoryOperative];
}
