import { run } from 'effection'
import { describe, expect, it } from 'vitest'

import { createInMemoryBuffer } from '../in-memory-store.ts'
import { toOffsetString } from '../protocol-headers.ts'
import { createSSEEventStream } from '../sse-formatter.ts'

describe('sse-formatter', () => {
  it('formats data and control events for stream tokens', async () => {
    await run(function* () {
      const buffer = createInMemoryBuffer<string>('session-1')
      yield* buffer.append(['hello'])

      const stream = createSSEEventStream(buffer, 0)
      const subscription = yield* stream
      const first = yield* subscription.next()

      expect(first.done).toBe(false)
      expect(first.value).toContain('event: data')
      expect(first.value).toContain('data: hello')
      expect(first.value).toContain('event: control')
      expect(first.value).toContain(`"streamNextOffset":"${toOffsetString(1)}"`)
      expect(first.value).toContain('"streamCursor":"')
    })
  })

  it('emits terminal control event when buffer completes', async () => {
    await run(function* () {
      const buffer = createInMemoryBuffer<string>('session-2')
      yield* buffer.append(['hello'])

      const stream = createSSEEventStream(buffer, 0)
      const subscription = yield* stream

      const first = yield* subscription.next()
      expect(first.done).toBe(false)

      yield* buffer.complete()

      const second = yield* subscription.next()
      expect(second.done).toBe(false)
      expect(second.value).toContain('event: control')
      expect(second.value).toContain(`"streamNextOffset":"${toOffsetString(1)}"`)
      expect(second.value).toContain('"streamClosed":true')
      expect(second.value).toContain('"upToDate":true')

      const third = yield* subscription.next()
      expect(third.done).toBe(true)
    })
  })
})
