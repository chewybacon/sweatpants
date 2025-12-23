import type { Operation, Stream } from 'effection'
import { resource, call, ensure } from 'effection'

/**
 * An SSE event parsed from a stream
 */
export interface SSEEvent {
  event?: string
  data: string
  id?: string
  retry?: number
}

/**
 * Parse a ReadableStream of SSE (Server-Sent Events) into an Effection Stream of events.
 * Handles partial lines across chunk boundaries.
 * Stops when stream ends or when data is "[DONE]" (OpenAI convention).
 */
export function parseSSE(
  readable: ReadableStream<Uint8Array>
): Stream<SSEEvent, void> {
  return resource(function* (provide) {
    const reader = readable.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    yield* ensure(function* () {
      yield* call(() => reader.cancel())
    })

    yield* provide({
      *next(): Operation<IteratorResult<SSEEvent, void>> {
        while (true) {
          // Try to extract a complete event from buffer
          // SSE events are separated by blank lines (\n\n)
          const eventEndIndex = buffer.indexOf('\n\n')

          if (eventEndIndex !== -1) {
            const eventBlock = buffer.slice(0, eventEndIndex)
            buffer = buffer.slice(eventEndIndex + 2)

            const event = parseEventBlock(eventBlock)
            if (event) {
              // OpenAI uses "[DONE]" to signal end of stream
              if (event.data === '[DONE]') {
                return { done: true, value: undefined }
              }
              return { done: false, value: event }
            }
            // Empty event block, continue to next
            continue
          }

          // Need more data
          const { done, value } = yield* call(() => reader.read())

          if (done) {
            // Process any remaining buffer content
            const remaining = buffer.trim()
            if (remaining) {
              buffer = ''
              const event = parseEventBlock(remaining)
              if (event && event.data !== '[DONE]') {
                return { done: false, value: event }
              }
            }
            return { done: true, value: undefined }
          }

          buffer += decoder.decode(value, { stream: true })
        }
      },
    })
  })
}

/**
 * Parse a single SSE event block into an SSEEvent object
 */
function parseEventBlock(block: string): SSEEvent | null {
  const lines = block.split('\n')
  let event: string | undefined
  let data = ''
  let id: string | undefined
  let retry: number | undefined

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      // Accumulate data lines (can be multiple)
      const dataLine = line.slice(5)
      // Remove leading space if present (SSE spec allows one optional space)
      const content = dataLine.startsWith(' ') ? dataLine.slice(1) : dataLine
      if (data) {
        data += '\n' + content
      } else {
        data = content
      }
    } else if (line.startsWith('id:')) {
      id = line.slice(3).trim()
    } else if (line.startsWith('retry:')) {
      const retryValue = parseInt(line.slice(6).trim(), 10)
      if (!isNaN(retryValue)) {
        retry = retryValue
      }
    }
    // Ignore comments (lines starting with :) and unknown fields
  }

  // An event must have data to be valid
  if (!data) {
    return null
  }

  return { event, data, id, retry }
}
