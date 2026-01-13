/**
 * Shared Test Utilities for Durable Streams
 *
 * Re-exports library implementations and provides test-specific helpers:
 * - createMockLLMStream: Simulates LLM token streaming with delays
 * - consumeResponse: Helper to consume Response as TokenFrames
 */
import { resource, sleep } from 'effection'
import type { Operation, Stream } from 'effection'
import type { TokenFrame } from '../types.ts'

// Re-export library implementations for test convenience
export {
  createInMemoryBuffer,
  createInMemoryBufferStore,
  createInMemoryRegistryStore,
} from '../in-memory-store.ts'

export { createPullStream, writeFromStreamToBuffer } from '../pull-stream.ts'

export { createWebStreamFromBuffer } from '../web-stream-bridge.ts'

// Re-export DI helpers for test convenience
export {
  setupInMemoryDurableStreams,
  setupDurableStreams,
  type DurableStreamsSetup,
} from '../setup.ts'

export {
  useSessionRegistry,
  useTokenBufferStore,
  useSessionRegistryStore,
} from '../use.ts'

// =============================================================================
// MOCK LLM STREAM
// =============================================================================

export interface MockLLMStreamOptions {
  tokenDelayMs?: number
}

/**
 * Simulates an LLM that emits tokens with realistic timing.
 * Tokens are word-based (spaces preserved).
 */
export function createMockLLMStream(
  message: string,
  options: MockLLMStreamOptions = {}
): Stream<string, void> {
  const { tokenDelayMs = 10 } = options

  return resource(function* (provide) {
    // Tokenize message (simple word-based tokenization)
    const words = message.split(' ')
    const tokens: string[] = []
    for (let i = 0; i < words.length; i++) {
      tokens.push(i === 0 ? words[i]! : ' ' + words[i])
    }

    let index = 0

    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        if (tokenDelayMs > 0) {
          yield* sleep(tokenDelayMs)
        }

        if (index < tokens.length) {
          const token = tokens[index++]!
          return { done: false, value: token }
        }
        return { done: true, value: undefined }
      },
    })
  })
}

// =============================================================================
// MOCK CLIENT HELPERS
// =============================================================================

/**
 * Result from consuming a streaming response.
 */
export interface ClientResult {
  tokens: string[]
  frames: TokenFrame<string>[]
  fullMessage: string
  timing: {
    firstTokenMs: number
    totalMs: number
  }
}

/**
 * Simulates a client consuming a Response/ReadableStream.
 * Returns collected tokens and metadata for assertions.
 */
export async function consumeResponse(response: Response): Promise<ClientResult> {
  const startTime = Date.now()
  let firstTokenTime = 0
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const frames: TokenFrame<string>[] = []
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      if (buffer.trim()) {
        frames.push(JSON.parse(buffer.trim()))
      }
      break
    }

    if (firstTokenTime === 0) {
      firstTokenTime = Date.now()
    }

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()!
    for (const line of lines) {
      if (line.trim()) {
        frames.push(JSON.parse(line))
      }
    }
  }

  const endTime = Date.now()
  const tokens = frames.map((f) => f.token)

  return {
    tokens,
    frames,
    fullMessage: tokens.join(''),
    timing: {
      firstTokenMs: firstTokenTime - startTime,
      totalMs: endTime - startTime,
    },
  }
}
