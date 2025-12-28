/**
 * tripleBuffer.integration.test.ts
 *
 * Integration tests for rendering buffer transform with real streaming scenarios.
 */
import { describe, it, expect } from 'vitest'
import { run, createChannel, spawn, each, sleep } from 'effection'
import { renderingBufferTransform } from '../core/rendering-buffer'
import { paragraph } from '../settlers'
import { markdown } from '../processors'
import type { ChatPatch } from '../types'

describe('renderingBufferTransform integration', () => {
  it('should process streaming markdown content end-to-end', async () => {
    const result = await run(function* () {
      const input = createChannel<ChatPatch, void>()
      const output = createChannel<ChatPatch, void>()

      const receivedPatches: ChatPatch[] = []

      yield* spawn(function* () {
        for (const patch of yield* each(output)) {
          receivedPatches.push(patch)
          yield* each.next()
        }
      })

      yield* spawn(function* () {
        yield* renderingBufferTransform({
          settler: paragraph,
          processor: markdown
        })(input, output)
      })

      yield* sleep(10)

      // Simulate streaming markdown content
      const content = `# Hello World

This is **bold** text with \`inline code\`.

## Second Section

- List item 1
- List item 2

End of content.`

      yield* input.send({ type: 'streaming_start' })

      // Stream content character by character
      for (const char of content) {
        yield* input.send({ type: 'streaming_text', content: char })
        yield* sleep(1) // Small delay to simulate real streaming
      }

      yield* input.send({ type: 'streaming_end' })
      input.close()
      yield* sleep(10)

      return receivedPatches
    })

    // Verify we get the expected patch sequence
    const patchTypes = result.map(p => p.type)

    // Should have streaming patches
    expect(patchTypes).toContain('streaming_start')
    expect(patchTypes).toContain('streaming_text')
    expect(patchTypes).toContain('streaming_end')

    // Should have buffer patches
    expect(patchTypes).toContain('buffer_raw')
    expect(patchTypes).toContain('buffer_settled')
    expect(patchTypes).toContain('buffer_renderable')

    // Should have processed content
    const renderablePatches = result.filter(p => p.type === 'buffer_renderable')
    expect(renderablePatches.length).toBeGreaterThan(0)

    // Last renderable patch should contain the full processed content
    const lastRenderable = renderablePatches[renderablePatches.length - 1]
    expect((lastRenderable as any).html).toContain('<h1>Hello World</h1>')
    expect((lastRenderable as any).html).toContain('<strong>bold</strong>')
    expect((lastRenderable as any).html).toContain('<code>inline code</code>')
  })

  it('should handle code fence streaming with line-by-line processing', async () => {
    const result = await run(function* () {
      const input = createChannel<ChatPatch, void>()
      const output = createChannel<ChatPatch, void>()

      const receivedPatches: ChatPatch[] = []

      yield* spawn(function* () {
        for (const patch of yield* each(output)) {
          receivedPatches.push(patch)
          yield* each.next()
        }
      })

      // Use line settler for code fence scenario
      yield* spawn(function* () {
        yield* renderingBufferTransform({
          settler: () => function* (ctx) {
            // Simple line-based settler
            if (ctx.pending.includes('\n')) {
              const lines = ctx.pending.split('\n')
              for (let i = 0; i < lines.length - 1; i++) {
                yield lines[i] + '\n'
              }
              // Don't yield incomplete last line
            }
          },
          processor: markdown
        })(input, output)
      })

      yield* sleep(10)

      const content = `Here is some code:

\`\`\`javascript
function hello() {
  console.log('Hello World!')
  return 'done'
}
\`\`\`

End of example.`

      yield* input.send({ type: 'streaming_start' })

      for (const char of content) {
        yield* input.send({ type: 'streaming_text', content: char })
        yield* sleep(1)
      }

      yield* input.send({ type: 'streaming_end' })
      input.close()
      yield* sleep(10)

      return receivedPatches
    })

    // Should have multiple buffer_settled patches for line-by-line processing
    const settledPatches = result.filter(p => p.type === 'buffer_settled')
    expect(settledPatches.length).toBeGreaterThan(1)

    // Should have renderable patches
    const renderablePatches = result.filter(p => p.type === 'buffer_renderable')
    expect(renderablePatches.length).toBeGreaterThan(0)

    // Final renderable should contain processed code
    const lastRenderable = renderablePatches[renderablePatches.length - 1]
    expect((lastRenderable as any).html).toContain('<pre><code')
  })

  it('should maintain buffer state across multiple streaming sessions', async () => {
    const result = await run(function* () {
      const input = createChannel<ChatPatch, void>()
      const output = createChannel<ChatPatch, void>()

      const receivedPatches: ChatPatch[] = []

      yield* spawn(function* () {
        for (const patch of yield* each(output)) {
          receivedPatches.push(patch)
          yield* each.next()
        }
      })

      yield* spawn(function* () {
        yield* renderingBufferTransform({
          settler: paragraph
        })(input, output)
      })

      yield* sleep(10)

      // First streaming session
      yield* input.send({ type: 'streaming_start' })
      yield* input.send({ type: 'streaming_text', content: 'First message.\n\n' })
      yield* input.send({ type: 'streaming_end' })

      yield* sleep(5)

      // Second streaming session
      yield* input.send({ type: 'streaming_start' })
      yield* input.send({ type: 'streaming_text', content: 'Second message.\n\n' })
      yield* input.send({ type: 'streaming_end' })

      input.close()
      yield* sleep(10)

      return receivedPatches
    })

    // Should have patches from both sessions
    const settledPatches = result.filter(p => p.type === 'buffer_settled')
    expect(settledPatches).toHaveLength(2)

    // First settled patch should be just the first message
    expect(settledPatches[0]).toMatchObject({
      type: 'buffer_settled',
      content: 'First message.\n\n',
      prev: '',
      next: 'First message.\n\n'
    })

    // Second settled patch should be just the second message (buffers reset per session)
    expect(settledPatches[1]).toMatchObject({
      type: 'buffer_settled',
      content: 'Second message.\n\n',
      prev: '',
      next: 'Second message.\n\n'
    })
  })
})