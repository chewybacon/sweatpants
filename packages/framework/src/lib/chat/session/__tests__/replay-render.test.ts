import { describe, it, expect } from 'vitest'
import { each, run, type Operation } from 'effection'

import { renderReplayMessageParts } from '../replay-render.ts'
import type { PatchTransform } from '../options.ts'
import type { ChatPatch } from '../../patches/index.ts'
import type { Frame } from '../../frame.ts'

function frameFromText(text: string): Frame {
  return {
    id: 'test-frame',
    timestamp: Date.now(),
    activeBlockIndex: null,
    trace: [],
    blocks: [{
      id: 'test-block',
      type: 'text',
      raw: text,
      rendered: text,
      status: 'complete',
      renderPass: 'full',
    }],
  }
}

const textPartTransform: PatchTransform = function* (input, output): Operation<void> {
  let text = ''
  for (const patch of yield* each(input)) {
    if (patch.type === 'streaming_text') {
      text += patch.content
      yield* output.send({
        type: 'part_frame',
        partType: 'text',
        partId: 'test-text',
        frame: frameFromText(text),
      } satisfies ChatPatch)
    }
    if (patch.type === 'streaming_end') {
      yield* output.send({
        type: 'part_end',
        partType: 'text',
        partId: 'test-text',
        frame: frameFromText(text),
      } satisfies ChatPatch)
    }
    yield* each.next()
  }
}

describe('renderReplayMessageParts', () => {
  it('replays content through pipeline transforms without dropping frames', async () => {
    const parts = await run(function* () {
      return yield* renderReplayMessageParts('Hello threaded world', [textPartTransform])
    })

    expect(parts).toBeTruthy()
    expect(parts).toHaveLength(1)
    expect(parts?.[0]?.type).toBe('text')
    if (!parts || parts[0]?.type !== 'text') {
      throw new Error('expected replayed text part')
    }
    expect(parts[0].rendered).toContain('Hello threaded world')
  })
})
