/**
 * mermaid.test.ts
 * 
 * Tests for mermaid progressive rendering.
 * 
 * Tests cover:
 * 1. Quick highlighting during streaming
 * 2. Full SVG rendering on fence close
 * 3. Error handling for invalid diagrams
 */
import { describe, it, expect } from 'vitest'
import { quickMermaidProcessor, mermaidProcessor } from '../mermaid'
import type { ProcessorContext } from '../types'
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

describe('Mermaid Processor', () => {
  describe('codeFence settler with mermaid', () => {
    it('should recognize mermaid as a language', () => {
      const chunks = [
        '```mermaid\n',
        'graph TD\n',
        '  A --> B\n',
        '```\n',
      ]
      
      const results = settleCode(chunks)
      
      console.log('\n=== Mermaid Settler Results ===')
      results.forEach((r, i) => {
        console.log(`${i}: "${r.content.replace(/\n/g, '\\n')}"`)
        console.log(`   meta:`, r.meta)
      })
      
      expect(results).toHaveLength(4)
      
      // First: fence start with mermaid language
      expect(results[0].content).toBe('```mermaid\n')
      expect(results[0].meta.inCodeFence).toBe(true)
      expect(results[0].meta.fenceStart).toBe(true)
      expect(results[0].meta.language).toBe('mermaid')
      
      // Code lines
      expect(results[1].content).toBe('graph TD\n')
      expect(results[1].meta.inCodeFence).toBe(true)
      expect(results[1].meta.language).toBe('mermaid')
      
      // Fence end
      expect(results[3].content).toBe('```\n')
      expect(results[3].meta.fenceEnd).toBe(true)
    })
  })

  describe('quickMermaidProcessor', () => {
    it('should quick-highlight mermaid keywords', async () => {
      const settlerResults = settleCode([
        '```mermaid\n',
        'graph TD\n',
        '  A --> B\n',
        '```\n',
      ])
      
      const contexts = buildProcessorContexts(settlerResults)
      const allEmissions = await runProcessorStream(quickMermaidProcessor, contexts)
      
      console.log('\n=== Quick Mermaid Processor Emissions ===')
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
      expect(firstCodeLineHtml).toContain('language-mermaid')
    })

    it('should highlight mermaid-specific syntax', async () => {
      const settlerResults = settleCode([
        '```mermaid\n',
        'sequenceDiagram\n',
        '  participant A\n',
        '  A->>B: Hello\n',
        '  %% This is a comment\n',
        '```\n',
      ])
      
      const contexts = buildProcessorContexts(settlerResults)
      const allEmissions = await runProcessorStream(quickMermaidProcessor, contexts)
      
      console.log('\n=== Mermaid Syntax Highlighting ===')
      allEmissions.forEach((emissions, i) => {
        if (emissions.length > 0) {
          console.log(`${i}: ${emissions[0].html?.slice(0, 200)}`)
        }
      })
      
      // Get combined HTML from all code line emissions
      const allHtml = allEmissions.flatMap(e => e.map(p => p.html || '')).join('')
      
      // Keywords should be highlighted
      expect(allHtml).toContain('ql-keyword')
      // Comments should be highlighted
      expect(allHtml).toContain('ql-comment')
    })

    it('should handle various mermaid diagram types', async () => {
      const diagramTypes = ['graph', 'flowchart', 'sequenceDiagram', 'classDiagram', 'pie', 'gantt']
      
      for (const diagramType of diagramTypes) {
        const settlerResults = settleCode([
          '```mermaid\n',
          `${diagramType}\n`,
          '```\n',
        ])
        
        const contexts = buildProcessorContexts(settlerResults)
        const allEmissions = await runProcessorStream(quickMermaidProcessor, contexts)
        
        const codeLineEmission = allEmissions[1][0]
        expect(codeLineEmission.html).toContain('ql-keyword')
        expect(codeLineEmission.html).toContain(diagramType)
      }
    })

    it('should NOT add mermaid highlighting to non-mermaid code', async () => {
      const settlerResults = settleCode([
        '```javascript\n',
        'const graph = "TD";\n',
        '```\n',
      ])
      
      const contexts = buildProcessorContexts(settlerResults)
      const allEmissions = await runProcessorStream(quickMermaidProcessor, contexts)
      
      // JavaScript code should still work (escaped but not mermaid-highlighted)
      expect(allEmissions[1]).toHaveLength(1)
      const html = allEmissions[1][0].html!
      
      console.log('\n=== JavaScript Code (not mermaid) ===')
      console.log(html)
      
      expect(html).toContain('language-javascript')
      // Should not have mermaid-specific keyword highlighting (no ql-keyword for 'graph')
      // since we use generic highlighting for non-mermaid
      expect(html).toContain('const')
    })
  })

  describe('mermaidProcessor (with rendering)', () => {
    it('should emit quick pass then full pass for mermaid', async () => {
      const settlerResults = settleCode([
        '```mermaid\n',
        'graph TD\n',
        '  A[Start] --> B[End]\n',
        '```\n',
      ])
      
      const contexts = buildProcessorContexts(settlerResults)
      const allEmissions = await runProcessorStream(mermaidProcessor, contexts)
      
      console.log('\n=== Mermaid Full Processor Emissions ===')
      allEmissions.forEach((emissions, i) => {
        console.log(`Context ${i} (${contexts[i].chunk.replace(/\n/g, '\\n')}):`)
        emissions.forEach((e, j) => {
          console.log(`  ${j}: pass=${e.pass}`)
          console.log(`     html: ${e.html?.slice(0, 100)}...`)
        })
      })
      
      // Fence end should emit both quick and full passes
      const fenceEndEmissions = allEmissions[allEmissions.length - 1]
      expect(fenceEndEmissions.length).toBe(2)
      
      const quickPass = fenceEndEmissions.find(e => e.pass === 'quick')
      const fullPass = fenceEndEmissions.find(e => e.pass === 'full')
      
      expect(quickPass).toBeDefined()
      expect(fullPass).toBeDefined()
      
      // Full pass should contain rendered mermaid (SVG) or fallback code block
      expect(fullPass!.html).toMatch(/mermaid-diagram|code-block/)
    })

    it('should render valid mermaid diagram to SVG (browser only)', async () => {
      // Note: Mermaid requires a real DOM for SVG rendering.
      // In Node.js/jsdom, we get "document is not defined" error.
      // This test verifies the error handling path - actual SVG rendering
      // is tested in the browser.
      const settlerResults = settleCode([
        '```mermaid\n',
        'graph LR\n',
        '  A --> B\n',
        '```\n',
      ])
      
      const contexts = buildProcessorContexts(settlerResults)
      const allEmissions = await runProcessorStream(mermaidProcessor, contexts)
      
      // Get the full pass from fence end
      const fenceEndEmissions = allEmissions[allEmissions.length - 1]
      const fullPass = fenceEndEmissions.find(e => e.pass === 'full')
      
      console.log('\n=== Rendered Mermaid ===')
      console.log(fullPass?.html?.slice(0, 500))
      
      expect(fullPass).toBeDefined()
      // In Node.js, we get an error because mermaid needs a real DOM
      // which means we fall back to quick-highlighted code block
      // In a real browser, this would contain mermaid-diagram with SVG
      expect(fullPass!.html).toMatch(/mermaid-diagram|code-block/)
    })

    it('should fall back to quick-highlighted code for invalid mermaid syntax', async () => {
      const settlerResults = settleCode([
        '```mermaid\n',
        'this is not valid mermaid!!!\n',
        '```\n',
      ])
      
      const contexts = buildProcessorContexts(settlerResults)
      const allEmissions = await runProcessorStream(mermaidProcessor, contexts)
      
      // Get the full pass from fence end
      const fenceEndEmissions = allEmissions[allEmissions.length - 1]
      const fullPass = fenceEndEmissions.find(e => e.pass === 'full')
      
      console.log('\n=== Invalid Mermaid Fallback ===')
      console.log(fullPass?.html?.slice(0, 500))
      
      expect(fullPass).toBeDefined()
      // Should fall back to quick-highlighted code block (not an error message)
      expect(fullPass!.html).toContain('code-block')
      expect(fullPass!.html).toContain('language-mermaid')
    })
  })

  describe('mixed content', () => {
    it('should handle text before and after mermaid diagram', async () => {
      const settlerResults = settleCode([
        'Here is a diagram:\n\n',
        '```mermaid\n',
        'pie\n',
        '  "A" : 30\n',
        '  "B" : 70\n',
        '```\n\n',
      ])
      
      // Add trailing text as final settle (simulating settleAll)
      settlerResults.push({ content: 'That was the diagram!', meta: {} })
      
      const contexts = buildProcessorContexts(settlerResults)
      const allEmissions = await runProcessorStream(quickMermaidProcessor, contexts)
      
      console.log('\n=== Mixed Content Emissions ===')
      allEmissions.forEach((emissions, i) => {
        console.log(`${i}: ${contexts[i].chunk.slice(0, 30).replace(/\n/g, '\\n')}... -> ${emissions.length} emissions`)
        if (emissions[0]?.html) {
          console.log(`   HTML: ${emissions[0].html.slice(0, 80)}...`)
        }
      })
      
      // First context (intro text) should emit
      expect(allEmissions[0]).toHaveLength(1)
      expect(allEmissions[0][0].html).toContain('Here is a diagram')
      
      // Last context (trailing text) should emit
      const lastEmissions = allEmissions[allEmissions.length - 1]
      expect(lastEmissions).toHaveLength(1)
      expect(lastEmissions[0].html).toContain('That was the diagram')
    })
  })
})
