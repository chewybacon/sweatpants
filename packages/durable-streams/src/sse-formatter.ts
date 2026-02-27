import { resource, type Operation, type Stream } from 'effection'

import { createPullStream } from './pull-stream.ts'
import { createStreamCursor, toOffsetString } from './protocol-headers.ts'
import type { TokenBuffer } from './types.ts'

function formatSSEData(payload: string): string {
  return `event: data\ndata: ${payload}\n\n`
}

function formatSSEControl(payload: Record<string, unknown>): string {
  return `event: control\ndata: ${JSON.stringify(payload)}\n\n`
}

export function createSSEEventStream(
  buffer: TokenBuffer<string>,
  startLSN: number,
): Stream<string, void> {
  return resource(function* (provide) {
    const pullStream = yield* createPullStream(buffer, startLSN)
    let cursor = startLSN
    let emittedClosed = false

    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        if (emittedClosed) {
          return { done: true, value: undefined }
        }

        const result = yield* pullStream.next()
        if (result.done) {
          emittedClosed = true
          const control = formatSSEControl({
            streamNextOffset: toOffsetString(cursor),
            streamClosed: true,
            upToDate: true,
          })
          return { done: false, value: control }
        }

        const frame = result.value
        cursor = frame.lsn

        const chunk =
          formatSSEData(frame.token) +
          formatSSEControl({
            streamNextOffset: toOffsetString(cursor),
            streamCursor: createStreamCursor(),
          })

        return { done: false, value: chunk }
      },
    })
  })
}
