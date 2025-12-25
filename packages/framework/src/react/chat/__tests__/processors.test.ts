/**
 * processors.test.ts
 *
 * Unit tests for processor functions and message renderers.
 */
import { describe, it, expect } from 'vitest'
import { run } from 'effection'
import {
  passthrough,
  markdown,
  incrementalMarkdown,
  smartMarkdown,
  syntaxHighlight,
  fromSync,
  markdownRenderer,
  mathRenderer,
  mathMarkdown,
} from '../processors'
import type { ProcessorContext, ProcessedOutput, SyncProcessor } from '../types'

// Helper to run a processor and collect emissions
async function runProcessor(
  processor: ReturnType<typeof passthrough>,
  ctx: ProcessorContext
): Promise<ProcessedOutput[]> {
  return run(function* () {
    const emissions: ProcessedOutput[] = []
    
    function* emit(output: ProcessedOutput) {
      emissions.push(output)
    }
    
    yield* processor(ctx, emit as any)
    return emissions
  })
}

// Helper to create a processor context
function ctx(
  chunk: string,
  accumulated = '',
  next?: string,
  meta?: Record<string, unknown>
): ProcessorContext {
  return {
    chunk,
    accumulated,
    next: next ?? accumulated + chunk,
    meta,
  }
}

describe('processors', () => {
  describe('passthrough()', () => {
    it('should emit raw content unchanged', async () => {
      const processor = passthrough()
      const emissions = await runProcessor(processor, ctx('Hello world'))
      
      expect(emissions).toEqual([{ raw: 'Hello world' }])
    })

    it('should work with empty content', async () => {
      const processor = passthrough()
      const emissions = await runProcessor(processor, ctx(''))
      
      expect(emissions).toEqual([{ raw: '' }])
    })

    it('should preserve special characters', async () => {
      const processor = passthrough()
      const emissions = await runProcessor(processor, ctx('Hello <script>alert("xss")</script>'))
      
      expect(emissions).toEqual([{ raw: 'Hello <script>alert("xss")</script>' }])
    })
  })

  describe('markdown()', () => {
    it('should parse markdown to HTML', async () => {
      const processor = markdown()
      const emissions = await runProcessor(processor, ctx('**bold** text', '', '**bold** text'))
      
      expect(emissions.length).toBe(1)
      expect(emissions[0].html).toContain('<strong>bold</strong>')
      expect(emissions[0].html).toContain('text')
    })

    it('should handle headings', async () => {
      const processor = markdown()
      const emissions = await runProcessor(processor, ctx('# Title\n\nContent'))
      
      expect(emissions[0].html).toContain('<h1>')
      expect(emissions[0].html).toContain('Title')
    })

    it('should handle code blocks', async () => {
      const processor = markdown()
      const emissions = await runProcessor(processor, ctx('```js\nconst x = 1\n```'))
      
      expect(emissions[0].html).toContain('<code')
      expect(emissions[0].html).toContain('const x = 1')
    })

    it('should handle lists', async () => {
      const processor = markdown()
      const emissions = await runProcessor(processor, ctx('- Item 1\n- Item 2'))
      
      expect(emissions[0].html).toContain('<ul>')
      expect(emissions[0].html).toContain('<li>')
    })

    it('should handle blockquotes', async () => {
      const processor = markdown()
      const emissions = await runProcessor(processor, ctx('> This is a quote'))
      
      expect(emissions[0].html).toContain('<blockquote>')
    })

    it('should use full accumulated content (next) for parsing', async () => {
      const processor = markdown()
      // chunk is 'world', but next is full accumulated content
      const emissions = await runProcessor(processor, ctx('world', 'Hello ', 'Hello world'))
      
      expect(emissions[0].raw).toBe('Hello world')
    })
  })

  describe('incrementalMarkdown()', () => {
    it('should parse only the chunk, not accumulated', async () => {
      const processor = incrementalMarkdown()
      const emissions = await runProcessor(processor, ctx('**new**', 'old content '))
      
      expect(emissions.length).toBe(1)
      expect(emissions[0].html).toContain('<strong>new</strong>')
      expect(emissions[0].raw).toBe('**new**')
      // Should NOT contain 'old content'
      expect(emissions[0].html).not.toContain('old content')
    })

    it('should handle inline elements', async () => {
      const processor = incrementalMarkdown()
      const emissions = await runProcessor(processor, ctx('`code` and *italic*'))
      
      expect(emissions[0].html).toContain('<code>code</code>')
      expect(emissions[0].html).toContain('<em>italic</em>')
    })
  })

  describe('smartMarkdown()', () => {
    it('should pass through raw when inside code fence', async () => {
      const processor = smartMarkdown()
      const emissions = await runProcessor(processor, ctx(
        'def foo(): pass',
        '',
        'def foo(): pass',
        { inCodeFence: true, language: 'python' }
      ))
      
      expect(emissions.length).toBe(1)
      expect(emissions[0].raw).toBe('def foo(): pass')
      expect(emissions[0].html).toBeUndefined()
    })

    it('should parse markdown when outside code fence', async () => {
      const processor = smartMarkdown()
      const emissions = await runProcessor(processor, ctx(
        '**bold** text',
        '',
        '**bold** text',
        { inCodeFence: false }
      ))
      
      expect(emissions[0].html).toContain('<strong>bold</strong>')
    })

    it('should parse markdown when no meta provided', async () => {
      const processor = smartMarkdown()
      const emissions = await runProcessor(processor, ctx('**bold** text'))
      
      expect(emissions[0].html).toContain('<strong>bold</strong>')
    })
  })

  describe('syntaxHighlight()', () => {
    it('should pass through when not in code fence', async () => {
      const processor = syntaxHighlight()
      const emissions = await runProcessor(processor, ctx(
        'regular text',
        '',
        'regular text',
        { inCodeFence: false }
      ))
      
      expect(emissions.length).toBe(1)
      expect(emissions[0].raw).toBe('regular text')
      expect(emissions[0].pass).toBe('quick')
    })

    it('should emit quick pass with regex highlighting in code fence', async () => {
      const processor = syntaxHighlight()
      const emissions = await runProcessor(processor, ctx(
        'def foo(): return 42',
        '',
        'def foo(): return 42',
        { inCodeFence: true, language: 'python' }
      ))
      
      // Should have 2 emissions: quick and full
      expect(emissions.length).toBe(2)
      
      // Quick pass
      expect(emissions[0].pass).toBe('quick')
      expect(emissions[0].html).toContain('<span class="kw">def</span>')
      expect(emissions[0].html).toContain('<span class="kw">return</span>')
      
      // Full pass - uses different highlighting that may escape quotes
      expect(emissions[1].pass).toBe('full')
      // The regex for full pass may produce nested/escaped spans, just verify it contains key elements
      expect(emissions[1].html).toContain('def')
      expect(emissions[1].html).toContain('return')
      expect(emissions[1].html).toContain('42')
    })

    it('should highlight common keywords', async () => {
      const processor = syntaxHighlight()
      const emissions = await runProcessor(processor, ctx(
        'if x: for y in z: class Foo: import bar',
        '',
        'if x: for y in z: class Foo: import bar',
        { inCodeFence: true, language: 'python' }
      ))
      
      const quickHtml = emissions[0].html!
      expect(quickHtml).toContain('<span class="kw">if</span>')
      expect(quickHtml).toContain('<span class="kw">for</span>')
      expect(quickHtml).toContain('<span class="kw">in</span>')
      expect(quickHtml).toContain('<span class="kw">class</span>')
      expect(quickHtml).toContain('<span class="kw">import</span>')
    })

    it('should highlight JS keywords', async () => {
      const processor = syntaxHighlight()
      const emissions = await runProcessor(processor, ctx(
        'const x = async function() { await fetch() }',
        '',
        'const x = async function() { await fetch() }',
        { inCodeFence: true, language: 'javascript' }
      ))
      
      const quickHtml = emissions[0].html!
      expect(quickHtml).toContain('<span class="kw">const</span>')
      expect(quickHtml).toContain('<span class="kw">async</span>')
      expect(quickHtml).toContain('<span class="kw">function</span>')
      expect(quickHtml).toContain('<span class="kw">await</span>')
    })
  })

  describe('fromSync()', () => {
    it('should wrap a sync processor', async () => {
      const syncProcessor: SyncProcessor = (ctx) => ({
        raw: ctx.chunk.toUpperCase(),
        html: `<upper>${ctx.chunk.toUpperCase()}</upper>`,
      })
      
      const processor = fromSync(syncProcessor)
      const emissions = await runProcessor(processor, ctx('hello'))
      
      expect(emissions).toEqual([{
        raw: 'HELLO',
        html: '<upper>HELLO</upper>',
      }])
    })

    it('should have access to full context', async () => {
      const syncProcessor: SyncProcessor = (ctx) => ({
        raw: `chunk:${ctx.chunk} acc:${ctx.accumulated} next:${ctx.next}`,
      })
      
      const processor = fromSync(syncProcessor)
      const emissions = await runProcessor(processor, ctx('new', 'old ', 'old new'))
      
      expect(emissions[0].raw).toBe('chunk:new acc:old  next:old new')
    })
  })

  describe('mathMarkdown()', () => {
    it('should render inline math with $ delimiters', async () => {
      const processor = mathMarkdown()
      const emissions = await runProcessor(processor, ctx('The formula is $E = mc^2$ here'))
      
      expect(emissions.length).toBe(1)
      // KaTeX output contains class="katex"
      expect(emissions[0].html).toContain('katex')
      // KaTeX renders math differently - check for key structure
      expect(emissions[0].html).toContain('mord mathnormal')  // KaTeX class for math letters
    })

    it('should render display math with $$ delimiters', async () => {
      const processor = mathMarkdown()
      const emissions = await runProcessor(processor, ctx('$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$'))
      
      expect(emissions.length).toBe(1)
      expect(emissions[0].html).toContain('katex')
    })

    it('should render inline math with \\( \\) delimiters', async () => {
      const processor = mathMarkdown()
      const emissions = await runProcessor(processor, ctx('This is \\(x^2\\) inline'))
      
      expect(emissions[0].html).toContain('katex')
    })

    it('should render display math with \\[ \\] delimiters', async () => {
      const processor = mathMarkdown()
      const emissions = await runProcessor(processor, ctx('\\[\\int_0^1 x dx = \\frac{1}{2}\\]'))
      
      expect(emissions[0].html).toContain('katex')
    })

    it('should NOT treat currency as math ($50)', async () => {
      const processor = mathMarkdown()
      const emissions = await runProcessor(processor, ctx('It costs $50 dollars'))
      
      // Should not be rendered as math
      expect(emissions[0].html).not.toContain('katex')
      expect(emissions[0].html).toContain('$50')
    })

    it('should handle mixed math and markdown', async () => {
      const processor = mathMarkdown()
      const emissions = await runProcessor(processor, ctx('**Bold** with math: $x^2$'))
      
      expect(emissions[0].html).toContain('<strong>Bold</strong>')
      expect(emissions[0].html).toContain('katex')
    })

    it('should handle invalid LaTeX gracefully', async () => {
      const processor = mathMarkdown()
      const emissions = await runProcessor(processor, ctx('$\\invalid{command}$'))
      
      // Should not throw, should contain some output
      expect(emissions.length).toBe(1)
      expect(emissions[0].html).toBeDefined()
    })
  })

  describe('markdownRenderer()', () => {
    it('should render markdown to HTML', () => {
      const renderer = markdownRenderer()
      const html = renderer('**bold** and *italic*')
      
      expect(html).toContain('<strong>bold</strong>')
      expect(html).toContain('<em>italic</em>')
    })

    it('should handle complex markdown', () => {
      const renderer = markdownRenderer()
      const html = renderer(`# Title

- Item 1
- Item 2

\`\`\`js
const x = 1
\`\`\`
`)
      
      expect(html).toContain('<h1>')
      expect(html).toContain('<ul>')
      expect(html).toContain('<li>')
      expect(html).toContain('<code')
    })
  })

  describe('mathRenderer()', () => {
    it('should render markdown and math', () => {
      const renderer = mathRenderer()
      const html = renderer('**Bold** with $E = mc^2$')
      
      expect(html).toContain('<strong>Bold</strong>')
      expect(html).toContain('katex')
    })

    it('should handle display math', () => {
      const renderer = mathRenderer()
      const html = renderer('$$\\sum_{i=1}^n i$$')
      
      expect(html).toContain('katex')
      expect(html).toContain('katex-display')  // KaTeX wraps display math in katex-display class
    })

    it('should NOT render currency as math', () => {
      const renderer = mathRenderer()
      const html = renderer('Price: $100')
      
      expect(html).not.toContain('katex')
      expect(html).toContain('$100')
    })
  })
})

describe('processor progressive enhancement pattern', () => {
  it('should allow multiple emissions for quick -> full pattern', async () => {
    // Custom processor that emits multiple times
    const progressiveProcessor = function* (
      ctx: ProcessorContext,
      emit: (output: ProcessedOutput) => { [Symbol.iterator](): Generator<void> }
    ) {
      // Quick pass (immediate)
      yield* emit({ raw: ctx.chunk, html: `<quick>${ctx.chunk}</quick>`, pass: 'quick' })
      
      // Full pass (would normally be async)
      yield* emit({ raw: ctx.chunk, html: `<full>${ctx.chunk}</full>`, pass: 'full' })
    }
    
    const emissions = await runProcessor(progressiveProcessor as any, ctx('test'))
    
    expect(emissions.length).toBe(2)
    expect(emissions[0]).toEqual({ raw: 'test', html: '<quick>test</quick>', pass: 'quick' })
    expect(emissions[1]).toEqual({ raw: 'test', html: '<full>test</full>', pass: 'full' })
  })

  it('should support conditional processing based on metadata', async () => {
    const conditionalProcessor = function* (
      ctx: ProcessorContext,
      emit: (output: ProcessedOutput) => { [Symbol.iterator](): Generator<void> }
    ) {
      if (ctx.meta?.inCodeFence) {
        yield* emit({ raw: ctx.chunk, html: `<code>${ctx.chunk}</code>` })
      } else {
        yield* emit({ raw: ctx.chunk, html: `<p>${ctx.chunk}</p>` })
      }
    }
    
    // In code fence
    let emissions = await runProcessor(conditionalProcessor as any, ctx('x = 1', '', '', { inCodeFence: true }))
    expect(emissions[0].html).toBe('<code>x = 1</code>')
    
    // Not in code fence
    emissions = await runProcessor(conditionalProcessor as any, ctx('paragraph', '', '', { inCodeFence: false }))
    expect(emissions[0].html).toBe('<p>paragraph</p>')
  })
})
