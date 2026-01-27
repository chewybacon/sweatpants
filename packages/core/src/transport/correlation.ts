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
  ProgressMessage,
  ResponseMessage,
  PrincipalIncoming,
  ElicitResponse,
  NotifyResponse,
} from "../types/transport.ts";

/**
 * A correlated transport that maps requests to response streams.
 */
export interface CorrelatedTransport {
  /**
   * Send a request and get a stream of progress updates that closes with the final response.
   */
  request<TProgress = unknown, TResponse extends ElicitResponse | NotifyResponse = ElicitResponse | NotifyResponse>(
    message: TransportRequest
  ): Stream<TProgress, TResponse>;
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
    request<TProgress, TResponse extends ElicitResponse | NotifyResponse>(
      message: TransportRequest
    ): Stream<TProgress, TResponse> {
      return resource(function* (provide) {
        const channel = createChannel<TProgress, TResponse>();

        pending.set(message.id, {
          id: message.id,
          channel: channel as Channel<unknown, unknown>,
        });

        try {
          // Send the request
          yield* transport.send(message);

          // Provide the subscription to progress updates
          const subscription: Subscription<TProgress, TResponse> =
            yield* channel;
          yield* provide(subscription);
        } finally {
          pending.delete(message.id);
        }
      });
    },
  };

  return correlated;
}

function isProgressMessage(message: PrincipalIncoming): message is ProgressMessage {
  return message.type === "progress";
}

function isResponseMessage(message: PrincipalIncoming): message is ResponseMessage {
  return message.type === "response";
}
