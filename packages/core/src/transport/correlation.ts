import {
  resource,
  createChannel,
  spawn,
  type Operation,
  type Stream,
  type Channel,
  type Subscription,
} from "effection";
import type {
  PrincipalTransport,
  TransportRequest,
  PrincipalIncoming,
  RequestKind,
  ResponseByKind,
} from "../types/transport.ts";
import {
  isProgressMessage,
  isResponseMessage,
} from "../types/transport.ts";

/**
 * A correlated transport that maps requests to response streams.
 * Response type is determined by the request kind via ResponseByKind mapping.
 */
export interface CorrelatedTransport {
  /**
   * Send a request and get a stream of progress updates that closes with the final response.
   * The response type is automatically determined by the request's kind.
   */
  request<K extends RequestKind, TProgress = unknown>(
    message: TransportRequest<K>
  ): Stream<TProgress, ResponseByKind[K]>;
}

interface PendingRequest {
  id: string;
  channel: Channel<unknown, unknown>;
}

/**
 * Wraps a PrincipalTransport with request/response correlation.
 *
 * The returned transport's `request()` method sends a message and returns a stream
 * that yields progress updates and closes with the final response.
 *
 * @param transport - The underlying transport to wrap
 * @returns A correlated transport
 */
export function* createCorrelation(
  transport: PrincipalTransport
): Operation<CorrelatedTransport> {
  const pending = new Map<string, PendingRequest>();

  // Spawn a task to route incoming messages to the correct pending request
  yield* spawn(function* () {
    const subscription: Subscription<PrincipalIncoming, void> =
      yield* transport;

    let result = yield* subscription.next();
    while (!result.done) {
      const message = result.value;

      if (isProgressMessage(message)) {
        const request = pending.get(message.id);
        if (request) {
          yield* request.channel.send(message.data);
        }
      } else if (isResponseMessage(message)) {
        const request = pending.get(message.id);
        if (request) {
          yield* request.channel.close(message.response);
          pending.delete(message.id);
        }
      }

      result = yield* subscription.next();
    }
  });

  const correlated: CorrelatedTransport = {
    request<K extends RequestKind, TProgress = unknown>(
      message: TransportRequest<K>
    ): Stream<TProgress, ResponseByKind[K]> {
      return resource(function* (provide) {
        const channel = createChannel<TProgress, ResponseByKind[K]>();

        try {
          // Provide the subscription to progress updates
          const subscription: Subscription<TProgress, ResponseByKind[K]> =
            yield* channel;
          pending.set(message.id, {
            id: message.id,
            channel: channel as Channel<unknown, unknown>,
          });

          // Send the request after the subscription is established
          yield* transport.send(message);
          yield* provide(subscription);
        } finally {
          pending.delete(message.id);
        }
      });
    },
  };

  return correlated;
}
