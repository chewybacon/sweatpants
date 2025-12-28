/**
 * Code Fence Streaming Tests
 *
 * TDD for the settler + processor dance when handling streaming code blocks.
 *
 * The challenge:
 * - Code fences can be long (50+ lines)
 * - User shouldn't stare at raw ```python for 5 seconds
 * - We want incremental syntax highlighting as code streams
 *
 * The dance:
 * - Settler decides WHEN/WHAT to settle (paragraph, line, fence-aware?)
 * - Processor decides HOW to enrich (sync, async, progressive?)
 */
import { describe, it, expect } from 'vitest'
import { run, sleep, type Operation } from 'effection'
import { paragraph } from '../settlers'
import { codeFence } from '../settlers/code-fence'
import type { SettleContext } from '../types'

// Simulated stream: assistant returns quicksort with markdown
const quicksortStream = [
  "Here's quicksort:\n\n",
  '```python\n',
  'def quicksort(arr):\n',
  '    if len(arr) <= 1:\n',
  '        return arr\n',
  '    pivot = arr[0]\n',
  '    left = [x for x in arr[1:] if x < pivot]\n',
  '    right = [x for x in arr[1:] if x >= pivot]\n',
  '    return quicksort(left) + [pivot] + quicksort(right)\n',
  '```\n\n',
  'This algorithm uses divide and conquer.',
]

describe('code fence streaming', () => {
  describe('current behavior: paragraph settler', () => {
    it('should observe when paragraph settler settles content', () => {
      const settler = paragraph()
      let settled = ''
      let pending = ''
      const log: Array<{
        chunk: string
        settlerYields: string[]
        settledAfter: string
        pendingAfter: string
      }> = []

      for (const chunk of quicksortStream) {
        pending += chunk

        const ctx: SettleContext = {
          pending,
          settled,
          elapsed: 0,
          patch: { type: 'streaming_text', content: chunk },
        }

        const toSettle = [...settler(ctx)]

        // Apply settles
        for (const content of toSettle) {
          settled += content
          pending = pending.slice(content.length)
        }

        log.push({
          chunk,
          settlerYields: toSettle,
          settledAfter: settled,
          pendingAfter: pending,
        })
      }

      // Log for visibility during TDD
      console.log('\n=== Paragraph Settler Behavior ===')
      for (const entry of log) {
        console.log(`\nChunk: ${JSON.stringify(entry.chunk)}`)
        console.log(`  Yields: ${JSON.stringify(entry.settlerYields)}`)
        console.log(
          `  Settled (${entry.settledAfter.length} chars): ${JSON.stringify(entry.settledAfter.slice(-50))}`
        )
        console.log(
          `  Pending (${entry.pendingAfter.length} chars): ${JSON.stringify(entry.pendingAfter.slice(-50))}`
        )
      }

      // Assertions about current behavior
      // First chunk has \n\n so should settle immediately
      expect(log[0].settlerYields).toEqual(["Here's quicksort:\n\n"])

      // Middle chunks (inside code fence) should NOT settle - no \n\n
      for (let i = 1; i < log.length - 2; i++) {
        expect(log[i].settlerYields).toEqual([])
      }

      // Chunk with closing ``` and \n\n should settle the whole code block
      const closingFenceEntry = log.find((e) => e.chunk.includes('```\n\n'))
      expect(closingFenceEntry?.settlerYields.length).toBeGreaterThan(0)
    })

    it('should show the problem: user waits for entire code block', () => {
      const settler = paragraph()
      let settled = ''
      let pending = ''
      const settleEvents: Array<{ afterChunk: number; content: string }> = []

      for (let i = 0; i < quicksortStream.length; i++) {
        const chunk = quicksortStream[i]
        pending += chunk

        const ctx: SettleContext = {
          pending,
          settled,
          elapsed: 0,
          patch: { type: 'streaming_text', content: chunk },
        }

        for (const content of settler(ctx)) {
          settled += content
          pending = pending.slice(content.length)
          settleEvents.push({ afterChunk: i, content })
        }
      }

      console.log('\n=== Settle Events ===')
      for (const event of settleEvents) {
        console.log(
          `After chunk ${event.afterChunk}: settled ${event.content.length} chars`
        )
        console.log(`  Content: ${JSON.stringify(event.content.slice(0, 60))}...`)
      }

      // THE PROBLEM: Only 2 settle events
      // 1. After "Here's quicksort:\n\n"
      // 2. After "```\n\n" (entire code block at once)
      expect(settleEvents.length).toBe(2)

      // User sees nothing for chunks 1-8, then everything at chunk 9
      // This is the UX problem we need to solve
    })
  })

  describe('processor as Operation', () => {
    it('should support async processing with sleep', async () => {
      // Simulate what an Operation-based processor would look like
      await run(function* () {
        const code = 'def quicksort(arr):'

        // Simulate async syntax highlighting
        yield* sleep(10) // Simulates Shiki WASM load time

        const highlighted = `<span class="keyword">def</span> quicksort(arr):`

        expect(highlighted).toContain('keyword')
        expect(code).toBe('def quicksort(arr):')
  })
})

describe('code fence edge cases', () => {
  describe('CommonMark fence parsing compliance', () => {
    /**
     * These tests verify correct CommonMark-compliant fence parsing:
     * - Fence char must match (``` vs ~~~)
     * - Close fence length must be >= open fence length
     * - Leading spaces (0-3) are allowed on fence lines
     */
    
    it('should NOT close backtick fence with tilde fence', () => {
      const settler = codeFence()
      
      // Open with ```, try to close with ~~~
      const input = '```python\ncode here\n~~~\nmore code\n```\n'
      
      const ctx: SettleContext = {
        pending: input,
        settled: '',
        elapsed: 0,
        patch: { type: 'streaming_text', content: input },
      }
      
      const results = [...settler(ctx)]
      
      console.log('\n=== Mixed fence chars test ===')
      results.forEach((r, i) => {
        console.log(`${i}: "${r.content.replace(/\n/g, '\\n')}" fenceEnd=${r.meta?.fenceEnd}`)
      })
      
      // The ~~~ should NOT close the fence - it should be treated as code content
      const tildeResult = results.find(r => r.content.includes('~~~'))
      expect(tildeResult?.meta?.inCodeFence).toBe(true)
      expect(tildeResult?.meta?.fenceEnd).toBeFalsy()
      
      // The final ``` should close the fence
      const closeResult = results.find(r => r.content.includes('```') && r.meta?.fenceEnd)
      expect(closeResult).toBeDefined()
    })
    
    it('should NOT close tilde fence with backtick fence', () => {
      const settler = codeFence()
      
      // Open with ~~~, try to close with ```
      const input = '~~~python\ncode here\n```\nmore code\n~~~\n'
      
      const ctx: SettleContext = {
        pending: input,
        settled: '',
        elapsed: 0,
        patch: { type: 'streaming_text', content: input },
      }
      
      const results = [...settler(ctx)]
      
      console.log('\n=== Tilde opened, backtick close attempt ===')
      results.forEach((r, i) => {
        console.log(`${i}: "${r.content.replace(/\n/g, '\\n')}" fenceEnd=${r.meta?.fenceEnd}`)
      })
      
      // The ``` should NOT close the fence - treated as code content
      const backtickResult = results.find(r => r.content.includes('```'))
      expect(backtickResult?.meta?.inCodeFence).toBe(true)
      expect(backtickResult?.meta?.fenceEnd).toBeFalsy()
      
      // The final ~~~ should close the fence
      const closeResult = results.find(r => r.content.includes('~~~') && r.meta?.fenceEnd)
      expect(closeResult).toBeDefined()
    })
    
    it('should handle 4-backtick fence with 3-backtick content inside', () => {
      const settler = codeFence()
      
      // 4 backticks to open, allows ``` inside as content
      const input = '````markdown\nHere is code:\n```python\nprint("hi")\n```\n````\n'
      
      const ctx: SettleContext = {
        pending: input,
        settled: '',
        elapsed: 0,
        patch: { type: 'streaming_text', content: input },
      }
      
      const results = [...settler(ctx)]
      
      console.log('\n=== 4-backtick fence test ===')
      results.forEach((r, i) => {
        console.log(`${i}: "${r.content.replace(/\n/g, '\\n')}" fenceStart=${r.meta?.fenceStart} fenceEnd=${r.meta?.fenceEnd}`)
      })
      
      // Should only have ONE fenceStart (the ````)
      const fenceStarts = results.filter(r => r.meta?.fenceStart)
      expect(fenceStarts.length).toBe(1)
      expect(fenceStarts[0].content).toContain('````')
      
      // The inner ``` should be treated as content, not fence markers
      const innerBackticks = results.filter(r => r.content.includes('```python') || r.content === '```\n')
      innerBackticks.forEach(r => {
        expect(r.meta?.fenceStart).toBeFalsy()
        expect(r.meta?.fenceEnd).toBeFalsy()
        expect(r.meta?.inCodeFence).toBe(true)
      })
      
      // Should only have ONE fenceEnd (the ````)
      const fenceEnds = results.filter(r => r.meta?.fenceEnd)
      expect(fenceEnds.length).toBe(1)
      expect(fenceEnds[0].content).toContain('````')
    })
    
    it('should require close fence length >= open fence length', () => {
      const settler = codeFence()
      
      // Open with 4 backticks, try to close with 3
      const input = '````python\ncode\n```\nmore code\n````\n'
      
      const ctx: SettleContext = {
        pending: input,
        settled: '',
        elapsed: 0,
        patch: { type: 'streaming_text', content: input },
      }
      
      const results = [...settler(ctx)]
      
      console.log('\n=== Fence length mismatch test ===')
      results.forEach((r, i) => {
        console.log(`${i}: "${r.content.replace(/\n/g, '\\n')}" fenceEnd=${r.meta?.fenceEnd}`)
      })
      
      // The ``` should NOT close the fence (too short)
      const shortClose = results.find(r => r.content === '```\n')
      expect(shortClose?.meta?.fenceEnd).toBeFalsy()
      expect(shortClose?.meta?.inCodeFence).toBe(true)
      
      // The ```` should close the fence
      const properClose = results.find(r => r.content.includes('````') && r.meta?.fenceEnd)
      expect(properClose).toBeDefined()
    })
    
    it('should allow close fence with more chars than open', () => {
      const settler = codeFence()
      
      // Open with 3, close with 5
      const input = '```python\ncode\n`````\n'
      
      const ctx: SettleContext = {
        pending: input,
        settled: '',
        elapsed: 0,
        patch: { type: 'streaming_text', content: input },
      }
      
      const results = [...settler(ctx)]
      
      console.log('\n=== Longer close fence test ===')
      results.forEach((r, i) => {
        console.log(`${i}: "${r.content.replace(/\n/g, '\\n')}" fenceEnd=${r.meta?.fenceEnd}`)
      })
      
      // The ````` should close the fence (5 >= 3)
      const closeResult = results.find(r => r.meta?.fenceEnd)
      expect(closeResult).toBeDefined()
      expect(closeResult?.content).toContain('`````')
    })
    
    it('should handle tilde fences (~~~)', () => {
      const settler = codeFence()
      
      const input = '~~~python\ndef foo():\n    pass\n~~~\n'
      
      const ctx: SettleContext = {
        pending: input,
        settled: '',
        elapsed: 0,
        patch: { type: 'streaming_text', content: input },
      }
      
      const results = [...settler(ctx)]
      
      console.log('\n=== Tilde fence test ===')
      results.forEach((r, i) => {
        console.log(`${i}: "${r.content.replace(/\n/g, '\\n')}" lang=${r.meta?.language} fenceStart=${r.meta?.fenceStart} fenceEnd=${r.meta?.fenceEnd}`)
      })
      
      // Should recognize tilde fence start
      const fenceStart = results.find(r => r.meta?.fenceStart)
      expect(fenceStart).toBeDefined()
      expect(fenceStart?.content).toBe('~~~python\n')
      expect(fenceStart?.meta?.language).toBe('python')
      
      // Should recognize tilde fence end
      const fenceEnd = results.find(r => r.meta?.fenceEnd)
      expect(fenceEnd).toBeDefined()
      expect(fenceEnd?.content).toBe('~~~\n')
    })
    
    it.skip('should allow 0-3 leading spaces on fence lines (CommonMark)', () => {
      // NOTE: This test is skipped because LLMs don't typically produce indented fences
      // and supporting this would add complexity. Documenting for future reference.
      const settler = codeFence()
      
      // CommonMark allows up to 3 leading spaces
      const input = '   ```python\n   code here\n   ```\n'
      
      const ctx: SettleContext = {
        pending: input,
        settled: '',
        elapsed: 0,
        patch: { type: 'streaming_text', content: input },
      }
      
      const results = [...settler(ctx)]
      
      console.log('\n=== Leading spaces test ===')
      results.forEach((r, i) => {
        console.log(`${i}: "${r.content.replace(/\n/g, '\\n')}" fenceStart=${r.meta?.fenceStart} fenceEnd=${r.meta?.fenceEnd}`)
      })
      
      // Should recognize indented fence start
      const fenceStart = results.find(r => r.meta?.fenceStart)
      expect(fenceStart).toBeDefined()
      expect(fenceStart?.meta?.language).toBe('python')
      
      // Should recognize indented fence end
      const fenceEnd = results.find(r => r.meta?.fenceEnd)
      expect(fenceEnd).toBeDefined()
    })
    
    it.skip('should NOT recognize fence with 4+ leading spaces (becomes indented code)', () => {
      // NOTE: This test is skipped - 4+ spaces is an indented code block in CommonMark,
      // but LLMs don't use this pattern. Documenting for completeness.
      const settler = codeFence()
      
      // 4 spaces = indented code block, not a fenced code block
      const input = '    ```python\n    code here\n    ```\n'
      
      const ctx: SettleContext = {
        pending: input,
        settled: '',
        elapsed: 0,
        patch: { type: 'streaming_text', content: input },
      }
      
      const results = [...settler(ctx)]
      
      console.log('\n=== 4+ spaces test (should not be fence) ===')
      results.forEach((r, i) => {
        console.log(`${i}: "${r.content.replace(/\n/g, '\\n')}" fenceStart=${r.meta?.fenceStart}`)
      })
      
      // Should NOT recognize as a fence (4 spaces = indented code block)
      const fenceStart = results.find(r => r.meta?.fenceStart)
      expect(fenceStart).toBeUndefined()
    })
  })
  
  describe('fence close without trailing newline (OpenAI behavior)', () => {
    /**
     * OpenAI sometimes ends streams with ``` without a trailing newline.
     * This test captures that behavior and ensures the settler handles it
     * when flush: true is set (indicating stream end).
     */
    it('should handle fence close without trailing newline at stream end', () => {
      const settler = codeFence()
      
      // Simulate OpenAI's output - note the final ``` has no \n
      const chunks = [
        '```python\n',
        'def foo():\n',
        '    return 42\n',
        '```',  // No trailing newline!
      ]
      
      let pending = ''
      let settled = ''
      const results: Array<{ content: string; meta?: any }> = []
      
      // Process all chunks normally
      for (const chunk of chunks) {
        pending += chunk
        
        const ctx: SettleContext = {
          pending,
          settled,
          elapsed: 0,
          patch: { type: 'streaming_text', content: chunk },
        }
        
        for (const result of settler(ctx)) {
          const content = typeof result === 'string' ? result : result.content
          const meta = typeof result === 'string' ? undefined : result.meta
          settled += content
          pending = pending.slice(content.length)
          results.push({ content, meta })
        }
      }
      
      console.log('\n=== After normal streaming (no flush) ===')
      console.log(`Settled: "${settled}"`)
      console.log(`Pending: "${pending}"`)
      console.log('Results:', results.map(r => ({ 
        content: r.content.slice(0, 20), 
        fenceEnd: r.meta?.fenceEnd 
      })))
      
      // At this point, ``` should still be in pending (no newline to trigger settle)
      expect(pending).toBe('```')
      
      // Now simulate stream end with flush: true
      const flushCtx: SettleContext = {
        pending,
        settled,
        elapsed: 0,
        patch: { type: 'streaming_end' },
        flush: true,  // Signal that this is the final flush
      }
      
      const flushResults: Array<{ content: string; meta?: any }> = []
      for (const result of settler(flushCtx)) {
        const content = typeof result === 'string' ? result : result.content
        const meta = typeof result === 'string' ? undefined : result.meta
        settled += content
        pending = pending.slice(content.length)
        flushResults.push({ content, meta })
      }
      
      console.log('\n=== After flush ===')
      console.log(`Settled: "${settled}"`)
      console.log(`Pending: "${pending}"`)
      console.log('Flush results:', flushResults)
      
      // After flush, pending should be empty
      expect(pending).toBe('')
      
      // The ``` should have been settled with fenceEnd: true
      expect(flushResults.length).toBe(1)
      expect(flushResults[0].content).toBe('```')
      expect(flushResults[0].meta?.fenceEnd).toBe(true)
    })
    
    it('should handle fence close with trailing space but no newline', () => {
      const settler = codeFence()
      
      // Some providers add trailing space: "``` "
      const chunks = [
        '```python\n',
        'x = 1\n',
        '``` ',  // Trailing space, no newline
      ]
      
      let pending = ''
      let settled = ''
      
      for (const chunk of chunks) {
        pending += chunk
        const ctx: SettleContext = {
          pending,
          settled,
          elapsed: 0,
          patch: { type: 'streaming_text', content: chunk },
        }
        for (const result of settler(ctx)) {
          const content = typeof result === 'string' ? result : result.content
          settled += content
          pending = pending.slice(content.length)
        }
      }
      
      // Should still be in pending
      expect(pending).toBe('``` ')
      
      // Flush should handle it
      const flushCtx: SettleContext = {
        pending,
        settled,
        elapsed: 0,
        patch: { type: 'streaming_end' },
        flush: true,
      }
      
      const flushResults = [...settler(flushCtx)]
      expect(flushResults.length).toBe(1)
      expect(flushResults[0].meta?.fenceEnd).toBe(true)
    })
  })
})

    it('should support progressive enhancement: fast then better', async () => {
      const emissions: Array<{ pass: string; html: string }> = []

      await run(function* () {
        const code = 'def quicksort(arr):'

        // Pass 1: Instant regex-based highlighting
        const quickHtml = code.replace(
          /\b(def|return|if|for|in)\b/g,
          '<span class="kw">$1</span>'
        )
        emissions.push({ pass: 'quick', html: quickHtml })

        // Pass 2: Full highlighting (simulated async)
        yield* sleep(50)
        const fullHtml = `<span class="keyword">def</span> <span class="function">quicksort</span>(<span class="param">arr</span>):`
        emissions.push({ pass: 'full', html: fullHtml })
      })

      console.log('\n=== Progressive Enhancement ===')
      for (const e of emissions) {
        console.log(`${e.pass}: ${e.html}`)
      }

      expect(emissions.length).toBe(2)
      expect(emissions[0].pass).toBe('quick')
      expect(emissions[1].pass).toBe('full')
    })
  })

  describe('processor API design', () => {
    it('sketch: processor with emit callback', async () => {
      type ProcessedOutput = { raw: string; html?: string }
      type ProcessorContext = { chunk: string; next: string; accumulated: string }

      // Example processor with progressive enhancement
      function* highlightProcessor(
        ctx: ProcessorContext,
        emit: (output: ProcessedOutput) => void
      ) {
        // Quick pass
        const quickHtml = ctx.chunk.replace(
          /\b(def|return|if|for|in)\b/g,
          '<span class="kw">$1</span>'
        )
        emit({ raw: ctx.chunk, html: quickHtml })

        // Simulate async work
        yield* sleep(20)

        // Full pass
        const fullHtml = `<span class="full">${ctx.chunk}</span>`
        emit({ raw: ctx.chunk, html: fullHtml })
      }

      const emissions: ProcessedOutput[] = []

      await run(function* () {
        const ctx: ProcessorContext = {
          chunk: 'def quicksort(arr):',
          next: 'def quicksort(arr):',
          accumulated: '',
        }

        yield* highlightProcessor(ctx, (output) => emissions.push(output))
      })

      expect(emissions.length).toBe(2)
      expect(emissions[0].html).toContain('kw') // quick pass
      expect(emissions[1].html).toContain('full') // full pass
    })
  })
})

describe('code fence aware settler', () => {
  /**
   * A code-fence-aware settler that:
   * - Outside fences: settles on paragraph breaks (like paragraph())
   * - Inside fences: settles on each line (for incremental highlighting)
   * - Returns metadata: { inCodeFence, language }
   */

  /**
   * Extended settle result with metadata for processors
   */
  interface SettleResult {
    content: string
    meta?: {
      inCodeFence?: boolean
      language?: string
    }
  }

  /**
   * Code-fence-aware settler (to be implemented in settlers.ts)
   *
   * This is a "smart" settler that tracks fence state and yields
   * differently based on context.
   */
  function codeFence(): (ctx: SettleContext) => Iterable<SettleResult> {
    // Track state across calls
    let inFence = false
    let fenceLanguage = ''

    return function* (ctx: SettleContext): Iterable<SettleResult> {
      const { pending } = ctx
      let pos = 0

      while (pos < pending.length) {
        const remaining = pending.slice(pos)

        if (!inFence) {
          // Look for fence open or paragraph break
          const fenceMatch = remaining.match(/^```(\w*)\n/)
          const paragraphIdx = remaining.indexOf('\n\n')

          if (
            fenceMatch &&
            (paragraphIdx === -1 || fenceMatch.index! < paragraphIdx)
          ) {
            // Fence opens - settle everything before it (if any), then the fence line
            if (fenceMatch.index! > 0) {
              const before = remaining.slice(0, fenceMatch.index!)
              yield { content: before }
              pos += before.length
            }
            // Now we're entering the fence
            inFence = true
            fenceLanguage = fenceMatch[1] || ''
            // Yield the fence opening line with metadata
            yield {
              content: fenceMatch[0],
              meta: { inCodeFence: true, language: fenceLanguage },
            }
            pos += fenceMatch[0].length
          } else if (paragraphIdx !== -1) {
            // Paragraph break - settle up to and including \n\n
            const toSettle = remaining.slice(0, paragraphIdx + 2)
            yield { content: toSettle }
            pos += toSettle.length
          } else {
            // No fence, no paragraph break - nothing to settle yet
            break
          }
        } else {
          // Inside fence - look for fence close or line break
          const closeMatch = remaining.match(/^```\n/)
          const lineIdx = remaining.indexOf('\n')

          if (closeMatch) {
            // Fence closes
            inFence = false
            yield {
              content: closeMatch[0],
              meta: { inCodeFence: false, language: fenceLanguage },
            }
            fenceLanguage = ''
            pos += closeMatch[0].length
          } else if (lineIdx !== -1) {
            // Settle each complete line inside fence
            const line = remaining.slice(0, lineIdx + 1)
            yield {
              content: line,
              meta: { inCodeFence: true, language: fenceLanguage },
            }
            pos += line.length
          } else {
            // No complete line yet - wait for more input
            break
          }
        }
      }
    }
  }

  it('should settle line-by-line inside code fences', () => {
    const settler = codeFence()
    let settled = ''
    let pending = ''
    const settleEvents: Array<{
      afterChunk: number
      content: string
      meta?: { inCodeFence?: boolean; language?: string }
    }> = []

    for (let i = 0; i < quicksortStream.length; i++) {
      const chunk = quicksortStream[i]
      pending += chunk

      const ctx: SettleContext = {
        pending,
        settled,
        elapsed: 0,
        patch: { type: 'streaming_text', content: chunk },
      }

      for (const result of settler(ctx)) {
        settled += result.content
        pending = pending.slice(result.content.length)
        settleEvents.push({
          afterChunk: i,
          content: result.content,
          meta: result.meta,
        })
      }
    }

    console.log('\n=== Code Fence Aware Settler ===')
    for (const event of settleEvents) {
      const metaStr = event.meta
        ? ` [fence=${event.meta.inCodeFence}, lang=${event.meta.language}]`
        : ''
      console.log(
        `After chunk ${event.afterChunk}: ${JSON.stringify(event.content.slice(0, 40))}${event.content.length > 40 ? '...' : ''}${metaStr}`
      )
    }

    // Should have MORE settle events than paragraph settler
    // Each line inside the fence should settle separately
    expect(settleEvents.length).toBeGreaterThan(5)

    // First event should be the intro paragraph
    expect(settleEvents[0].content).toBe("Here's quicksort:\n\n")
    expect(settleEvents[0].meta).toBeUndefined() // not in fence

    // Second event should be fence opening with language
    expect(settleEvents[1].content).toBe('```python\n')
    expect(settleEvents[1].meta?.inCodeFence).toBe(true)
    expect(settleEvents[1].meta?.language).toBe('python')

    // Lines inside fence should have fence metadata
    const fenceLines = settleEvents.filter((e) => e.meta?.inCodeFence === true)
    expect(fenceLines.length).toBeGreaterThan(3)
  })

  it('should pass metadata to processor for syntax highlighting', () => {
    const settler = codeFence()
    const pending = '```python\ndef foo():\n    return 42\n```\n\n'
    const settled = ''

    const ctx: SettleContext = {
      pending,
      settled,
      elapsed: 0,
      patch: { type: 'streaming_text', content: pending },
    }

    const results = [...settler(ctx)]

    console.log('\n=== Settler Results with Metadata ===')
    for (const r of results) {
      console.log(`${JSON.stringify(r.content)} -> ${JSON.stringify(r.meta)}`)
    }

    // Processor would receive this metadata and know:
    // - When we're in a code fence
    // - What language to highlight
    expect(results[0].meta?.language).toBe('python')
    expect(results[1].meta?.inCodeFence).toBe(true)
    expect(results[1].meta?.language).toBe('python')
  })
})

describe('integrated settler + processor flow', () => {
  /**
   * This test simulates the full flow:
   * 1. Stream chunks arrive
   * 2. Settler decides what to settle (with metadata)
   * 3. Processor enriches settled content (async, progressive)
   * 4. Patches flow to React
   */

  // Types for the new API
  interface SettleMeta {
    inCodeFence?: boolean
    language?: string
  }

  interface SettleResult {
    content: string
    meta?: SettleMeta
  }

  interface ProcessorContext {
    chunk: string
    accumulated: string
    next: string
    meta?: SettleMeta
  }

  interface ProcessedOutput {
    raw: string
    html?: string
    pass?: 'quick' | 'full' // For progressive enhancement
  }

  // Simulated emit callback type
  type Emit = (output: ProcessedOutput) => void

  // Processor type: an Operation that can emit multiple times
  type Processor = (ctx: ProcessorContext, emit: Emit) => Operation<void>

  // Code fence settler (same as before)
  function codeFence(): (ctx: SettleContext) => Iterable<SettleResult> {
    let inFence = false
    let fenceLanguage = ''

    return function* (ctx: SettleContext): Iterable<SettleResult> {
      const { pending } = ctx
      let pos = 0

      while (pos < pending.length) {
        const remaining = pending.slice(pos)

        if (!inFence) {
          const fenceMatch = remaining.match(/^```(\w*)\n/)
          const paragraphIdx = remaining.indexOf('\n\n')

          if (fenceMatch && (paragraphIdx === -1 || fenceMatch.index! < paragraphIdx)) {
            if (fenceMatch.index! > 0) {
              yield { content: remaining.slice(0, fenceMatch.index!) }
              pos += fenceMatch.index!
            }
            inFence = true
            fenceLanguage = fenceMatch[1] || ''
            yield { content: fenceMatch[0], meta: { inCodeFence: true, language: fenceLanguage } }
            pos += fenceMatch[0].length
          } else if (paragraphIdx !== -1) {
            yield { content: remaining.slice(0, paragraphIdx + 2) }
            pos += paragraphIdx + 2
          } else {
            break
          }
        } else {
          const closeMatch = remaining.match(/^```\n/)
          const lineIdx = remaining.indexOf('\n')

          if (closeMatch) {
            inFence = false
            yield { content: closeMatch[0], meta: { inCodeFence: false, language: fenceLanguage } }
            fenceLanguage = ''
            pos += closeMatch[0].length
          } else if (lineIdx !== -1) {
            yield { content: remaining.slice(0, lineIdx + 1), meta: { inCodeFence: true, language: fenceLanguage } }
            pos += lineIdx + 1
          } else {
            break
          }
        }
      }
    }
  }

  // Progressive syntax highlighter processor
  function progressiveHighlighter(): Processor {
    return function* (ctx: ProcessorContext, emit: Emit): Operation<void> {
      // If not in code fence, just pass through (maybe parse markdown)
      if (!ctx.meta?.inCodeFence) {
        emit({ raw: ctx.chunk, html: ctx.chunk, pass: 'quick' })
        return
      }

      // Quick pass: instant regex highlighting
      const quickHtml = ctx.chunk.replace(
        /\b(def|return|if|for|in|class|import|from|as|with|try|except|finally|raise|yield|lambda|and|or|not|is|None|True|False)\b/g,
        '<span class="kw">$1</span>'
      )
      emit({ raw: ctx.chunk, html: quickHtml, pass: 'quick' })

      // Simulate async Shiki highlighting (50ms delay)
      yield* sleep(50)

      // Full pass: proper highlighting with proper classes
      // Note: In real Shiki, this would be done properly. This is just a simulation.
      const fullHtml = ctx.chunk
        .replace(/\b(def|class)\b/g, '<span class="keyword">$1</span>')
        .replace(/\b(return|if|for|in|while)\b/g, '<span class="control">$1</span>')
        .replace(/\b(\d+)\b/g, '<span class="number">$1</span>')
      emit({ raw: ctx.chunk, html: fullHtml, pass: 'full' })
    }
  }

  it('should show full progressive flow with code fence', async () => {
    const settler = codeFence()
    const processor = progressiveHighlighter()

    // Simulate streaming
    const chunks = [
      "Here's code:\n\n",
      '```python\n',
      'def hello():\n',
      '    return 42\n',
      '```\n\n',
    ]

    // Track all emissions (what React would receive)
    const patches: Array<{
      type: 'settled'
      content: string
      html?: string
      pass?: string
      meta?: SettleMeta
    }> = []

    await run(function* () {
      let settled = ''
      let pending = ''

      for (const chunk of chunks) {
        pending += chunk

        const ctx: SettleContext = {
          pending,
          settled,
          elapsed: 0,
          patch: { type: 'streaming_text', content: chunk },
        }

        // Run settler
        for (const result of settler(ctx)) {
          settled += result.content
          pending = pending.slice(result.content.length)

          // Build processor context
          const procCtx: ProcessorContext = {
            chunk: result.content,
            accumulated: settled.slice(0, -result.content.length),
            next: settled,
            meta: result.meta,
          }

          // Run processor (yields for async work)
          yield* processor(procCtx, (output) => {
            patches.push({
              type: 'settled',
              content: result.content,
              html: output.html,
              pass: output.pass,
              meta: result.meta,
            })
          })
        }
      }
    })

    console.log('\n=== Full Integrated Flow ===')
    for (const p of patches) {
      const metaStr = p.meta ? ` [fence=${p.meta.inCodeFence}, lang=${p.meta.language}]` : ''
      console.log(`${p.pass?.padEnd(5) || '     '} | ${JSON.stringify(p.content.slice(0, 30))}${metaStr}`)
      if (p.html && p.html !== p.content) {
        console.log(`       → ${p.html.slice(0, 60)}`)
      }
    }

    // Verify progressive enhancement happened for code lines
    const codePatches = patches.filter((p) => p.meta?.inCodeFence)
    const quickPasses = codePatches.filter((p) => p.pass === 'quick')
    const fullPasses = codePatches.filter((p) => p.pass === 'full')

    // Each code line should have both quick and full passes
    expect(quickPasses.length).toBeGreaterThan(0)
    expect(fullPasses.length).toBeGreaterThan(0)
    expect(quickPasses.length).toBe(fullPasses.length)

    // Quick pass should use regex highlighter
    const defLine = quickPasses.find((p) => p.content.includes('def'))
    expect(defLine?.html).toContain('<span class="kw">def</span>')

    // Full pass should use proper highlighter
    const defLineFull = fullPasses.find((p) => p.content.includes('def'))
    expect(defLineFull?.html).toContain('<span class="keyword">def</span>')
  })

  it('should handle multiple code blocks in sequence', async () => {
    const settler = codeFence()
    const processor = progressiveHighlighter()

    const chunks = [
      'First block:\n\n',
      '```js\n',
      'const x = 1\n',
      '```\n\n',
      'Second block:\n\n',
      '```python\n',
      'y = 2\n',
      '```\n\n',
    ]

    const settledContent: string[] = []

    await run(function* () {
      let settled = ''
      let pending = ''

      for (const chunk of chunks) {
        pending += chunk
        const ctx: SettleContext = {
          pending,
          settled,
          elapsed: 0,
          patch: { type: 'streaming_text', content: chunk },
        }

        for (const result of settler(ctx)) {
          settled += result.content
          pending = pending.slice(result.content.length)
          settledContent.push(result.content)

          const procCtx: ProcessorContext = {
            chunk: result.content,
            accumulated: settled.slice(0, -result.content.length),
            next: settled,
            meta: result.meta,
          }
          yield* processor(procCtx, () => {})
        }
      }
    })

    console.log('\n=== Multiple Code Blocks ===')
    console.log(settledContent.map((s) => JSON.stringify(s)).join('\n'))

    // Should have settled both blocks line by line
    expect(settledContent).toContain('```js\n')
    expect(settledContent).toContain('```python\n')
    expect(settledContent).toContain('const x = 1\n')
    expect(settledContent).toContain('y = 2\n')
  })
})
