/**
 * plugin-pipeline.test.ts
 *
 * Integration tests for the plugin-based rendering pipeline.
 * Tests the full flow: plugins → processor chain → rendering buffer → output.
 *
 * These tests simulate the yo-chat demo setup with shiki + mermaid plugins.
 */
import { describe, it, expect } from 'vitest'
import { run, createChannel, spawn, each, sleep } from 'effection'
import type { ChatPatch, BufferRenderablePatch, BufferSettledPatch } from '../types'
import { renderingBufferTransform } from '../core/rendering-buffer'
import { resolvePlugins } from '../plugins/loader'
import { createProcessorChain } from '../processor-chain'
import { codeFence, paragraph, line } from '../settlers'
import { shikiPlugin } from '../plugins/shiki'
import { mermaidPlugin } from '../plugins/mermaid'
import { markdownPlugin } from '../plugins/markdown'

/**
 * Helper to run the rendering pipeline and collect output patches.
 */
async function runPipeline(
  chunks: string[],
  options: {
    settler?: typeof codeFence | typeof paragraph | typeof line
    processor?: ReturnType<typeof createProcessorChain>
  } = {}
): Promise<ChatPatch[]> {
  return run(function* () {
    const input = createChannel<ChatPatch, void>()
    const output = createChannel<ChatPatch, void>()
    const collected: ChatPatch[] = []

    // Collect output patches
    yield* spawn(function* () {
      for (const patch of yield* each(output)) {
        collected.push(patch)
        yield* each.next()
      }
    })

    // Start the transform
    yield* spawn(function* () {
      yield* renderingBufferTransform({
        settler: options.settler ?? paragraph,
        processor: options.processor,
      })(input, output)
    })

    yield* sleep(10)

    // Send streaming_start
    yield* input.send({ type: 'streaming_start' })

    // Send chunks
    for (const chunk of chunks) {
      yield* input.send({ type: 'streaming_text', content: chunk })
      yield* sleep(5)
    }

    // Send streaming_end
    yield* input.send({ type: 'streaming_end' })

    // Close and wait for processing
    input.close()
    yield* sleep(50)

    return collected
  })
}

/**
 * Get only buffer_renderable patches from output.
 */
function getRenderablePatches(patches: ChatPatch[]): BufferRenderablePatch[] {
  return patches.filter((p): p is BufferRenderablePatch => p.type === 'buffer_renderable')
}

/**
 * Get only buffer_settled patches from output.
 */
function getSettledPatches(patches: ChatPatch[]): BufferSettledPatch[] {
  return patches.filter((p): p is BufferSettledPatch => p.type === 'buffer_settled')
}

describe('plugin-pipeline', () => {
  describe('single plugin: markdownPlugin', () => {
    it('should render simple markdown text', async () => {
      const resolved = resolvePlugins([markdownPlugin])
      const processorChain = createProcessorChain(resolved.processors)

      const output = await runPipeline(
        ['Hello ', 'world!\n\n', 'More text.'],
        {
          settler: paragraph,
          processor: processorChain,
        }
      )

      const renderables = getRenderablePatches(output)
      expect(renderables.length).toBeGreaterThan(0)

      // Check that the final output has HTML
      const lastRenderable = renderables[renderables.length - 1]!
      expect(lastRenderable.html).toBeDefined()
      expect(lastRenderable.html).toContain('Hello world!')
    })
  })

  describe('single plugin: shikiPlugin', () => {
    it('should handle markdown with code fence', async () => {
      const resolved = resolvePlugins([shikiPlugin])
      const processorChain = createProcessorChain(resolved.processors)

      // Simulate streaming a code fence line by line
      const chunks = [
        'Here is some code:\n\n',
        '```javascript\n',
        'const x = 1;\n',
        '```\n\n',
        'Done.',
      ]

      const output = await runPipeline(chunks, {
        settler: codeFence,
        processor: processorChain,
      })

      const renderables = getRenderablePatches(output)
      expect(renderables.length).toBeGreaterThan(0)

      const lastRenderable = renderables[renderables.length - 1]!
      expect(lastRenderable.html).toBeDefined()

      // Should have code block (shiki uses 'shiki' class)
      expect(lastRenderable.html).toMatch(/pre.*class/)
      
      // Should have the code content (shiki splits into spans)
      expect(lastRenderable.html).toContain('const')
      
      // Should NOT have duplicate code blocks
      const preCount = (lastRenderable.html!.match(/<pre/g) || []).length
      expect(preCount).toBe(1)
    })

    it('should incrementally stream code fence lines', async () => {
      const resolved = resolvePlugins([shikiPlugin])
      const processorChain = createProcessorChain(resolved.processors)

      // Stream line by line
      const chunks = [
        '```javascript\n',
        'const x = 1;\n',
        'const y = 2;\n',
        '```\n',
      ]

      const output = await runPipeline(chunks, {
        settler: codeFence,
        processor: processorChain,
      })

      const renderables = getRenderablePatches(output)

      // Each line should produce a renderable patch
      expect(renderables.length).toBeGreaterThanOrEqual(chunks.length - 1)

      // Check no content duplication in any patch
      for (const patch of renderables) {
        if (patch.html) {
          const xOccurrences = (patch.html.match(/const x = 1/g) || []).length
          const yOccurrences = (patch.html.match(/const y = 2/g) || []).length
          expect(xOccurrences).toBeLessThanOrEqual(1)
          expect(yOccurrences).toBeLessThanOrEqual(1)
        }
      }
    })
  })

  describe('multiple plugins: shiki + mermaid (yo-chat setup)', () => {
    it('should handle markdown text without duplication', async () => {
      const resolved = resolvePlugins([shikiPlugin, mermaidPlugin])
      const processorChain = createProcessorChain(resolved.processors)

      const output = await runPipeline(
        ['Hello world!\n\n', 'Second paragraph.'],
        {
          settler: codeFence,
          processor: processorChain,
        }
      )

      const renderables = getRenderablePatches(output)
      expect(renderables.length).toBeGreaterThan(0)

      const lastRenderable = renderables[renderables.length - 1]!
      expect(lastRenderable.html).toBeDefined()

      // Check no duplication
      const helloOccurrences = (lastRenderable.html!.match(/Hello world/g) || []).length
      expect(helloOccurrences).toBe(1)
    })

    it('should handle code fence without duplication', async () => {
      const resolved = resolvePlugins([shikiPlugin, mermaidPlugin])
      const processorChain = createProcessorChain(resolved.processors)

      const chunks = [
        '```javascript\n',
        'const x = 1;\n',
        '```\n',
      ]

      const output = await runPipeline(chunks, {
        settler: codeFence,
        processor: processorChain,
      })

      const renderables = getRenderablePatches(output)
      const lastRenderable = renderables[renderables.length - 1]!

      expect(lastRenderable?.html).toBeDefined()

      // Shiki HTML-encodes the code with spans
      expect(lastRenderable.html).toContain('const')
      
      // Should NOT have duplicate code blocks
      const preCount = (lastRenderable.html!.match(/<pre/g) || []).length
      expect(preCount).toBe(1)
    })

    it('should handle incremental streaming without content accumulation bug', async () => {
      const resolved = resolvePlugins([shikiPlugin, mermaidPlugin])
      const processorChain = createProcessorChain(resolved.processors)

      // Stream piece by piece - this is where the bug manifests
      const chunks = [
        'Here is ',
        'some text.\n\n',
        '```javascript\n',
        'const a = 1;\n',
        'const b = 2;\n',
        '```\n\n',
        'And more text.',
      ]

      const output = await runPipeline(chunks, {
        settler: codeFence,
        processor: processorChain,
      })

      const renderables = getRenderablePatches(output)

      // Check each renderable for duplication of paragraphs
      for (let i = 0; i < renderables.length; i++) {
        const patch = renderables[i]!
        if (patch.html) {
          // Count occurrences of the paragraph text
          const hereOccurrences = (patch.html.match(/Here is/g) || []).length

          // Should never have more than 1 occurrence of the same text
          expect(hereOccurrences).toBeLessThanOrEqual(1)
          
          // Should never have more than 1 code block
          const preCount = (patch.html.match(/<pre/g) || []).length
          expect(preCount).toBeLessThanOrEqual(1)
        }
      }

      // Final output should have all content
      const lastRenderable = renderables[renderables.length - 1]!
      expect(lastRenderable?.html).toBeDefined()
      
      // Should have the paragraph text
      expect(lastRenderable.html).toContain('Here is')
      
      // Should have the code (shiki encodes it in spans)
      expect(lastRenderable.html).toContain('const')
      
      // Should have the final text
      expect(lastRenderable.html).toContain('And more text')
      
      // Should have exactly one code block
      const preCount = (lastRenderable.html!.match(/<pre/g) || []).length
      expect(preCount).toBe(1)
    })

    it('should handle mermaid diagram without duplication', async () => {
      const resolved = resolvePlugins([shikiPlugin, mermaidPlugin])
      const processorChain = createProcessorChain(resolved.processors)

      const chunks = [
        '```mermaid\n',
        'graph TD\n',
        '  A --> B\n',
        '```\n',
      ]

      const output = await runPipeline(chunks, {
        settler: codeFence,
        processor: processorChain,
      })

      const renderables = getRenderablePatches(output)

      // Check no duplication during streaming
      for (const patch of renderables) {
        if (patch.html) {
          const graphOccurrences = (patch.html.match(/graph TD/g) || []).length
          expect(graphOccurrences).toBeLessThanOrEqual(1)
        }
      }
    })
  })

  describe('processor chain behavior', () => {
    it('should pass context correctly between chained processors', async () => {
      // Create two simple processors that track what they see
      const seenByFirst: string[] = []
      const seenBySecond: string[] = []

      const firstProcessor = () => function* (ctx: any, emit: any) {
        seenByFirst.push(ctx.chunk)
        yield* emit({ raw: ctx.chunk, html: `<first>${ctx.chunk}</first>` })
      }

      const secondProcessor = () => function* (ctx: any, emit: any) {
        seenBySecond.push(ctx.chunk)
        yield* emit({ raw: ctx.chunk, html: `<second>${ctx.chunk}</second>` })
      }

      const chain = createProcessorChain([firstProcessor, secondProcessor])

      const output = await runPipeline(
        ['Hello\n\n', 'World'],
        {
          settler: paragraph,
          processor: chain,
        }
      )

      // Both processors should see the same chunks
      expect(seenByFirst.length).toBeGreaterThan(0)
      expect(seenByFirst).toEqual(seenBySecond)
    })
  })
})
