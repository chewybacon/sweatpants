import {
  resource,
  createChannel,
  type Operation,
  type Channel,
  type Subscription,
} from "effection";
import type {
  Transport,
  PrincipalTransport,
  OperativeTransport,
  PrincipalIncoming,
  PrincipalOutgoing,
  OperativeIncoming,
  OperativeOutgoing,
} from "../types/transport.ts";

/**
 * Creates a connected pair of transports for in-memory communication.
 * Useful for testing without network overhead.
 *
 * @returns A tuple of [PrincipalTransport, OperativeTransport] that are connected.
 */
export function* createTransportPair(): Operation<
  [PrincipalTransport, OperativeTransport]
> {
  // Channels for bidirectional communication
  // Principal sends requests → Operative receives them
  const requestChannel: Channel<PrincipalOutgoing, void> =
    createChannel<PrincipalOutgoing, void>();

  // Operative sends responses → Principal receives them
  const responseChannel: Channel<OperativeOutgoing, void> =
    createChannel<OperativeOutgoing, void>();

  const principalTransport: PrincipalTransport = yield* createTransport<
    PrincipalOutgoing,
    PrincipalIncoming
  >(requestChannel, responseChannel);

  const operativeTransport: OperativeTransport = yield* createTransport<
    OperativeOutgoing,
    OperativeIncoming
  >(responseChannel, requestChannel);

  return [principalTransport, operativeTransport];
}

/**
 * Creates a transport from send and receive channels.
 */
function createTransport<TSend, TReceive>(
  sendChannel: Channel<TSend, void>,
  receiveChannel: Channel<TReceive, void>
): Operation<Transport<TSend, TReceive>> {
  return resource(function* (provide) {
    const subscription: Subscription<TReceive, void> = yield* receiveChannel;

    const transport: Transport<TSend, TReceive> = {
      *[Symbol.iterator]() {
        return subscription;
      },
      *send(message: TSend): Operation<void> {
        yield* sendChannel.send(message);
      },
    };

    yield* provide(transport);
  });
}
