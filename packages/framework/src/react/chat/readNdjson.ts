/**
 * readNdjson.ts
 *
 * Async generator primitive for parsing NDJSON from a ReadableStream.
 * This is the foundational streaming primitive - pure async generator,
 * no Effection dependencies.
 *
 * Responsibilities:
 * - Manage TextDecoder + buffer across chunk boundaries
 * - Split by newline and JSON.parse each line
 * - Cleanup reader on completion or abort
 */

export interface ReadNdjsonOptions {
  /** Optional abort signal to cancel reading */
  signal?: AbortSignal
}

/**
 * Parse a ReadableStream of bytes as NDJSON, yielding parsed objects.
 *
 * @example
 * ```ts
 * const response = await fetch('/api/stream')
 * for await (const event of readNdjson<MyEvent>(response.body!)) {
 *   console.log(event)
 * }
 * ```
 */
export async function* readNdjson<T>(
  body: ReadableStream<Uint8Array>,
  options: ReadNdjsonOptions = {}
): AsyncGenerator<T, void, unknown> {
  const { signal } = options
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      // Check abort before reading
      if (signal?.aborted) {
        return
      }

      const { done, value } = await reader.read()

      if (done) {
        // Process any remaining buffer content
        const remaining = buffer.trim()
        if (remaining) {
          yield JSON.parse(remaining) as T
        }
        return
      }

      // Append decoded chunk to buffer
      buffer += decoder.decode(value, { stream: true })

      // Process complete lines
      const lines = buffer.split('\n')
      // Keep the last (potentially incomplete) line in buffer
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed) {
          yield JSON.parse(trimmed) as T
        }
      }
    }
  } finally {
    // Always cancel the reader on exit (normal, error, or abort)
    await reader.cancel().catch(() => {
      // Ignore cancel errors - stream may already be closed
    })
  }
}
