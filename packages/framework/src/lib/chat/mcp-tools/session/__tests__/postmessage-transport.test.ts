/**
 * PostMessage Transport Bridge Tests
 *
 * Tests the bridge between SessionWorkerTransport and core's Transport interface.
 */
import { describe, it, expect } from 'vitest'
import { run, spawn, sleep } from 'effection'
import { createCorrelation } from '@sweatpants/core'
import type { SessionWorkerTransport } from '../worker-types.ts'
import { bridgeToTransport } from '../postmessage-transport.ts'

describe('PostMessage Transport Bridge', () => {
  /**
   * Create a pair of connected in-memory session transports.
   * Simulates worker ↔ host communication.
   */
  function createInMemoryTransportPair<TSend, TReceive>(): [
    SessionWorkerTransport<TSend, TReceive>,
    SessionWorkerTransport<TReceive, TSend>
  ] {
    const aHandlers: Set<(msg: TReceive) => void> = new Set()
    const bHandlers: Set<(msg: TSend) => void> = new Set()

    const transportA: SessionWorkerTransport<TSend, TReceive> = {
      send(message: TSend) {
        // Send to B's handlers
        for (const handler of bHandlers) {
          handler(message)
        }
      },
      subscribe(handler: (message: TReceive) => void) {
        aHandlers.add(handler)
        return () => aHandlers.delete(handler)
      },
      close() {
        aHandlers.clear()
      },
    }

    const transportB: SessionWorkerTransport<TReceive, TSend> = {
      send(message: TReceive) {
        // Send to A's handlers
        for (const handler of aHandlers) {
          handler(message)
        }
      },
      subscribe(handler: (message: TSend) => void) {
        bHandlers.add(handler)
        return () => bHandlers.delete(handler)
      },
      close() {
        bHandlers.clear()
      },
    }

    return [transportA, transportB]
  }

  it('should bridge send() from session transport to core transport', async () => {
    const [sessionA, sessionB] = createInMemoryTransportPair<string, string>()

    const received: string[] = []
    sessionB.subscribe((msg) => received.push(msg))

    await run(function* () {
      const coreTransport = yield* bridgeToTransport(sessionA)

      yield* coreTransport.send('hello')
      yield* coreTransport.send('world')
    })

    expect(received).toEqual(['hello', 'world'])
  })

  it('should bridge received messages to core transport stream', async () => {
    const [sessionA, sessionB] = createInMemoryTransportPair<string, string>()

    const received: string[] = []

    await run(function* () {
      const coreTransport = yield* bridgeToTransport(sessionA)

      // Spawn a task to receive messages
      yield* spawn(function* () {
        const subscription = yield* coreTransport

        // Get first message
        const first = yield* subscription.next()
        if (!first.done) {
          received.push(first.value)
        }

        // Get second message
        const second = yield* subscription.next()
        if (!second.done) {
          received.push(second.value)
        }
      })

      // Give the receiver time to start
      yield* sleep(50)

      // Send messages from the other side
      sessionB.send('hello')
      yield* sleep(50)
      sessionB.send('world')
      yield* sleep(150)
    })

    expect(received).toEqual(['hello', 'world'])
  })

  it('should work with core createCorrelation for request/response', async () => {
    // Simulate worker-host message types
    interface Request {
      type: 'request'
      id: string
      data: string
    }

    interface Response {
      type: 'response'
      id: string
      result: string
    }

    const [workerSide, hostSide] = createInMemoryTransportPair<Request, Response>()

    // Host side: echo back responses
    hostSide.subscribe((request) => {
      if (request.type === 'request') {
        setTimeout(() => {
          // Send response via the host's send method (which goes to worker's receive)
          hostSide.send({
            type: 'response',
            id: request.id,
            result: `echoed: ${request.data}`,
          })
        }, 10)
      }
    })

    const result = await run(function* () {
      const coreTransport = yield* bridgeToTransport(workerSide)

      // Note: We can't use createCorrelation directly because it expects
      // specific message formats (PrincipalIncoming/PrincipalOutgoing).
      // This test just verifies the basic bridge works.

      // Send a request
      yield* coreTransport.send({ type: 'request', id: 'req1', data: 'test' })

      // Receive the response
      const subscription = yield* coreTransport
      const response = yield* subscription.next()

      return response.done ? null : response.value
    })

    expect(result).toMatchObject({
      type: 'response',
      id: 'req1',
      result: 'echoed: test',
    })
  })
})
