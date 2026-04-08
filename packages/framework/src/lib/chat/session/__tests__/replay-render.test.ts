import { describe, it, expect } from 'vitest'
import { run } from 'effection'

import { renderReplayMessageParts } from '../replay-render.ts'
import { createPipelineTransform } from '../../../../react/chat/pipeline/index.ts'

describe('renderReplayMessageParts', () => {
  it('replays content through pipeline transforms without dropping frames', async () => {
    const parts = await run(function* () {
      return yield* renderReplayMessageParts('Hello threaded world', [
        createPipelineTransform({ processors: 'full' }),
      ])
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
