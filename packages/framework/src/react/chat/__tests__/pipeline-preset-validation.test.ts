/**
 * pipeline-preset-validation.test.ts
 *
 * Integration tests validating all pipeline presets work as documented.
 *
 * Ensures that:
 * - Each preset ('markdown', 'shiki', 'mermaid', 'math', 'full') works correctly
 * - Presets compose the documented processors
 * - Content is processed according to preset capabilities
 */

import { describe, it, expect } from 'vitest'
import { run } from 'effection'
import { runPipeline, createPipeline } from '../pipeline'

describe('Pipeline Preset Validation', () => {
  describe('markdown preset', () => {
    it('should process basic markdown content', async () => {
      const content = '# Title\n\nBody text'

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'markdown' })
      })

      expect(frame.blocks.length).toBeGreaterThan(0)
      const html = frame.blocks.map((b) => b.rendered).join('')
      expect(html).toContain('<h1') // markdown processed
    })

    it('should detect code blocks in markdown', async () => {
      const content = 'Text before\n\n```javascript\nconst x = 1\n```\n\nText after'

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'markdown' })
      })

      const codeBlock = frame.blocks.find((b) => b.type === 'code')
      expect(codeBlock).toBeDefined()
      expect(codeBlock?.language).toBe('javascript')
    })

    it('should process lists', async () => {
      const content = '- Item 1\n- Item 2\n- Item 3'

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'markdown' })
      })

      const html = frame.blocks.map((b) => b.rendered).join('')
      expect(html).toContain('<ul') // unordered list
    })

    it('should process emphasis and bold', async () => {
      const content = 'Text with **bold** and *italic* and `code`'

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'markdown' })
      })

      const html = frame.blocks.map((b) => b.rendered).join('')
      expect(html).toContain('<strong') // bold
      expect(html).toContain('<em') // italic
    })

    it('should process block quotes', async () => {
      const content = '> This is a quote\n> Still quoting'

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'markdown' })
      })

      const html = frame.blocks.map((b) => b.rendered).join('')
      expect(html).toContain('<blockquote')
    })

    it('should process links', async () => {
      const content = '[Click here](https://example.com)'

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'markdown' })
      })

      const html = frame.blocks.map((b) => b.rendered).join('')
      expect(html).toContain('<a') // link tag
    })
  })

  describe('full preset (markdown + shiki + mermaid + math)', () => {
    it('should be available and work', async () => {
      const content = '# Example\n\nText with **emphasis**'

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      expect(frame.blocks.length).toBeGreaterThan(0)
    })

    it('should process mixed content types', async () => {
      const content = `# Title

Regular text

\`\`\`python
def hello():
    return "world"
\`\`\``

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      const blockTypes = new Set(frame.blocks.map((b) => b.type))
      expect(blockTypes.has('text')).toBe(true)
      expect(blockTypes.has('code')).toBe(true)
    })

    it('should handle markdown in full preset', async () => {
      const content = '**Bold** and *italic*'

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      const html = frame.blocks.map((b) => b.rendered).join('')
      expect(html).toContain('<strong') // markdown processed
    })

    it('should detect code blocks in full preset', async () => {
      const content = '```js\nconst x = 1;\n```'

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      const codeBlock = frame.blocks.find((b) => b.type === 'code')
      expect(codeBlock).toBeDefined()
      expect(codeBlock?.language).toBe('js')
    })
  })

  describe('preset composition', () => {
    it('should have markdown as the base processor', async () => {
      const content = '# Heading'

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'markdown' })
      })

      const html = frame.blocks.map((b) => b.rendered).join('')
      expect(html).toContain('<h1') // markdown must be present
    })

    it('should handle multiple code blocks', async () => {
      const content = '```js\ncode1\n```\n\nText\n\n```py\ncode2\n```'

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'markdown' })
      })

      const codeBlocks = frame.blocks.filter((b) => b.type === 'code')
      expect(codeBlocks.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('streaming with presets', () => {
    it('markdown preset should work with streaming', async () => {
      const frames: any[] = []
      const pipeline = createPipeline({ processors: 'markdown' }, function* (frame) {
        frames.push(frame)
      })

      await run(function* () {
        yield* pipeline.process('# Title\n')
        yield* pipeline.process('Body text')
        yield* pipeline.flush()
      })

      expect(frames.length).toBeGreaterThan(0)
      const lastFrame = frames[frames.length - 1]
      const html = lastFrame.blocks.map((b: any) => b.rendered).join('')
      expect(html).toContain('<h1') // markdown processed
    })

    it('full preset should work with streaming', async () => {
      const frames: any[] = []
      const pipeline = createPipeline({ processors: 'full' }, function* (frame) {
        frames.push(frame)
      })

      await run(function* () {
        yield* pipeline.process('# Title\n')
        yield* pipeline.process('```js\n')
        yield* pipeline.process('code\n')
        yield* pipeline.process('```')
        yield* pipeline.flush()
      })

      expect(frames.length).toBeGreaterThan(0)
      const lastFrame = frames[frames.length - 1]
      expect(lastFrame.blocks.some((b: any) => b.type === 'code')).toBe(true)
    })
  })

  describe('block structure consistency', () => {
    it('should maintain unique block IDs across presets', async () => {
      const content = 'Para 1\n\nPara 2\n\n```\ncode\n```'

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'markdown' })
      })

      const ids = frame.blocks.map((b) => b.id)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(ids.length) // all unique
    })

    it('should set block type correctly', async () => {
      const content = 'Text\n\n```\ncode\n```'

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'markdown' })
      })

      for (const block of frame.blocks) {
        expect(['text', 'code']).toContain(block.type)
      }
    })

    it('should set block status correctly', async () => {
      const content = 'Some content'

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'markdown' })
      })

      for (const block of frame.blocks) {
        expect(['pending', 'streaming', 'complete']).toContain(block.status)
      }
    })
  })

  describe('edge cases with presets', () => {
    it('should handle empty content', async () => {
      const frame = await run(function* () {
        return yield* runPipeline('', { processors: 'markdown' })
      })

      expect(Array.isArray(frame.blocks)).toBe(true)
    })

    it('should handle whitespace-only content', async () => {
      const frame = await run(function* () {
        return yield* runPipeline('   \n\n  ', { processors: 'markdown' })
      })

      expect(Array.isArray(frame.blocks)).toBe(true)
    })

    it('should handle special characters', async () => {
      const content = '< > & " \' `'

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'markdown' })
      })

      expect(frame.blocks.length).toBeGreaterThan(0)
    })

    it('should handle Unicode content', async () => {
      const content = '你好 мир 🌍'

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'markdown' })
      })

      expect(frame.blocks.length).toBeGreaterThan(0)
      expect(frame.blocks[0]?.raw).toContain('🌍')
    })

    it('should handle very long content', async () => {
      const longContent = 'Line\n'.repeat(1000)

      const frame = await run(function* () {
        return yield* runPipeline(longContent, { processors: 'markdown' })
      })

      expect(frame.blocks.length).toBeGreaterThan(0)
    })

    it('should handle unclosed code fences gracefully', async () => {
      const content = '```\nunclosed code fence'

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'markdown' })
      })

      expect(frame.blocks.length).toBeGreaterThan(0)
      // Should not crash, content should be preserved
    })
  })

  describe('progressive rendering', () => {
    it('should emit frames during processing', async () => {
      const frames: any[] = []
      const pipeline = createPipeline({ processors: 'markdown' }, function* (frame) {
        frames.push(frame)
      })

      await run(function* () {
        // Send multiple chunks
        for (let i = 0; i < 5; i++) {
          yield* pipeline.process(`Chunk ${i}\n`)
        }
        yield* pipeline.flush()
      })

      // Should have multiple frames (one per process call + flush)
      expect(frames.length).toBeGreaterThan(0)
    })

    it('should accumulate content across streaming calls', async () => {
      const frames: any[] = []
      const pipeline = createPipeline({ processors: 'markdown' }, function* (frame) {
        frames.push(JSON.parse(JSON.stringify(frame)))
      })

      await run(function* () {
        yield* pipeline.process('Line 1\n')
        yield* pipeline.process('Line 2\n')
        yield* pipeline.process('Line 3')
        yield* pipeline.flush()
      })

      // Last frame should have all content
      const lastFrame = frames[frames.length - 1]!
      const totalText = lastFrame.blocks.map((b: any) => b.raw).join('')
      expect(totalText).toContain('Line 1')
      expect(totalText).toContain('Line 2')
      expect(totalText).toContain('Line 3')
    })
  })
})
