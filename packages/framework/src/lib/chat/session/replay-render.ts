import type { Operation } from 'effection'
import { createChannel, each, spawn, type Task } from 'effection'
import type { PatchTransform } from './options.ts'
import type { ChatPatch } from '../patches/index.ts'
import type { MessagePart, TextPart, ReasoningPart } from '../types/chat-message.ts'
import { getRenderedFromFrame } from '../types/chat-message.ts'

type ReplayableContentPart = TextPart | ReasoningPart

function composeTransforms(transforms: PatchTransform[]) {
  return function* (input: ReturnType<typeof createChannel<ChatPatch, void>>, output: ReturnType<typeof createChannel<ChatPatch, void>>): Operation<void> {
    if (transforms.length === 0) {
      for (const patch of yield* each(input)) {
        yield* output.send(patch)
        yield* each.next()
      }
      return
    }

    let currentIn = input

    for (let i = 0; i < transforms.length; i++) {
      const transform = transforms[i]!
      const isLast = i === transforms.length - 1
      const nextOut = isLast ? output : createChannel<ChatPatch, void>()
      const source = currentIn
      const dest = nextOut

      yield* spawn(function* () {
        yield* transform(source, dest)
        if (!isLast) {
          yield* dest.close()
        }
      })

      currentIn = nextOut
    }
  }
}

export function* renderReplayMessageParts(
  content: string,
  transforms: PatchTransform[] | undefined,
): Operation<MessagePart[] | undefined> {
  if (!content) {
    return undefined
  }

  if (!transforms || transforms.length === 0) {
    return [{
      id: crypto.randomUUID(),
      type: 'text',
      content,
      rendered: content,
    }]
  }

  const input = createChannel<ChatPatch, void>()
  const output = createChannel<ChatPatch, void>()
  const parts = new Map<string, ReplayableContentPart>()
  const order: string[] = []
  const runComposed = composeTransforms(transforms)

  const transformTask: Task<void> = yield* spawn(function* () {
    yield* runComposed(input, output)
    yield* output.close()
  })

  const collectTask: Task<void> = yield* spawn(function* () {
    for (const patch of yield* each(output)) {
      if ((patch.type === 'part_frame' || patch.type === 'part_end') && (patch.partType === 'text' || patch.partType === 'reasoning')) {
        const existing = parts.get(patch.partId)
        const rendered = getRenderedFromFrame(patch.frame) ?? content

        if (!existing) {
          order.push(patch.partId)
        }

        parts.set(patch.partId, {
          id: patch.partId,
          type: patch.partType,
          content: existing?.content ?? content,
          rendered,
          frame: patch.frame,
        })
      }
      yield* each.next()
    }
  })

  yield* input.send({ type: 'streaming_start' })
  yield* input.send({ type: 'streaming_text', content })
  yield* input.send({ type: 'streaming_end' })
  yield* input.close()

  yield* transformTask
  yield* collectTask

  return order.map((id) => parts.get(id)!).filter(Boolean)
}
