/**
 * PostMessage Transport Adapters
 *
 * Adapts the existing SessionWorkerTransport (send/subscribe/close) to
 * @sweatpants/core's Transport interface (send + Stream).
 *
 * This enables using core's CorrelatedTransport for request/response correlation.
 *
 * ## Architecture
 *
 * Worker ↔ Host communication uses postMessage-style transport.
 * Core's transport uses a Stream model. We bridge by:
 *
 * 1. Spawning a task that subscribes to the session transport
 * 2. Forwarding messages to an Effection channel
 * 3. The channel becomes the Stream for the transport
 *
 * ## Direction
 *
 * Worker (tool execution) = Principal (initiates requests)
 * Host (session manager) = Operative (handles requests, sends responses)
 *
 * @packageDocumentation
 */

import {
  resource,
  createChannel,
  spawn,
  sleep,
  type Operation,
  type Subscription,
} from 'effection'
import type { Transport } from '@sweatpants/core'
import type { SessionWorkerTransport } from './worker-types.ts'

// =============================================================================
// TRANSPORT BRIDGE
// =============================================================================

/**
 * Bridge a SessionWorkerTransport to core's Transport interface.
 *
 * This is the fundamental adapter that makes the two systems compatible.
 * It converts the callback-based subscribe() to an Effection Stream.
 *
 * @param sessionTransport - The existing worker transport (send/subscribe/close)
 * @returns A core Transport (send + Stream)
 */
export function* bridgeToTransport<TSend, TReceive>(
  sessionTransport: SessionWorkerTransport<TSend, TReceive>
): Operation<Transport<TSend, TReceive>> {
  // Create channel to bridge callback → stream
  const incomingChannel = createChannel<TReceive, void>()

  return yield* resource(function* (provide) {
    // Message queue and resolver for bridging callback → effection
    const messageQueue: TReceive[] = []
    let messageResolver: ((msg: TReceive) => void) | null = null

    // Subscribe to session transport
    const unsub = sessionTransport.subscribe((msg) => {
      if (messageResolver) {
        messageResolver(msg)
        messageResolver = null
      } else {
        messageQueue.push(msg)
      }
    })

    // Spawn a task that forwards messages from queue to channel
    yield* spawn(function* () {
      while (true) {
        let msg: TReceive

        if (messageQueue.length > 0) {
          msg = messageQueue.shift()!
        } else {
          // Wait for next message
          msg = yield* waitForMessage()
        }

        yield* incomingChannel.send(msg)
      }

      // Helper to wait for next message from the callback
      function waitForMessage(): Operation<TReceive> {
        return {
          *[Symbol.iterator]() {
            // Check queue first (in case message arrived while we were processing)
            if (messageQueue.length > 0) {
              return messageQueue.shift()!
            }

            // Poll until message arrives
            // This is not ideal but works with Effection's model
            while (true) {
              if (messageQueue.length > 0) {
                return messageQueue.shift()!
              }

              // Create a promise that resolves on next message
              const result = yield* raceWithPromise<TReceive>(
                new Promise<TReceive>((resolve) => {
                  messageResolver = resolve
                }),
                100 // Poll every 100ms as fallback
              )

              if (result !== undefined) {
                return result
              }
            }
          },
        }
      }
    })

    // Get subscription to the incoming channel
    const subscription: Subscription<TReceive, void> = yield* incomingChannel

    // Create the transport
    const transport: Transport<TSend, TReceive> = {
      *[Symbol.iterator]() {
        return subscription
      },

      *send(message: TSend): Operation<void> {
        sessionTransport.send(message)
      },
    }

    try {
      yield* provide(transport)
    } finally {
      unsub()
    }
  })
}

/**
 * Race a promise against a timeout, returning undefined if timeout wins.
 */
function* raceWithPromise<T>(promise: Promise<T>, timeoutMs: number): Operation<T | undefined> {
  let resolved = false
  let result: T | undefined

  promise.then((value) => {
    resolved = true
    result = value
  })

  const deadline = Date.now() + timeoutMs

  while (!resolved && Date.now() < deadline) {
    yield* sleep(10)
  }

  return result
}

// =============================================================================
// MESSAGE TYPE CONVERTERS
// =============================================================================

/**
 * Map MCP elicit response action to core's response status.
 */
export function mapElicitActionToStatus(
  action: string
): 'accepted' | 'declined' | 'cancelled' | 'other' {
  switch (action) {
    case 'accept':
      return 'accepted'
    case 'decline':
      return 'declined'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'other'
  }
}

/**
 * Map core's response status to MCP elicit action.
 */
export function mapStatusToElicitAction(
  status: 'accepted' | 'declined' | 'cancelled' | 'denied' | 'other'
): 'accept' | 'decline' | 'cancel' | 'other' {
  switch (status) {
    case 'accepted':
      return 'accept'
    case 'declined':
      return 'decline'
    case 'cancelled':
      return 'cancel'
    case 'denied':
      return 'other'
    default:
      return 'other'
  }
}
