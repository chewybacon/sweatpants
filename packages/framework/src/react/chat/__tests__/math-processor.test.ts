/**
 * Tests for the math processor.
 *
 * Verifies:
 * - Inline math detection ($...$)
 * - Block math detection ($$...$$)
 * - Annotation creation
 * - HTML rendering with KaTeX
 */
import { describe, it, expect } from 'vitest'
import { run } from 'effection'
import { runPipeline, createPipeline, markdown, math, shiki } from '../pipeline'

describe('math processor', () => {
  describe('detection', () => {
    it('should detect inline math expressions', async () => {
      const content = `The equation $x^2 + y^2 = z^2$ is the Pythagorean theorem.`

      const frame = await run(function* () {
        return yield* runPipeline(content, {
          processors: [markdown, math],
        })
      })

      // Should have one text block
      expect(frame.blocks).toHaveLength(1)
      const block = frame.blocks[0]!
      expect(block.type).toBe('text')

      // Should have one annotation for the inline math
      expect(block.annotations).toBeDefined()
      expect(block.annotations).toHaveLength(1)

      const annotation = block.annotations![0]!
      expect(annotation.type).toBe('math')
      expect(annotation.subtype).toBe('inline')
      expect(annotation.data?.latex).toBe('x^2 + y^2 = z^2')
    })

    it('should detect block math expressions', async () => {
      const content = `Here is an integral:

$$\\int_0^1 f(x) dx$$

That was the integral.`

      const frame = await run(function* () {
        return yield* runPipeline(content, {
          processors: [markdown, math],
        })
      })

      // Find text blocks with annotations
      const blocksWithMath = frame.blocks.filter(
        (b) => b.type === 'text' && b.annotations && b.annotations.length > 0
      )

      expect(blocksWithMath.length).toBeGreaterThan(0)

      // Find the block annotation
      const blockAnnotation = blocksWithMath
        .flatMap((b) => b.annotations ?? [])
        .find((a) => a.subtype === 'block')

      expect(blockAnnotation).toBeDefined()
      expect(blockAnnotation?.type).toBe('math')
      expect(blockAnnotation?.data?.latex).toContain('\\int_0^1')
    })

    it('should detect multiple math expressions', async () => {
      const content = `When $a = 1$ and $b = 2$, then $a + b = 3$.`

      const frame = await run(function* () {
        return yield* runPipeline(content, {
          processors: [markdown, math],
        })
      })

      const block = frame.blocks[0]!
      expect(block.annotations).toHaveLength(3)

      const latexValues = block.annotations!.map((a) => a.data?.latex)
      expect(latexValues).toContain('a = 1')
      expect(latexValues).toContain('b = 2')
      expect(latexValues).toContain('a + b = 3')
    })

    it('should detect LaTeX bracket notation \\[...\\] for block math', async () => {
      // This is common output from ChatGPT/OpenAI models
      const content = `The quadratic formula:

\\[ x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} \\]

That's how you solve it.`

      const frame = await run(function* () {
        return yield* runPipeline(content, {
          processors: [markdown, math],
        })
      })

      const allAnnotations = frame.blocks.flatMap((b) => b.annotations ?? [])
      const blockAnnotations = allAnnotations.filter((a) => a.subtype === 'block')

      expect(blockAnnotations.length).toBeGreaterThanOrEqual(1)
      expect(blockAnnotations[0]?.data?.latex).toContain('\\frac')
    })

    it('should detect LaTeX paren notation \\(...\\) for inline math', async () => {
      const content = `When \\(a = 1\\) and \\(b = 2\\), the sum is \\(a + b = 3\\).`

      const frame = await run(function* () {
        return yield* runPipeline(content, {
          processors: [markdown, math],
        })
      })

      const block = frame.blocks[0]!
      expect(block.annotations).toHaveLength(3)

      const latexValues = block.annotations!.map((a) => a.data?.latex)
      expect(latexValues).toContain('a = 1')
      expect(latexValues).toContain('b = 2')
      expect(latexValues).toContain('a + b = 3')
    })

    it('should handle mixed inline and block math', async () => {
      const content = `The formula $E = mc^2$ is famous.

$$E = mc^2$$

Einstein's equation above.`

      const frame = await run(function* () {
        return yield* runPipeline(content, {
          processors: [markdown, math],
        })
      })

      const allAnnotations = frame.blocks.flatMap((b) => b.annotations ?? [])
      const inlineAnnotations = allAnnotations.filter((a) => a.subtype === 'inline')
      const blockAnnotations = allAnnotations.filter((a) => a.subtype === 'block')

      expect(inlineAnnotations.length).toBeGreaterThanOrEqual(1)
      expect(blockAnnotations.length).toBeGreaterThanOrEqual(1)
    })

    it('should not detect escaped dollar signs', async () => {
      const content = `The price is \\$100 and \\$200.`

      const frame = await run(function* () {
        return yield* runPipeline(content, {
          processors: [markdown, math],
        })
      })

      const block = frame.blocks[0]!
      // Should have no math annotations
      expect(block.annotations ?? []).toHaveLength(0)
    })

    it('should not detect whitespace-only inline math', async () => {
      // $ $ with just whitespace inside shouldn't create an annotation
      const content = `Price is $ 100 but cost is $ $.`

      const frame = await run(function* () {
        return yield* runPipeline(content, {
          processors: [markdown, math],
        })
      })

      const block = frame.blocks[0]!
      const annotations = block.annotations ?? []
      
      // Should only have one annotation for "100 but cost is " 
      // which is technically valid (though weird) - the $ $ at the end should be skipped
      // Actually, let's just test that whitespace-only content is skipped
      const emptyAnnotations = annotations.filter(a => {
        const latex = (a.data?.latex as string) ?? ''
        return !latex.trim()
      })
      expect(emptyAnnotations).toHaveLength(0)
    })
  })

  describe('annotation positions', () => {
    it('should record correct raw positions', async () => {
      const content = `Hello $x^2$ world`
      //               0123456789...

      const frame = await run(function* () {
        return yield* runPipeline(content, {
          processors: [markdown, math],
        })
      })

      const block = frame.blocks[0]!
      const annotation = block.annotations![0]!

      expect(annotation.rawStart).toBe(6) // Start of $
      expect(annotation.rawEnd).toBe(11) // After closing $
    })
  })

  describe('HTML rendering', () => {
    it('should wrap inline math in span', async () => {
      const content = `Test $x$ here.`

      const frame = await run(function* () {
        return yield* runPipeline(content, {
          processors: [markdown, math],
        })
      })

      const block = frame.blocks[0]!

      // Should have math-inline class (either from KaTeX render or fallback)
      expect(block.rendered).toMatch(/math-inline/)
    })

    it('should wrap block math in div', async () => {
      const content = `$$y = x$$`

      const frame = await run(function* () {
        return yield* runPipeline(content, {
          processors: [markdown, math],
        })
      })

      const block = frame.blocks[0]!

      // Should have math-block class (either from KaTeX render or fallback)
      expect(block.rendered).toMatch(/math-block/)
    })
  })

  describe('streaming behavior', () => {
    it('should process math as content streams in', async () => {
      const frames: any[] = []
      const pipeline = createPipeline(
        { processors: [markdown, math] },
        function* (frame) {
          frames.push(JSON.parse(JSON.stringify(frame)))
        }
      )

      await run(function* () {
        yield* pipeline.process('The value is ')
        yield* pipeline.process('$x = ')
        yield* pipeline.process('42$ ')
        yield* pipeline.process('done.')
        yield* pipeline.flush()
      })

      // Final frame should have math annotation
      const lastFrame = frames[frames.length - 1]
      const block = lastFrame?.blocks[0]

      expect(block?.annotations?.length).toBeGreaterThan(0)
      expect(block?.annotations?.[0]?.data?.latex).toBe('x = 42')
    })
  })

  describe('integration with other processors', () => {
    it('should work alongside code blocks', async () => {
      const content = `Math: $x^2$

\`\`\`python
x = 2
\`\`\`

More math: $y^2$`

      const frame = await run(function* () {
        // Use markdown, shiki, and math processors
        return yield* runPipeline(content, {
          processors: [markdown, shiki, math],
        })
      })

      // Should have text blocks with math annotations
      const textBlocks = frame.blocks.filter((b) => b.type === 'text')
      const mathAnnotations = textBlocks.flatMap((b) => b.annotations ?? [])

      expect(mathAnnotations.length).toBeGreaterThanOrEqual(2)

      // Should have code block
      const codeBlock = frame.blocks.find((b) => b.type === 'code')
      expect(codeBlock).toBeDefined()
      expect(codeBlock?.language).toBe('python')
    })
  })
})
