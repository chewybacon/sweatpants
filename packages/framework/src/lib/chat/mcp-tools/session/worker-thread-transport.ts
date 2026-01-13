/**
 * Worker Thread Transport Implementation
 *
 * Implements SessionWorkerTransport using Node.js worker_threads.
 * This is the transport used for local development and Node.js deployments.
 *
 * ## Usage
 *
 * ```typescript
 * // Main thread (host)
 * const factory = createWorkerThreadTransportFactory()
 * const transport = yield* factory.create('./tool-session-worker.js', sessionId)
 *
 * transport.send({ type: 'start', toolName: 'greet', params: { name: 'Alice' } })
 * transport.subscribe((msg) => {
 *   if (msg.type === 'sample_request') {
 *     // Handle sampling request
 *     transport.send({ type: 'sample_response', sampleId: msg.sampleId, response: { text: '...' } })
 *   }
 * })
 * ```
 *
 * @packageDocumentation
 */

import { Worker, parentPort, isMainThread } from 'node:worker_threads'
import { resource, call, type Operation } from 'effection'
import type {
  HostTransport,
  WorkerTransport,
  HostToWorkerMessage,
  WorkerToHostMessage,
  SessionWorkerTransportFactory,
  Unsubscribe,
} from './worker-types.ts'

// =============================================================================
// HOST-SIDE TRANSPORT (Main Thread)
// =============================================================================

/**
 * Create a transport for the host (main thread) side.
 *
 * @param worker - The worker thread instance
 * @returns Transport for communicating with the worker
 */
function createHostTransport(worker: Worker): HostTransport {
  const handlers = new Set<(message: WorkerToHostMessage) => void>()

  worker.on('message', (message: WorkerToHostMessage) => {
    for (const handler of handlers) {
      handler(message)
    }
  })

  return {
    send(message: HostToWorkerMessage): void {
      worker.postMessage(message)
    },

    subscribe(handler: (message: WorkerToHostMessage) => void): Unsubscribe {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },

    close(): void {
      worker.terminate()
    },
  }
}

// =============================================================================
// WORKER-SIDE TRANSPORT (Worker Thread)
// =============================================================================

/**
 * Create a transport for the worker side.
 *
 * This should be called from within a worker thread.
 * Uses `parentPort` to communicate with the main thread.
 *
 * @returns Transport for communicating with the host
 * @throws If called from the main thread
 */
export function createWorkerSideTransport(): WorkerTransport {
  if (isMainThread || !parentPort) {
    throw new Error('createWorkerSideTransport must be called from a worker thread')
  }

  const port = parentPort
  const handlers = new Set<(message: HostToWorkerMessage) => void>()

  port.on('message', (message: HostToWorkerMessage) => {
    for (const handler of handlers) {
      handler(message)
    }
  })

  return {
    send(message: WorkerToHostMessage): void {
      port.postMessage(message)
    },

    subscribe(handler: (message: HostToWorkerMessage) => void): Unsubscribe {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },

    close(): void {
      // Worker side doesn't need to close - the host terminates us
    },
  }
}

// =============================================================================
// TRANSPORT FACTORY
// =============================================================================

/**
 * Create a factory for spawning worker thread transports.
 *
 * @returns Factory for creating host transports
 */
export function createWorkerThreadTransportFactory(): SessionWorkerTransportFactory {
  return {
    *create(workerPath: string, _sessionId: string): Operation<HostTransport> {
      return yield* resource<HostTransport>(function* (provide) {
        const worker = new Worker(workerPath)

        // Wait for worker to be ready
        yield* call(() => new Promise<void>((resolve, reject) => {
          const onMessage = (msg: WorkerToHostMessage) => {
            if (msg.type === 'ready') {
              worker.off('message', onMessage)
              worker.off('error', onError)
              resolve()
            }
          }
          const onError = (err: Error) => {
            worker.off('message', onMessage)
            worker.off('error', onError)
            reject(err)
          }
          worker.on('message', onMessage)
          worker.on('error', onError)
        }))

        const transport = createHostTransport(worker)

        try {
          yield* provide(transport)
        } finally {
          transport.close()
        }
      })
    },
  }
}

// =============================================================================
// IN-PROCESS TRANSPORT (For Testing)
// =============================================================================

/**
 * Create a pair of in-process transports for testing.
 *
 * This allows testing the worker protocol without actual worker threads.
 * Messages are delivered synchronously within the same process.
 *
 * @returns A pair of connected transports [host, worker]
 */
export function createInProcessTransportPair(): [HostTransport, WorkerTransport] {
  const hostHandlers = new Set<(message: WorkerToHostMessage) => void>()
  const workerHandlers = new Set<(message: HostToWorkerMessage) => void>()
  let closed = false

  const hostTransport: HostTransport = {
    send(message: HostToWorkerMessage): void {
      if (closed) return
      // Deliver asynchronously to simulate real transport
      queueMicrotask(() => {
        for (const handler of workerHandlers) {
          handler(message)
        }
      })
    },

    subscribe(handler: (message: WorkerToHostMessage) => void): Unsubscribe {
      hostHandlers.add(handler)
      return () => hostHandlers.delete(handler)
    },

    close(): void {
      closed = true
    },
  }

  const workerTransport: WorkerTransport = {
    send(message: WorkerToHostMessage): void {
      if (closed) return
      // Deliver asynchronously to simulate real transport
      queueMicrotask(() => {
        for (const handler of hostHandlers) {
          handler(message)
        }
      })
    },

    subscribe(handler: (message: HostToWorkerMessage) => void): Unsubscribe {
      workerHandlers.add(handler)
      return () => workerHandlers.delete(handler)
    },

    close(): void {
      closed = true
    },
  }

  return [hostTransport, workerTransport]
}
