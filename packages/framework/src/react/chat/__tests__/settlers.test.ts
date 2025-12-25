/**
 * settlers.test.ts
 *
 * Unit tests for all settler functions and combinators.
 */
import { describe, it, expect } from 'vitest'
import {
  timeout,
  paragraph,
  maxSize,
  sentence,
  line,
  any,
  all,
  codeFence,
} from '../settlers'
import type { SettleContext, ChatPatch } from '../types'

// Helper to create a settle context
function ctx(pending: string, elapsed = 0, settled = ''): SettleContext {
  return {
    pending,
    elapsed,
    settled,
    patch: { type: 'streaming_text', content: pending } as ChatPatch,
  }
}

describe('settlers', () => {
  describe('timeout(ms)', () => {
    it('should NOT yield when elapsed < timeout', () => {
      const settler = timeout(100)
      const results = [...settler(ctx('pending content', 50))]
      expect(results).toEqual([])
    })

    it('should yield all pending when elapsed >= timeout', () => {
      const settler = timeout(100)
      const results = [...settler(ctx('pending content', 100))]
      expect(results).toEqual(['pending content'])
    })

    it('should yield all pending when elapsed > timeout', () => {
      const settler = timeout(100)
      const results = [...settler(ctx('pending content', 150))]
      expect(results).toEqual(['pending content'])
    })

    it('should yield empty string if pending is empty and timeout passed', () => {
      const settler = timeout(100)
      const results = [...settler(ctx('', 100))]
      expect(results).toEqual([''])
    })
  })

  describe('paragraph()', () => {
    it('should NOT yield when no paragraph break exists', () => {
      const settler = paragraph()
      const results = [...settler(ctx('no paragraph break here'))]
      expect(results).toEqual([])
    })

    it('should yield content up to and including \\n\\n', () => {
      const settler = paragraph()
      const results = [...settler(ctx('First paragraph.\n\nSecond'))]
      expect(results).toEqual(['First paragraph.\n\n'])
    })

    it('should yield multiple paragraphs', () => {
      const settler = paragraph()
      const results = [...settler(ctx('Para 1\n\nPara 2\n\nPara 3'))]
      expect(results).toEqual(['Para 1\n\n', 'Para 2\n\n'])
    })

    it('should handle consecutive paragraph breaks', () => {
      const settler = paragraph()
      const results = [...settler(ctx('A\n\n\n\nB'))]
      // First \n\n creates "A\n\n", then "\n\n" creates another empty paragraph
      expect(results).toEqual(['A\n\n', '\n\n'])
    })

    it('should handle paragraph at very end', () => {
      const settler = paragraph()
      const results = [...settler(ctx('Complete\n\n'))]
      expect(results).toEqual(['Complete\n\n'])
    })
  })

  describe('maxSize(chars)', () => {
    it('should NOT yield when pending < max size', () => {
      const settler = maxSize(100)
      const results = [...settler(ctx('short'))]
      expect(results).toEqual([])
    })

    it('should yield all pending when exactly at max size', () => {
      const settler = maxSize(5)
      const results = [...settler(ctx('12345'))]
      expect(results).toEqual(['12345'])
    })

    it('should yield all pending when exceeds max size', () => {
      const settler = maxSize(5)
      const results = [...settler(ctx('123456789'))]
      expect(results).toEqual(['123456789'])
    })

    it('should work with size of 0 (always yields)', () => {
      const settler = maxSize(0)
      const results = [...settler(ctx('anything'))]
      expect(results).toEqual(['anything'])
    })
  })

  describe('sentence()', () => {
    it('should NOT yield when no sentence ending', () => {
      const settler = sentence()
      const results = [...settler(ctx('incomplete sentence without ending'))]
      expect(results).toEqual([])
    })

    it('should yield sentence ending with period and space', () => {
      const settler = sentence()
      const results = [...settler(ctx('First sentence. Second'))]
      expect(results).toEqual(['First sentence. '])
    })

    it('should yield sentence ending with period and newline', () => {
      const settler = sentence()
      const results = [...settler(ctx('First sentence.\nSecond'))]
      expect(results).toEqual(['First sentence.\n'])
    })

    it('should yield sentence ending with question mark', () => {
      const settler = sentence()
      const results = [...settler(ctx('Is this a question? Yes'))]
      expect(results).toEqual(['Is this a question? '])
    })

    it('should yield sentence ending with exclamation mark', () => {
      const settler = sentence()
      const results = [...settler(ctx('Wow! Amazing'))]
      expect(results).toEqual(['Wow! '])
    })

    it('should yield multiple sentences', () => {
      const settler = sentence()
      const results = [...settler(ctx('One. Two! Three? Four'))]
      expect(results).toEqual(['One. ', 'Two! ', 'Three? '])
    })

    it('should handle sentence at end of string', () => {
      const settler = sentence()
      // The pattern /[.?!](?:\s|$)/ matches end of string too
      const results = [...settler(ctx('Complete sentence.'))]
      expect(results).toEqual(['Complete sentence.'])
    })

    it('should handle sentence with trailing newline at end', () => {
      const settler = sentence()
      const results = [...settler(ctx('Complete sentence.\n'))]
      expect(results).toEqual(['Complete sentence.\n'])
    })
  })

  describe('line()', () => {
    it('should NOT yield when no newline', () => {
      const settler = line()
      const results = [...settler(ctx('no newline here'))]
      expect(results).toEqual([])
    })

    it('should yield content up to and including \\n', () => {
      const settler = line()
      const results = [...settler(ctx('first line\nsecond'))]
      expect(results).toEqual(['first line\n'])
    })

    it('should yield multiple lines', () => {
      const settler = line()
      const results = [...settler(ctx('line 1\nline 2\nline 3'))]
      expect(results).toEqual(['line 1\n', 'line 2\n'])
    })

    it('should handle empty lines', () => {
      const settler = line()
      const results = [...settler(ctx('\n\nline'))]
      expect(results).toEqual(['\n', '\n'])
    })

    it('should handle trailing newline', () => {
      const settler = line()
      const results = [...settler(ctx('complete\n'))]
      expect(results).toEqual(['complete\n'])
    })
  })

  describe('any(...settlers)', () => {
    it('should return first settler that yields', () => {
      const settler = any(
        paragraph(),  // won't yield - no \n\n
        line(),       // will yield - has \n
      )
      const results = [...settler(ctx('first\nsecond'))]
      expect(results).toEqual(['first\n'])
    })

    it('should try settlers in order', () => {
      const settler = any(
        line(),       // yields first
        paragraph(),
      )
      const results = [...settler(ctx('has\n\nboth'))]
      // line() is first and yields ALL lines it can find: "has\n" and "\n"
      expect(results).toEqual(['has\n', '\n'])
    })

    it('should return nothing if no settler yields', () => {
      const settler = any(
        paragraph(),
        line(),
      )
      const results = [...settler(ctx('no breaks at all'))]
      expect(results).toEqual([])
    })

    it('should yield all from first successful settler', () => {
      const settler = any(
        paragraph(),
        line(),
      )
      const results = [...settler(ctx('a\n\nb\n\nc'))]
      // paragraph() yields multiple, and any() yields all of them
      expect(results).toEqual(['a\n\n', 'b\n\n'])
    })

    it('should work with timeout fallback', () => {
      const settler = any(
        paragraph(),  // won't yield
        timeout(100), // will yield if elapsed >= 100
      )
      const results = [...settler(ctx('no paragraph', 150))]
      expect(results).toEqual(['no paragraph'])
    })

    it('should prefer earlier settler even with timeout', () => {
      const settler = any(
        paragraph(),
        timeout(100),
      )
      const results = [...settler(ctx('has para\n\nbreak', 150))]
      // paragraph() is first and yields
      expect(results).toEqual(['has para\n\n'])
    })
  })

  describe('all(...settlers)', () => {
    it('should return nothing if any settler yields nothing', () => {
      const settler = all(
        paragraph(),  // yields
        line(),       // yields
      )
      // No \n\n in string, so paragraph() won't yield
      const results = [...settler(ctx('line only\nno para'))]
      expect(results).toEqual([])
    })

    it('should return smallest when all yield', () => {
      const settler = all(
        timeout(100),   // yields all 20 chars
        maxSize(10),    // yields all 20 chars (over 10)
      )
      const results = [...settler(ctx('12345678901234567890', 100))]
      // Both yield the full string, smallest is the full string
      expect(results).toEqual(['12345678901234567890'])
    })

    it('should return smallest total content', () => {
      const settler = all(
        paragraph(),  // yields "a\n\n" (4 chars)
        line(),       // yields "a\n" AND "\n" which joins to "a\n\n" (4 chars)
      )
      const results = [...settler(ctx('a\n\nb'))]
      // Both yield same total length, so first one wins (paragraph)
      // Actually: line() yields ["a\n", "\n"] -> joined "a\n\n" (4 chars)
      //           paragraph() yields ["a\n\n"] -> joined "a\n\n" (4 chars)
      // Both are same length, first one (paragraph) is used
      expect(results).toEqual(['a\n\n'])
    })

    it('should handle timeout + paragraph requirement', () => {
      const settler = all(
        timeout(100),
        paragraph(),
      )
      // paragraph found and timeout passed
      const results = [...settler(ctx('para\n\nmore', 150))]
      // paragraph yields "para\n\n", timeout yields "para\n\nmore"
      // smallest is "para\n\n"
      expect(results).toEqual(['para\n\n'])
    })

    it('should return nothing if timeout not reached even with paragraph', () => {
      const settler = all(
        timeout(100),
        paragraph(),
      )
      const results = [...settler(ctx('para\n\nmore', 50))]
      // timeout doesn't yield because elapsed < 100
      expect(results).toEqual([])
    })
  })

  describe('codeFence() - metadata settler', () => {
    it('should settle paragraphs outside fences', () => {
      const settler = codeFence()
      const results = [...settler(ctx('Para 1\n\nPara 2'))]
      expect(results).toEqual([
        { content: 'Para 1\n\n' },
      ])
    })

    it('should detect fence opening with language', () => {
      const settler = codeFence()
      const results = [...settler(ctx('```python\ncode'))]
      expect(results).toEqual([
        { content: '```python\n', meta: { inCodeFence: true, language: 'python' } },
      ])
    })

    it('should detect fence opening without language', () => {
      const settler = codeFence()
      const results = [...settler(ctx('```\ncode'))]
      expect(results).toEqual([
        { content: '```\n', meta: { inCodeFence: true, language: '' } },
      ])
    })

    it('should settle line-by-line inside fence', () => {
      const settler = codeFence()
      // First call: open fence
      let results = [...settler(ctx('```python\n'))]
      expect(results).toEqual([
        { content: '```python\n', meta: { inCodeFence: true, language: 'python' } },
      ])
      // Second call: code lines (settler is stateful)
      results = [...settler(ctx('def foo():\n    pass\n'))]
      expect(results).toEqual([
        { content: 'def foo():\n', meta: { inCodeFence: true, language: 'python' } },
        { content: '    pass\n', meta: { inCodeFence: true, language: 'python' } },
      ])
    })

    it('should detect fence closing', () => {
      const settler = codeFence()
      // Open fence
      let results = [...settler(ctx('```python\n'))]
      expect(results.length).toBe(1)
      // Code line
      results = [...settler(ctx('code\n'))]
      expect(results.length).toBe(1)
      // Close fence
      results = [...settler(ctx('```\n'))]
      expect(results).toEqual([
        { content: '```\n', meta: { inCodeFence: false, language: 'python' } },
      ])
    })

    it('should handle full code block in one call', () => {
      const settler = codeFence()
      const results = [...settler(ctx('```js\nconst x = 1\n```\nafter'))]
      expect(results).toEqual([
        { content: '```js\n', meta: { inCodeFence: true, language: 'js' } },
        { content: 'const x = 1\n', meta: { inCodeFence: true, language: 'js' } },
        { content: '```\n', meta: { inCodeFence: false, language: 'js' } },
      ])
    })

    it('should handle text before fence', () => {
      const settler = codeFence()
      const results = [...settler(ctx('Here is code:\n\n```python\n'))]
      expect(results).toEqual([
        { content: 'Here is code:\n\n' },
        { content: '```python\n', meta: { inCodeFence: true, language: 'python' } },
      ])
    })

    it('should handle incomplete line inside fence (no yield)', () => {
      const settler = codeFence()
      // Open fence
      let results = [...settler(ctx('```python\n'))]
      expect(results.length).toBe(1)
      // Incomplete line (no \n at end)
      results = [...settler(ctx('def foo'))]
      expect(results).toEqual([])
    })

    it('should handle multiple code blocks across calls (stateful)', () => {
      const settler = codeFence()
      
      // First block
      let results = [...settler(ctx('```js\na\n```\n'))]
      expect(results).toEqual([
        { content: '```js\n', meta: { inCodeFence: true, language: 'js' } },
        { content: 'a\n', meta: { inCodeFence: true, language: 'js' } },
        { content: '```\n', meta: { inCodeFence: false, language: 'js' } },
      ])
      
      // Paragraph break (outside fence now)
      results = [...settler(ctx('\n\n'))]
      expect(results).toEqual([{ content: '\n\n' }])
      
      // Second block
      results = [...settler(ctx('```python\nb\n```\n'))]
      expect(results).toEqual([
        { content: '```python\n', meta: { inCodeFence: true, language: 'python' } },
        { content: 'b\n', meta: { inCodeFence: true, language: 'python' } },
        { content: '```\n', meta: { inCodeFence: false, language: 'python' } },
      ])
    })

    describe('limitations of simple codeFence (use shiki/settlers for full support)', () => {
      /**
       * The simple codeFence in settlers.ts has known limitations:
       * - Only handles exactly ``` (3 backticks)
       * - Doesn't support ~~~ (tilde fences)
       * - Doesn't support variable-length fences (````, ~~~~~ etc.)
       * 
       * For full CommonMark compliance, use codeFence from shiki/settlers.ts
       */
      
      it.skip('does NOT handle tilde fences (use shiki/settlers instead)', () => {
        const settler = codeFence()
        const results = [...settler(ctx('~~~python\ncode\n~~~\n'))]
        
        // This WILL FAIL - simple codeFence doesn't recognize ~~~
        // It will treat the whole thing as regular text waiting for \n\n
        const fenceStart = results.find(r => (r as any).meta?.inCodeFence)
        expect(fenceStart).toBeDefined() // Would fail - returns undefined
      })
      
      it.skip('does NOT handle 4-backtick fences (use shiki/settlers instead)', () => {
        const settler = codeFence()
        const results = [...settler(ctx('````python\ncode with ``` inside\n````\n'))]
        
        // This WILL FAIL - simple codeFence only matches exactly ```
        // The ```` won't be recognized as a fence opener
        const fenceStart = results.find(r => (r as any).meta?.inCodeFence)
        expect(fenceStart).toBeDefined() // Would fail
      })
    })
  })
})
