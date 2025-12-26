import type { Operation, Stream } from 'effection'
import { resource, call, ensure } from 'effection'

export interface ParseNDJSONOptions {
  /** Optional abort signal to cancel reading */
  signal?: AbortSignal
}

/**
 * Parse a ReadableStream of NDJSON into an Effection Stream of objects.
 * Handles partial lines across chunk boundaries.
 */
export function parseNDJSON<T>(
  readable: ReadableStream<Uint8Array>,
  options: ParseNDJSONOptions = {}
): Stream<T, void> {
  const { signal } = options
  return resource(function* (provide) {
    const reader = readable.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    yield* ensure(function* () {
      yield* call(() => reader.cancel())
    })

    yield* provide({
      *next(): Operation<IteratorResult<T, void>> {
        while (true) {
          // Check abort signal before processing
          if (signal?.aborted) {
            return { done: true, value: undefined }
          }

          // Try to extract a complete line from buffer
          const newlineIndex = buffer.indexOf('\n')
          if (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).trim()
            buffer = buffer.slice(newlineIndex + 1)

            if (line) {
              const parsed = JSON.parse(line) as T
              return { done: false, value: parsed }
            }
            continue // Empty line, try next
          }

          // Need more data
          const { done, value } = yield* call(() => reader.read())

          if (done) {
            // Process any remaining buffer content
            const remaining = buffer.trim()
            if (remaining) {
              buffer = ''
              const parsed = JSON.parse(remaining) as T
              return { done: false, value: parsed }
            }
            return { done: true, value: undefined }
          }

          buffer += decoder.decode(value, { stream: true })
        }
      },
    })
  })
}
