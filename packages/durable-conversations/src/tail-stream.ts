import { toOffsetString } from '@sweatpants/durable-streams'
import { call, race, resource, type Operation, type Stream } from 'effection'

import type { ConversationEvent } from './event-types.ts'
import type { ConversationStore } from './conversation-store.ts'

export interface EventFrame {
  offset: string
  event: ConversationEvent
}

export function createFrameStream(frames: EventFrame[]): Stream<EventFrame, void> {
  return resource(function* (provide) {
    let index = 0
    yield* provide({
      *next(): Operation<IteratorResult<EventFrame, void>> {
        if (index >= frames.length) {
          return { done: true, value: undefined }
        }
        const value = frames[index]
        index += 1
        return { done: false, value: value! }
      },
    })
  })
}

export function createTailFrameStream(params: {
  store: ConversationStore
  conversationId: string
  startOffset: number
  completion: Promise<void>
}): Stream<EventFrame, void> {
  const { store, conversationId, startOffset, completion } = params

  return resource(function* (provide) {
    const queue: EventFrame[] = []
    let done = false
    let completionSettled = false
    let completionError: unknown = null

    let cursor = startOffset

    completion.then(
      () => {
        completionSettled = true
      },
      (error) => {
        completionError = error
        completionSettled = true
      },
    )

    yield* provide({
      *next(): Operation<IteratorResult<EventFrame, void>> {
        if (queue.length > 0) {
          return { done: false, value: queue.shift()! }
        }

        if (done) {
          return { done: true, value: undefined }
        }

        if (completionError) {
          throw completionError
        }

        const events = yield* store.read(conversationId, cursor)
        if (events.length > 0) {
          for (const [index, event] of events.entries()) {
            const offset = cursor + index + 1
            queue.push({
              offset: toOffsetString(offset),
              event,
            })
          }
          cursor += events.length
          return { done: false, value: queue.shift()! }
        }

        if (completionSettled) {
          done = true
          return { done: true, value: undefined }
        }

        yield* race([
          (function* (): Operation<'changed'> {
            yield* store.waitForChange(conversationId, cursor)
            return 'changed'
          })(),
          (function* (): Operation<'done'> {
            yield* call(() => completion)
            return 'done'
          })(),
        ])

        return yield* this.next()
      },
    })
  })
}
