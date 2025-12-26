/**
 * Quick Highlight Tests
 * 
 * Tests the regex-based quick highlighting to ensure proper HTML output.
 * This helps debug issues where syntax colors don't appear.
 */
import { describe, it, expect } from 'vitest'
import { shikiProcessor, quickHighlightProcessor, codeFence } from '../shiki'
import type { ProcessorContext, SettleContext } from '../types'
import { runProcessorStream, settleCode } from './test-utils'

// Build processor contexts from settler results
function buildProcessorContexts(settlerResults: Array<{ content: string; meta: any }>): ProcessorContext[] {
  const contexts: ProcessorContext[] = []
  let accumulated = ''
  
  for (const result of settlerResults) {
    const next = accumulated + result.content
    contexts.push({
      chunk: result.content,
      accumulated,
      next,
      meta: result.meta,
    })
    accumulated = next
  }
  
  return contexts
}

describe('quick highlight', () => {
  describe('codeFence settler', () => {
    it('should yield lines with correct metadata', () => {
      const chunks = [
        '```python\n',
        'def foo():\n',
        '    return 42\n',
        '```\n',
      ]
      
      const results = settleCode(chunks)
      
      console.log('\n=== Settler Results ===')
      results.forEach((r, i) => {
        console.log(`${i}: "${r.content.replace(/\n/g, '\\n')}"`)
        console.log(`   meta:`, r.meta)
      })
      
      expect(results).toHaveLength(4)
      
      // First: fence start
      expect(results[0].content).toBe('```python\n')
      expect(results[0].meta.inCodeFence).toBe(true)
      expect(results[0].meta.fenceStart).toBe(true)
      expect(results[0].meta.language).toBe('python')
      
      // Middle: code lines
      expect(results[1].content).toBe('def foo():\n')
      expect(results[1].meta.inCodeFence).toBe(true)
      expect(results[1].meta.fenceStart).toBeUndefined()
      expect(results[1].meta.fenceEnd).toBeUndefined()
      
      expect(results[2].content).toBe('    return 42\n')
      expect(results[2].meta.inCodeFence).toBe(true)
      
      // Last: fence end
      expect(results[3].content).toBe('```\n')
      expect(results[3].meta.inCodeFence).toBe(true)
      expect(results[3].meta.fenceEnd).toBe(true)
    })
  })

  describe('quickHighlightProcessor', () => {
    it('should generate correct HTML for Python code', async () => {
      // Simulate a full code block stream through the processor
      const settlerResults = settleCode([
        '```python\n',
        'def foo():\n',
        '    return 42\n',
        '```\n',
      ])
      
      const contexts = buildProcessorContexts(settlerResults)
      const allEmissions = await runProcessorStream(quickHighlightProcessor, contexts)
      
      console.log('\n=== Processor Emissions per Context ===')
      allEmissions.forEach((emissions, i) => {
        console.log(`Context ${i} (${contexts[i].chunk.replace(/\n/g, '\\n')}):`)
        emissions.forEach((e, j) => {
          console.log(`  ${j}: pass=${e.pass || 'none'}`)
          console.log(`     html: "${e.html?.slice(0, 100)}..."`)
        })
      })
      
      // Fence start should not emit (processor returns early)
      expect(allEmissions[0]).toHaveLength(0)
      
      // Code line should emit with HTML
      expect(allEmissions[1]).toHaveLength(1)
      const firstCodeLineHtml = allEmissions[1][0].html!
      console.log('\n=== First Code Line HTML ===')
      console.log(firstCodeLineHtml)
      
      // Should have proper structure
      expect(firstCodeLineHtml).toContain('<pre class="code-block')
      expect(firstCodeLineHtml).toContain('<span class="ql-keyword">def</span>')
    })

    it('should generate valid HTML structure for complete code block', async () => {
      const settlerResults = settleCode([
        '```python\n',
        'def quicksort(arr):\n',
        '    if len(arr) <= 1:\n',
        '        return arr\n',
        '```\n',
      ])
      
      const contexts = buildProcessorContexts(settlerResults)
      const allEmissions = await runProcessorStream(quickHighlightProcessor, contexts)
      
      console.log('\n=== Full Code Block Processing ===')
      allEmissions.forEach((emissions, i) => {
        console.log(`${i}: ${contexts[i].chunk.replace(/\n/g, '\\n')} -> ${emissions.length} emissions`)
        if (emissions[0]?.html) {
          console.log(`   HTML: ${emissions[0].html.slice(0, 80)}...`)
        }
      })
      
      // Fence end should emit final HTML
      const lastEmissions = allEmissions[allEmissions.length - 1]
      expect(lastEmissions).toHaveLength(1)
      const finalHtml = lastEmissions[0].html!
      
      console.log('\n=== Final HTML ===')
      console.log(finalHtml)
      
      // Should have proper structure
      expect(finalHtml).toContain('<pre class="code-block')
      expect(finalHtml).toContain('<code')
      expect(finalHtml).toContain('</code>')
      expect(finalHtml).toContain('</pre>')
      
      // Should have highlighted keywords
      expect(finalHtml).toContain('<span class="ql-keyword">def</span>')
      expect(finalHtml).toContain('<span class="ql-keyword">if</span>')
      expect(finalHtml).toContain('<span class="ql-keyword">return</span>')
    })

    it('should NOT have broken tags or class names as visible text', async () => {
      const settlerResults = settleCode([
        '```python\n',
        'return x + y\n',
        '```\n',
      ])
      
      const contexts = buildProcessorContexts(settlerResults)
      const allEmissions = await runProcessorStream(quickHighlightProcessor, contexts)
      
      // Get the HTML from the code line (second context)
      const codeLineEmissions = allEmissions[1]
      expect(codeLineEmissions.length).toBeGreaterThan(0)
      
      const html = codeLineEmissions[0].html!
      
      console.log('\n=== Checking for broken tags ===')
      console.log('HTML:', html)
      
      // Should NOT have class name appearing as visible text
      // A broken tag would look like: "ql-keyword" return (unquoted class name)
      
      // The text "ql-keyword" should only appear inside class="..." attributes
      const qlMatches = html.match(/ql-\w+/g) || []
      const qlInAttr = html.match(/class="[^"]*ql-\w+[^"]*"/g) || []
      
      console.log('Total ql-* occurrences:', qlMatches.length)
      console.log('ql-* in class attributes:', qlInAttr.length)
      
      // Count how many ql-* appear in each class attribute
      let qlInAttrCount = 0
      for (const match of qlInAttr) {
        qlInAttrCount += (match.match(/ql-\w+/g) || []).length
      }
      
      console.log('ql-* tokens in class attributes:', qlInAttrCount)
      
      // Every occurrence should be inside a class attribute
      expect(qlMatches.length).toBe(qlInAttrCount)
    })
  })

  describe('trailing markdown after code block', () => {
    it('should handle markdown text that does not end with \\n\\n', async () => {
      // This reproduces the bug: blockquote at end of message without trailing \n\n
      const chunks = [
        '### Key Notes:\n\n',  // This will settle (ends with \n\n)
        '```python\n',
        'def foo(): pass\n',
        '```\n\n',  // This will settle (fence + \n\n)
        '> This is a blockquote without trailing newlines',  // This might NOT settle!
      ]
      
      const settler = codeFence()
      const results: Array<{ content: string; meta: any }> = []
      
      let pending = ''
      for (const chunk of chunks) {
        pending += chunk
        
        const ctx: SettleContext = {
          pending,
          elapsed: 0,
          settled: '',
          patch: { type: 'streaming_text', content: chunk },
        }
        
        for (const result of settler(ctx)) {
          results.push({ content: result.content, meta: result.meta || {} })
          pending = pending.slice(result.content.length)
        }
      }
      
      console.log('\n=== Settler Results for Trailing Markdown ===')
      results.forEach((r, i) => {
        console.log(`${i}: "${r.content.slice(0, 50).replace(/\n/g, '\\n')}..."`)
        console.log(`   meta:`, r.meta)
      })
      console.log(`Remaining pending: "${pending}"`)
      
      // The blockquote should be in pending (not settled) because there's no \n\n
      // This is the bug - we need to handle final content at stream end
      expect(pending).toBe('> This is a blockquote without trailing newlines')
      
      // Now simulate what happens when dualBuffer calls settleAll()
      // It should settle the remaining content without metadata
      console.log('\n=== Simulating settleAll() ===')
      console.log(`Final pending to be settled: "${pending}"`)
    })

    it('should render blockquote in final output when settling at stream end', async () => {
      // Simulate the full flow: settler results + final settle + processor
      const chunks = [
        '```python\n',
        'x = 1\n',
        '```\n\n',
        '> Why is this important?',  // No trailing \n\n
      ]
      
      // Step 1: Run settler on streaming chunks
      const settler = codeFence()
      const settlerResults: Array<{ content: string; meta: any }> = []
      let pending = ''
      
      for (const chunk of chunks) {
        pending += chunk
        const ctx: SettleContext = {
          pending,
          elapsed: 0,
          settled: '',
          patch: { type: 'streaming_text', content: chunk },
        }
        for (const result of settler(ctx)) {
          settlerResults.push({ content: result.content, meta: result.meta || {} })
          pending = pending.slice(result.content.length)
        }
      }
      
      // Step 2: Simulate settleAll() - final content with no metadata
      if (pending) {
        settlerResults.push({ content: pending, meta: {} })
        pending = ''
      }
      
      console.log('\n=== Full Settler Results (including final settle) ===')
      settlerResults.forEach((r, i) => {
        console.log(`${i}: "${r.content.slice(0, 40).replace(/\n/g, '\\n')}..." meta:`, r.meta)
      })
      
      // Step 3: Run through processor
      const contexts = buildProcessorContexts(settlerResults)
      const allEmissions = await runProcessorStream(shikiProcessor, contexts)
      
      // Get the final emission
      const lastEmissions = allEmissions[allEmissions.length - 1]
      expect(lastEmissions.length).toBeGreaterThan(0)
      
      const finalHtml = lastEmissions[lastEmissions.length - 1].html!
      
      console.log('\n=== Final HTML ===')
      console.log(finalHtml)
      
      // The blockquote should be rendered!
      expect(finalHtml).toContain('<blockquote>')
      expect(finalHtml).toContain('Why is this important?')
    })

    it('should handle the exact failing scenario: bullet list followed by blockquote', async () => {
      // This matches the user's exact scenario
      const fullContent = `### Key Notes:
- **Time Complexity**: Average O(n log n)
- **Space Complexity**: O(n) due to temporary lists

> **Why not in-place?** This version is easier to understand.`

      // Simulate streaming this content
      const chunks = fullContent.split(/(?<=\n)/) // Split after each newline
      
      const settler = codeFence()
      const settlerResults: Array<{ content: string; meta: any }> = []
      let pending = ''
      
      for (const chunk of chunks) {
        pending += chunk
        const ctx: SettleContext = {
          pending,
          elapsed: 0,
          settled: '',
          patch: { type: 'streaming_text', content: chunk },
        }
        for (const result of settler(ctx)) {
          settlerResults.push({ content: result.content, meta: result.meta || {} })
          pending = pending.slice(result.content.length)
        }
      }
      
      console.log('\n=== Pending after all chunks ===')
      console.log(`"${pending}"`)
      
      // Simulate settleAll()
      if (pending) {
        settlerResults.push({ content: pending, meta: {} })
        pending = ''
      }
      
      console.log('\n=== All Settler Results ===')
      settlerResults.forEach((r, i) => {
        console.log(`${i}: "${r.content.slice(0, 50).replace(/\n/g, '\\n')}..."`)
      })
      
      // Run through processor
      const contexts = buildProcessorContexts(settlerResults)
      const allEmissions = await runProcessorStream(shikiProcessor, contexts)
      
      // Get final HTML
      const lastEmissions = allEmissions[allEmissions.length - 1]
      const finalHtml = lastEmissions[lastEmissions.length - 1]?.html || ''
      
      console.log('\n=== Final HTML ===')
      console.log(finalHtml)
      
      // Should contain the blockquote
      expect(finalHtml).toContain('<blockquote>')
      expect(finalHtml).toContain('Why not in-place?')
    })
  })

  describe('shikiProcessor quick pass', () => {
    it('should emit quick-highlighted HTML for code lines', async () => {
      const settlerResults = settleCode([
        '```python\n',
        'if x > 0:\n',
        '    return True\n',
        '```\n',
      ])
      
      const contexts = buildProcessorContexts(settlerResults)
      const allEmissions = await runProcessorStream(shikiProcessor, contexts)
      
      console.log('\n=== Shiki Processor All Emissions ===')
      allEmissions.forEach((emissions, i) => {
        console.log(`Context ${i} (${contexts[i].chunk.replace(/\n/g, '\\n')}):`)
        emissions.forEach((e, j) => {
          console.log(`  ${j}: pass=${e.pass}`)
          console.log(`     html: ${e.html?.slice(0, 80)}...`)
        })
      })
      
      // Code lines (contexts 1 and 2) should have quick pass emissions
      const ifLineEmissions = allEmissions[1]
      expect(ifLineEmissions.length).toBeGreaterThan(0)
      
      const quickEmission = ifLineEmissions.find(e => e.pass === 'quick')
      expect(quickEmission).toBeDefined()
      expect(quickEmission!.html).toContain('ql-keyword')
      expect(quickEmission!.html).toContain('if')
    })
  })
})
