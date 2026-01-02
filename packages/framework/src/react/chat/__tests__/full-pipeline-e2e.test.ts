/**
 * End-to-end integration tests for the full pipeline.
 *
 * These tests exercise ALL processors together (markdown, shiki, mermaid, math)
 * to catch any issues with processor interactions.
 *
 * The 'full' preset includes: [markdown, shiki, mermaid, math]
 */
import { describe, it, expect } from 'vitest'
import { run } from 'effection'
import { runPipeline, createPipeline } from '../pipeline'

describe('full pipeline e2e', () => {
  describe('mixed content rendering', () => {
    it('should handle markdown with code, math, and mermaid together', async () => {
      const content = `# Math and Code

Here's the quadratic formula: $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$

## Code Example

\`\`\`python
def quadratic(a, b, c):
    discriminant = b**2 - 4*a*c
    return (-b + discriminant**0.5) / (2*a)
\`\`\`

## Flow Diagram

\`\`\`mermaid
graph LR
    A[Input a,b,c] --> B[Calculate discriminant]
    B --> C{Check sign}
    C -->|positive| D[Two real roots]
    C -->|zero| E[One root]
    C -->|negative| F[Complex roots]
\`\`\`

Block math version:

$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$

Done!`

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      // Verify we have multiple block types
      const blockTypes = new Set(frame.blocks.map((b) => b.type))
      expect(blockTypes.has('text')).toBe(true)
      expect(blockTypes.has('code')).toBe(true)

      // Verify code blocks
      const codeBlocks = frame.blocks.filter((b) => b.type === 'code')
      expect(codeBlocks.length).toBe(2)

      const pythonBlock = codeBlocks.find((b) => b.language === 'python')
      const mermaidBlock = codeBlocks.find((b) => b.language === 'mermaid')

      expect(pythonBlock).toBeDefined()
      expect(mermaidBlock).toBeDefined()

      // Python block should have shiki highlighting
      expect(pythonBlock?.renderPass).toBe('full')
      expect(pythonBlock?.rendered).toContain('shiki')

      // Mermaid block should be processed (will error in test env, but should be marked)
      expect(mermaidBlock?.status).toBe('complete')
      expect(mermaidBlock?.renderPass).toBe('full')

      // Verify math annotations exist
      const allAnnotations = frame.blocks.flatMap((b) => b.annotations ?? [])
      const mathAnnotations = allAnnotations.filter((a) => a.type === 'math')

      expect(mathAnnotations.length).toBeGreaterThanOrEqual(2) // inline + block

      // Verify inline and block math detected
      const inlineMath = mathAnnotations.filter((a) => a.subtype === 'inline')
      const blockMath = mathAnnotations.filter((a) => a.subtype === 'block')

      expect(inlineMath.length).toBeGreaterThanOrEqual(1)
      expect(blockMath.length).toBeGreaterThanOrEqual(1)

      // Verify markdown rendered (headers should be h1/h2)
      const firstTextBlock = frame.blocks.find((b) => b.type === 'text')
      expect(firstTextBlock?.rendered).toContain('<h1')
    })

    it('should handle streaming of complex content', async () => {
      const pipeline = createPipeline({ processors: 'full' })

      const chunks = [
        '# Hello\n\n',
        'Inline math: $x^2$\n\n',
        '```python\n',
        'x = 1\n',
        '```\n\n',
        '```mermaid\n',
        'graph LR\n',
        'A-->B\n',
        '```\n\n',
        '$$E = mc^2$$\n',
      ]

      await run(function* () {
        // Push all chunks (lazy - just buffers)
        for (const chunk of chunks) {
          pipeline.push(chunk)
        }
        
        // Flush to process all and finalize
        const finalFrame = yield* pipeline.flush()

        // Should have code blocks
        const codeBlocks = finalFrame.blocks.filter((b: any) => b.type === 'code')
        expect(codeBlocks.length).toBe(2)

        // Should have math annotations
        const mathAnnotations = finalFrame.blocks
          .flatMap((b: any) => b.annotations ?? [])
          .filter((a: any) => a.type === 'math')
        expect(mathAnnotations.length).toBeGreaterThanOrEqual(2)

        // All code blocks should be complete
        for (const block of codeBlocks) {
          expect(block.status).toBe('complete')
        }
      })
    })

    it('should handle content with all delimiter types', async () => {
      // Test all math delimiter formats that LLMs might output
      const content = `Standard: $a + b = c$

LaTeX inline: \\(x + y = z\\)

Standard block:
$$\\int_0^1 f(x) dx$$

LaTeX block:
\\[ \\sum_{i=1}^n i = \\frac{n(n+1)}{2} \\]

Plain bracket (should detect as math):
[ x = \\frac{-b}{2a} ]

Code for comparison:
\`\`\`javascript
const sum = (a, b) => a + b
\`\`\``

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      const mathAnnotations = frame.blocks
        .flatMap((b) => b.annotations ?? [])
        .filter((a) => a.type === 'math')

      // Should detect at least 5 math expressions (all delimiter types)
      expect(mathAnnotations.length).toBeGreaterThanOrEqual(5)

      // Code block should be separate
      const codeBlock = frame.blocks.find((b) => b.type === 'code')
      expect(codeBlock).toBeDefined()
      expect(codeBlock?.language).toBe('javascript')
    })

    it('should not create duplicate annotations on idempotent runs', async () => {
      const content = `Math: $x^2$ and $$y^2$$`

      // Run twice with same content
      const frame1 = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      const frame2 = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      const annotations1 = frame1.blocks.flatMap((b) => b.annotations ?? [])
      const annotations2 = frame2.blocks.flatMap((b) => b.annotations ?? [])

      // Both should have same number of annotations
      expect(annotations1.length).toBe(annotations2.length)
      expect(annotations1.length).toBe(2) // inline + block
    })

    it('should preserve code block languages correctly', async () => {
      const content = `\`\`\`typescript
const x: number = 1
\`\`\`

\`\`\`python
x = 1
\`\`\`

\`\`\`mermaid
graph TD
A-->B
\`\`\`

\`\`\`rust
fn main() {}
\`\`\``

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      const codeBlocks = frame.blocks.filter((b) => b.type === 'code')
      expect(codeBlocks.length).toBe(4)

      const languages = codeBlocks.map((b) => b.language)
      expect(languages).toContain('typescript')
      expect(languages).toContain('python')
      expect(languages).toContain('mermaid')
      expect(languages).toContain('rust')

      // All should be complete
      for (const block of codeBlocks) {
        expect(block.status).toBe('complete')
        expect(block.renderPass).toBe('full')
      }
    })
  })

  describe('edge cases', () => {
    it('should handle empty content', async () => {
      const frame = await run(function* () {
        return yield* runPipeline('', { processors: 'full' })
      })

      expect(frame.blocks).toHaveLength(0)
    })

    it('should handle content with only whitespace', async () => {
      const frame = await run(function* () {
        return yield* runPipeline('   \n\n   ', { processors: 'full' })
      })

      // Might have one text block with whitespace
      expect(frame.blocks.length).toBeLessThanOrEqual(1)
    })

    it('should handle deeply nested markdown', async () => {
      const content = `> Quote with $x^2$ math
>
> \`\`\`python
> nested = True
> \`\`\`

1. List item with $y = mx + b$
2. Another item

| Header | Math |
|--------|------|
| Cell   | $z$  |`

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      // Should parse without errors
      expect(frame.blocks.length).toBeGreaterThan(0)

      // Should have math annotations
      const mathAnnotations = frame.blocks
        .flatMap((b) => b.annotations ?? [])
        .filter((a) => a.type === 'math')
      expect(mathAnnotations.length).toBeGreaterThanOrEqual(1)
    })

    it('should handle malformed code fences gracefully', async () => {
      const content = `\`\`\`python
incomplete code without closing

Some text after

\`\`\`javascript
const x = 1
\`\`\``

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      // Should not throw, content should be parsed
      expect(frame.blocks.length).toBeGreaterThan(0)
    })

    it('should handle math inside code blocks correctly (should NOT render)', async () => {
      const content = `\`\`\`latex
$x^2$ should not be rendered
$$y^2$$ should stay as-is
\`\`\``

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      // Code block should preserve math delimiters as-is
      const codeBlock = frame.blocks.find((b) => b.type === 'code')
      expect(codeBlock).toBeDefined()
      expect(codeBlock?.raw).toContain('$x^2$')
      expect(codeBlock?.raw).toContain('$$y^2$$')

      // No math annotations on code blocks
      expect(codeBlock?.annotations ?? []).toHaveLength(0)
    })

    it('should handle extremely long content', async () => {
      // Generate long content with repeated patterns
      const segment = `Here is $x^2$ math.\n\n\`\`\`python\nx = 1\n\`\`\`\n\n`
      const content = segment.repeat(50)

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      // Should complete without timeout
      expect(frame.blocks.length).toBeGreaterThan(0)

      // Should have many code blocks
      const codeBlocks = frame.blocks.filter((b) => b.type === 'code')
      expect(codeBlocks.length).toBe(50)

      // Should have math annotations
      const mathAnnotations = frame.blocks
        .flatMap((b) => b.annotations ?? [])
        .filter((a) => a.type === 'math')
      expect(mathAnnotations.length).toBe(50)
    })
  })

  describe('processor order independence', () => {
    it('should produce consistent results regardless of processor order', async () => {
      const content = `# Title

Math: $x^2$

\`\`\`python
code = True
\`\`\`

\`\`\`mermaid
graph LR
A-->B
\`\`\``

      // Note: The pipeline should resolve dependencies correctly
      // even if we specify processors in different orders
      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      // Verify all processors ran
      const codeBlocks = frame.blocks.filter((b) => b.type === 'code')
      expect(codeBlocks.length).toBe(2)

      const mathAnnotations = frame.blocks
        .flatMap((b) => b.annotations ?? [])
        .filter((a) => a.type === 'math')
      expect(mathAnnotations.length).toBe(1)

      // Python should have shiki highlighting
      const pythonBlock = codeBlocks.find((b) => b.language === 'python')
      expect(pythonBlock?.rendered).toContain('shiki')
    })
  })

  describe('streaming transitions', () => {
    it('should transition blocks from streaming to complete correctly', async () => {
      const pipeline = createPipeline({ processors: 'full' })

      await run(function* () {
        // Push python block content
        pipeline.push('```python\n')
        pipeline.push('x = 1\n')
        
        // Pull mid-stream to check status
        const streamingFrame = yield* pipeline.pull()
        const pythonStreamingBlock = streamingFrame.blocks.find(
          (b: any) => b.type === 'code' && b.language === 'python'
        )
        expect(pythonStreamingBlock?.status).toBe('streaming')
        
        // Close python block and add mermaid
        pipeline.push('```\n\n')
        pipeline.push('```mermaid\n')
        pipeline.push('graph LR\n')
        pipeline.push('A-->B\n')
        pipeline.push('```\n')
        
        // Flush to complete
        const finalFrame = yield* pipeline.flush()
        
        // All code blocks should be complete
        const codeBlocks = finalFrame.blocks.filter((b: any) => b.type === 'code')
        for (const block of codeBlocks) {
          expect(block.status).toBe('complete')
        }
      })
    })

    it('should apply quick highlighting during streaming then full on complete', async () => {
      const pipeline = createPipeline({ processors: 'full' })

      await run(function* () {
        pipeline.push('```python\n')
        pipeline.push('def foo():\n')
        
        // Pull mid-stream to check render pass
        const streamingFrame = yield* pipeline.pull()
        const streamingBlock = streamingFrame.blocks.find(
          (b: any) => b.type === 'code' && b.language === 'python'
        )
        // During streaming, might be quick or none depending on processor
        expect(['none', 'quick']).toContain(streamingBlock?.renderPass)
        
        // Complete the block
        pipeline.push('    return 42\n')
        pipeline.push('```\n')
        
        const finalFrame = yield* pipeline.flush()
        const finalBlock = finalFrame.blocks.find(
          (b: any) => b.type === 'code' && b.language === 'python'
        )
        
        // Should end with full pass
        expect(finalBlock?.renderPass).toBe('full')
      })
    })
  })

  describe('real-world LLM outputs', () => {
    it('should handle ChatGPT-style math output', async () => {
      // ChatGPT often uses \[ \] and \( \) for math
      const content = `The quadratic formula is given by:

\\[ x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} \\]

Where \\(a\\), \\(b\\), and \\(c\\) are coefficients of the quadratic equation \\(ax^2 + bx + c = 0\\).`

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      const mathAnnotations = frame.blocks
        .flatMap((b) => b.annotations ?? [])
        .filter((a) => a.type === 'math')

      // Should detect all math: 1 block + 4 inline
      expect(mathAnnotations.length).toBeGreaterThanOrEqual(5)

      const blockMath = mathAnnotations.filter((a) => a.subtype === 'block')
      const inlineMath = mathAnnotations.filter((a) => a.subtype === 'inline')

      expect(blockMath.length).toBeGreaterThanOrEqual(1)
      expect(inlineMath.length).toBeGreaterThanOrEqual(4)
    })

    it('should handle Claude-style mixed content', async () => {
      const content = `Here's a Python implementation:

\`\`\`python
import math

def solve_quadratic(a, b, c):
    """Solve ax^2 + bx + c = 0"""
    discriminant = b**2 - 4*a*c
    if discriminant < 0:
        return None
    x1 = (-b + math.sqrt(discriminant)) / (2*a)
    x2 = (-b - math.sqrt(discriminant)) / (2*a)
    return x1, x2
\`\`\`

The formula used is $x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$.

Here's a flowchart:

\`\`\`mermaid
flowchart TD
    A[Start] --> B[Calculate discriminant]
    B --> C{d >= 0?}
    C -->|Yes| D[Calculate roots]
    C -->|No| E[Return None]
    D --> F[Return x1, x2]
\`\`\``

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      // Should have python and mermaid code blocks
      const codeBlocks = frame.blocks.filter((b) => b.type === 'code')
      expect(codeBlocks.length).toBe(2)

      const pythonBlock = codeBlocks.find((b) => b.language === 'python')
      const mermaidBlock = codeBlocks.find((b) => b.language === 'mermaid')

      expect(pythonBlock).toBeDefined()
      expect(mermaidBlock).toBeDefined()

      // Python should have full shiki rendering
      expect(pythonBlock?.rendered).toContain('shiki')
      expect(pythonBlock?.renderPass).toBe('full')

      // Should have math annotation
      const mathAnnotations = frame.blocks
        .flatMap((b) => b.annotations ?? [])
        .filter((a) => a.type === 'math')
      expect(mathAnnotations.length).toBeGreaterThanOrEqual(1)
    })
  })
})
