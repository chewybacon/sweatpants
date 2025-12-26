/**
 * processor-chain.test.ts
 *
 * Tests for processor chaining and composition.
 */
import { describe, it, expect } from 'vitest'
import { run } from 'effection'
import { createProcessorChain, mergeProcessorMetadata, mergeProcessorOutputs } from '../processor-chain'
import { markdown, syntaxHighlight } from '../processors'
import type { ProcessorContext, ProcessedOutput } from '../types'

// Helper to run a processor and collect outputs
async function runProcessor(
  processorFactory: () => any,
  ctx: ProcessorContext
): Promise<ProcessedOutput[]> {
  const outputs: ProcessedOutput[] = []

  const emit = (output: ProcessedOutput) => ({
    *[Symbol.iterator]() {
      outputs.push(output)
    }
  })

  await run(function* () {
    const processor = processorFactory()
    yield* processor(ctx, emit)
  })

  return outputs
}

describe('processor-chain', () => {
  describe('createProcessorChain', () => {
    it('should run single processor normally', async () => {
      const chain = createProcessorChain([markdown])
      const ctx: ProcessorContext = {
        chunk: 'hello **world**',
        accumulated: '',
        next: 'hello **world**',
      }

      const outputs = await runProcessor(chain, ctx)

      expect(outputs.length).toBe(1)
      expect(outputs[0].raw).toBe('hello **world**')
      expect(outputs[0].html).toContain('<strong>world</strong>')
    })

    it('should chain markdown + syntax highlighting', async () => {
      const chain = createProcessorChain([markdown, syntaxHighlight])
      const ctx: ProcessorContext = {
        chunk: '```python\nprint("hello")\n```',
        accumulated: '',
        next: '```python\nprint("hello")\n```',
        meta: { inCodeFence: true, language: 'python', fenceStart: true },
      }

      const outputs = await runProcessor(chain, ctx)

      // Should have outputs from the processing
      expect(outputs.length).toBeGreaterThan(0)

      // Check that we got some kind of processed output
      const hasProcessedOutput = outputs.some(o => o.html || o.pass)
      expect(hasProcessedOutput).toBe(true)
    })

    it('should handle empty processor array with passthrough', async () => {
      const chain = createProcessorChain([])
      const ctx: ProcessorContext = {
        chunk: 'raw text',
        accumulated: '',
        next: 'raw text',
      }

      const outputs = await runProcessor(chain, ctx)

      expect(outputs.length).toBe(1)
      expect(outputs[0]).toEqual({ raw: 'raw text' })
    })
  })

  describe('metadata merging', () => {
    it('should merge processor metadata correctly', () => {
      const outputs: ProcessedOutput[] = [
        { raw: 'test', html: '<p>test</p>', pass: 'quick' as const },
        { raw: 'test', highlighted: true, pass: 'full' as const },
        { raw: 'test', final: true },
      ]

      const merged = mergeProcessorMetadata(outputs)

      expect(merged).toEqual({
        html: '<p>test</p>',
        highlighted: true,
        final: true,
        pass: 'full', // Last one wins
      })
    })

    it('should handle empty metadata', () => {
      const outputs: ProcessedOutput[] = [
        { raw: 'test' },
        { raw: 'test' },
      ]

      const merged = mergeProcessorMetadata(outputs)
      expect(merged).toEqual({})
    })
  })

  describe('output merging', () => {
    it('should merge processor outputs correctly', () => {
      const outputs: ProcessedOutput[] = [
        { raw: 'test', html: '<p>test</p>', pass: 'quick' },
        { raw: 'test', highlighted: true, pass: 'full' },
      ]

      const merged = mergeProcessorOutputs(outputs)

      expect(merged).toEqual({
        raw: 'test', // Takes from first output
        html: '<p>test</p>',
        highlighted: true,
        pass: 'full', // Last one wins
      })
    })

    it('should throw on empty outputs', () => {
      expect(() => mergeProcessorOutputs([])).toThrow('Cannot merge empty outputs')
    })
  })
})