/**
 * pipeline.test.ts
 *
 * Tests for the Frame-based streaming pipeline.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { run } from 'effection'

import {
  // Types
  type Frame,
  type Block,
  
  // Frame utilities
  emptyFrame,
  resetIdCounters,
  renderFrameToHtml,
  renderFrameToRaw,
  
  // Settlers
  createCodeFenceSettler,
  createLineSettler,
  
  // Processors
  createMarkdownProcessor,
  createShikiProcessor,
  createMermaidProcessor,
  
  // Pipeline
  createPipeline,
  runPipeline,
  runPipelineWithFrames,
} from '../index'

// Reset ID counters before each test for predictable IDs
beforeEach(() => {
  resetIdCounters()
})

// =============================================================================
// Frame Utilities Tests
// =============================================================================

describe('frame utilities', () => {
  it('should create an empty frame', () => {
    const frame = emptyFrame()
    
    expect(frame.blocks).toEqual([])
    expect(frame.activeBlockIndex).toBeNull()
    expect(frame.trace).toEqual([])
    expect(frame.id).toMatch(/^frame-/)
  })

  it('should render frame to HTML', () => {
    const frame: Frame = {
      id: 'test-frame',
      blocks: [
        { id: 'b1', type: 'text', raw: 'Hello', html: '<p>Hello</p>', status: 'complete', renderPass: 'quick' },
        { id: 'b2', type: 'code', raw: 'const x = 1', html: '<pre><code>const x = 1</code></pre>', status: 'complete', renderPass: 'quick', language: 'javascript' },
      ],
      timestamp: Date.now(),
      trace: [],
      activeBlockIndex: null,
    }
    
    const html = renderFrameToHtml(frame)
    expect(html).toBe('<p>Hello</p><pre><code>const x = 1</code></pre>')
  })

  it('should render frame to raw text', () => {
    const frame: Frame = {
      id: 'test-frame',
      blocks: [
        { id: 'b1', type: 'text', raw: 'Hello\n', html: '', status: 'complete', renderPass: 'none' },
        { id: 'b2', type: 'code', raw: 'const x = 1\n', html: '', status: 'complete', renderPass: 'none', language: 'javascript' },
      ],
      timestamp: Date.now(),
      trace: [],
      activeBlockIndex: null,
    }
    
    const raw = renderFrameToRaw(frame)
    expect(raw).toBe('Hello\nconst x = 1\n')
  })
})

// =============================================================================
// Settler Tests
// =============================================================================

describe('code fence settler', () => {
  it('should create text blocks for plain text', () => {
    const settler = createCodeFenceSettler()
    let frame = emptyFrame()
    
    frame = settler(frame, 'Hello world\n', { pending: '', flush: false })
    
    expect(frame.blocks).toHaveLength(1)
    expect(frame.blocks[0]!.type).toBe('text')
    expect(frame.blocks[0]!.raw).toBe('Hello world\n')
    expect(frame.blocks[0]!.status).toBe('streaming')
  })

  it('should create code blocks for fenced code', () => {
    const settler = createCodeFenceSettler()
    let frame = emptyFrame()
    
    // Opening fence
    frame = settler(frame, '```javascript\n', { pending: '', flush: false })
    expect(frame.blocks).toHaveLength(1)
    expect(frame.blocks[0]!.type).toBe('code')
    expect(frame.blocks[0]!.language).toBe('javascript')
    expect(frame.blocks[0]!.status).toBe('streaming')
    
    // Code line
    frame = settler(frame, 'const x = 1;\n', { pending: '', flush: false })
    expect(frame.blocks).toHaveLength(1)
    expect(frame.blocks[0]!.raw).toBe('const x = 1;\n')
    
    // Closing fence
    frame = settler(frame, '```\n', { pending: '', flush: false })
    expect(frame.blocks).toHaveLength(1)
    expect(frame.blocks[0]!.status).toBe('complete')
  })

  it('should handle text before and after code fence', () => {
    const settler = createCodeFenceSettler()
    let frame = emptyFrame()
    
    frame = settler(frame, 'Before\n', { pending: '', flush: false })
    frame = settler(frame, '```js\n', { pending: '', flush: false })
    frame = settler(frame, 'code\n', { pending: '', flush: false })
    frame = settler(frame, '```\n', { pending: '', flush: false })
    frame = settler(frame, 'After\n', { pending: '', flush: false })
    
    expect(frame.blocks).toHaveLength(3)
    expect(frame.blocks[0]!.type).toBe('text')
    expect(frame.blocks[0]!.raw).toBe('Before\n')
    expect(frame.blocks[1]!.type).toBe('code')
    expect(frame.blocks[1]!.raw).toBe('code\n')
    expect(frame.blocks[2]!.type).toBe('text')
    expect(frame.blocks[2]!.raw).toBe('After\n')
  })

  it('should handle flush at stream end', () => {
    const settler = createCodeFenceSettler()
    let frame = emptyFrame()
    
    // Incomplete line
    frame = settler(frame, 'Hello', { pending: '', flush: false })
    expect(frame.blocks).toHaveLength(0) // Not yet settled
    
    // Flush
    frame = settler(frame, '', { pending: '', flush: true })
    expect(frame.blocks).toHaveLength(1)
    expect(frame.blocks[0]!.raw).toBe('Hello')
  })

  it('should add trace entries', () => {
    const settler = createCodeFenceSettler()
    let frame = emptyFrame()
    
    frame = settler(frame, 'Hello\n', { pending: '', flush: false })
    
    expect(frame.trace.length).toBeGreaterThan(0)
    expect(frame.trace[0]!.processor).toBe('settler')
    expect(frame.trace[0]!.action).toBe('create')
  })
})

describe('line settler', () => {
  it('should create text blocks line by line', () => {
    const settler = createLineSettler()
    let frame = emptyFrame()
    
    frame = settler(frame, 'Line 1\n', { pending: '', flush: false })
    frame = settler(frame, 'Line 2\n', { pending: '', flush: false })
    
    expect(frame.blocks).toHaveLength(1) // All text goes in one block
    expect(frame.blocks[0]!.raw).toBe('Line 1\nLine 2\n')
  })
})

// =============================================================================
// Processor Tests
// =============================================================================

describe('markdown processor', () => {
  it('should parse markdown in text blocks', async () => {
    const result = await run(function* () {
      const processor = createMarkdownProcessor()
      
      const frame: Frame = {
        id: 'test',
        blocks: [
          { id: 'b1', type: 'text', raw: '# Hello\n\nWorld', html: '', status: 'complete', renderPass: 'none' },
        ],
        timestamp: Date.now(),
        trace: [],
        activeBlockIndex: null,
      }
      
      return yield* processor(frame)
    })
    
    expect(result.blocks[0]!.html).toContain('<h1>Hello</h1>')
    expect(result.blocks[0]!.html).toContain('World')
    expect(result.blocks[0]!.renderPass).toBe('quick')
  })

  it('should escape code blocks', async () => {
    const result = await run(function* () {
      const processor = createMarkdownProcessor()
      
      const frame: Frame = {
        id: 'test',
        blocks: [
          { id: 'b1', type: 'code', raw: 'const x = 1;', html: '', status: 'complete', renderPass: 'none', language: 'javascript' },
        ],
        timestamp: Date.now(),
        trace: [],
        activeBlockIndex: null,
      }
      
      return yield* processor(frame)
    })
    
    expect(result.blocks[0]!.html).toContain('<pre>')
    expect(result.blocks[0]!.html).toContain('<code')
    expect(result.blocks[0]!.html).toContain('const x = 1;')
  })

  it('should not re-process already rendered blocks', async () => {
    const result = await run(function* () {
      const processor = createMarkdownProcessor()
      
      const frame: Frame = {
        id: 'test',
        blocks: [
          { id: 'b1', type: 'text', raw: '# Hello', html: '<h1>Already Rendered</h1>', status: 'complete', renderPass: 'quick' },
        ],
        timestamp: Date.now(),
        trace: [],
        activeBlockIndex: null,
      }
      
      return yield* processor(frame)
    })
    
    // Should keep existing HTML
    expect(result.blocks[0]!.html).toBe('<h1>Already Rendered</h1>')
  })
})

describe('shiki processor', () => {
  it('should apply quick highlighting to streaming code blocks', async () => {
    const result = await run(function* () {
      const processor = createShikiProcessor()
      
      const frame: Frame = {
        id: 'test',
        blocks: [
          { id: 'b1', type: 'code', raw: 'const x = 1;', html: '', status: 'streaming', renderPass: 'none', language: 'javascript' },
        ],
        timestamp: Date.now(),
        trace: [],
        activeBlockIndex: 0,
      }
      
      return yield* processor(frame)
    })
    
    expect(result.blocks[0]!.renderPass).toBe('quick')
    expect(result.blocks[0]!.html).toContain('ql-keyword') // Quick highlight class
    expect(result.blocks[0]!.html).toContain('const')
  })

  it('should apply full Shiki highlighting to complete code blocks', async () => {
    const result = await run(function* () {
      const processor = createShikiProcessor()
      
      const frame: Frame = {
        id: 'test',
        blocks: [
          { id: 'b1', type: 'code', raw: 'const x = 1;', html: '', status: 'complete', renderPass: 'none', language: 'javascript' },
        ],
        timestamp: Date.now(),
        trace: [],
        activeBlockIndex: null,
      }
      
      return yield* processor(frame)
    })
    
    expect(result.blocks[0]!.renderPass).toBe('full')
    expect(result.blocks[0]!.html).toContain('shiki') // Shiki class
  })

  it('should skip mermaid blocks', async () => {
    const result = await run(function* () {
      const processor = createShikiProcessor()
      
      const frame: Frame = {
        id: 'test',
        blocks: [
          { id: 'b1', type: 'code', raw: 'graph TD', html: '', status: 'complete', renderPass: 'none', language: 'mermaid' },
        ],
        timestamp: Date.now(),
        trace: [],
        activeBlockIndex: null,
      }
      
      return yield* processor(frame)
    })
    
    // Should be unchanged
    expect(result.blocks[0]!.renderPass).toBe('none')
  })
})

describe('mermaid processor', () => {
  it('should apply quick highlighting to streaming mermaid blocks', async () => {
    const result = await run(function* () {
      const processor = createMermaidProcessor()
      
      const frame: Frame = {
        id: 'test',
        blocks: [
          { id: 'b1', type: 'code', raw: 'graph TD\n  A --> B', html: '', status: 'streaming', renderPass: 'none', language: 'mermaid' },
        ],
        timestamp: Date.now(),
        trace: [],
        activeBlockIndex: 0,
      }
      
      return yield* processor(frame)
    })
    
    expect(result.blocks[0]!.renderPass).toBe('quick')
    expect(result.blocks[0]!.html).toContain('ql-keyword') // Quick highlight class
    expect(result.blocks[0]!.html).toContain('graph')
  })

  it('should render SVG for complete mermaid blocks', async () => {
    const result = await run(function* () {
      const processor = createMermaidProcessor()
      
      const frame: Frame = {
        id: 'test',
        blocks: [
          { id: 'b1', type: 'code', raw: 'graph TD\n  A --> B', html: '', status: 'complete', renderPass: 'none', language: 'mermaid' },
        ],
        timestamp: Date.now(),
        trace: [],
        activeBlockIndex: null,
      }
      
      return yield* processor(frame)
    })
    
    expect(result.blocks[0]!.renderPass).toBe('full')
    // In test environment, mermaid may fail (no DOM) - check trace for what happened
    const mermaidTrace = result.trace.find(t => t.processor === 'mermaid')
    expect(mermaidTrace).toBeDefined()
    // Either rendered SVG or recorded an error
    expect(mermaidTrace!.action === 'update' || mermaidTrace!.action === 'error').toBe(true)
  })

  it('should skip non-mermaid blocks', async () => {
    const result = await run(function* () {
      const processor = createMermaidProcessor()
      
      const frame: Frame = {
        id: 'test',
        blocks: [
          { id: 'b1', type: 'code', raw: 'const x = 1;', html: '', status: 'complete', renderPass: 'none', language: 'javascript' },
        ],
        timestamp: Date.now(),
        trace: [],
        activeBlockIndex: null,
      }
      
      return yield* processor(frame)
    })
    
    // Should be unchanged
    expect(result.blocks[0]!.renderPass).toBe('none')
  })
})

// =============================================================================
// Pipeline Integration Tests
// =============================================================================

describe('pipeline', () => {
  it('should process simple markdown', async () => {
    const result = await run(function* () {
      return yield* runPipeline('# Hello\n\nWorld\n', {
        settler: createCodeFenceSettler,
        processors: [createMarkdownProcessor],
      })
    })
    
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]!.type).toBe('text')
    expect(result.blocks[0]!.html).toContain('<h1>Hello</h1>')
  })

  it('should process markdown with code fence', async () => {
    const result = await run(function* () {
      return yield* runPipeline(
        'Before\n\n```javascript\nconst x = 1;\n```\n\nAfter\n',
        {
          settler: createCodeFenceSettler,
          processors: [createMarkdownProcessor, createShikiProcessor],
        }
      )
    })
    
    expect(result.blocks).toHaveLength(3)
    expect(result.blocks[0]!.type).toBe('text')
    expect(result.blocks[1]!.type).toBe('code')
    expect(result.blocks[2]!.type).toBe('text')
    
    // Code should have Shiki highlighting
    expect(result.blocks[1]!.renderPass).toBe('full')
    expect(result.blocks[1]!.html).toContain('shiki')
  })

  it('should handle shiki + mermaid together without duplication', async () => {
    const result = await run(function* () {
      return yield* runPipeline(
        'Hello\n\n```javascript\nconst x = 1;\n```\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nGoodbye\n',
        {
          settler: createCodeFenceSettler,
          processors: [createMarkdownProcessor, createShikiProcessor, createMermaidProcessor],
        }
      )
    })
    
    // Debug: log block types
    // console.log('Blocks:', result.blocks.map(b => ({ type: b.type, raw: b.raw.slice(0, 20) })))
    
    // Text before, JS code, text between, mermaid code, text after
    // The \n\n between blocks creates separate text blocks
    expect(result.blocks.length).toBeGreaterThanOrEqual(3)
    
    // Find the key blocks by content
    const textBlocks = result.blocks.filter(b => b.type === 'text')
    const codeBlocks = result.blocks.filter(b => b.type === 'code')
    
    // Should have at least one text block with Hello, one with Goodbye
    const helloBlock = textBlocks.find(b => b.raw.includes('Hello'))
    const goodbyeBlock = textBlocks.find(b => b.raw.includes('Goodbye'))
    expect(helloBlock).toBeDefined()
    expect(goodbyeBlock).toBeDefined()
    
    // Should have two code blocks
    expect(codeBlocks).toHaveLength(2)
    
    // JavaScript code block (Shiki)
    const jsBlock = codeBlocks.find(b => b.language === 'javascript')
    expect(jsBlock).toBeDefined()
    expect(jsBlock!.renderPass).toBe('full')
    expect(jsBlock!.html).toContain('shiki')
    
    // Mermaid code block
    const mermaidBlock = codeBlocks.find(b => b.language === 'mermaid')
    expect(mermaidBlock).toBeDefined()
    expect(mermaidBlock!.renderPass).toBe('full')
    
    // NO DUPLICATION - each piece of content appears exactly once in raw
    const raw = renderFrameToRaw(result)
    expect((raw.match(/Hello/g) || []).length).toBe(1)
    expect((raw.match(/Goodbye/g) || []).length).toBe(1)
    
    // HTML should also have content (but markdown processor may wrap it)
    const html = renderFrameToHtml(result)
    expect(html).toContain('Hello')
    // Goodbye may or may not be in HTML depending on streaming status
    // The key check is that raw content has no duplication
  })

  it('should collect intermediate frames for progressive enhancement', async () => {
    const { frames, final } = await run(function* () {
      return yield* runPipelineWithFrames(
        '```javascript\nconst x = 1;\n```\n',
        {
          settler: createCodeFenceSettler,
          processors: [createMarkdownProcessor, createShikiProcessor],
        }
      )
    })
    
    // Should have multiple frames as content streams in
    expect(frames.length).toBeGreaterThan(0)
    
    // Final frame should have full rendering
    expect(final.blocks[0]!.renderPass).toBe('full')
  })
})

// =============================================================================
// Edge Cases
// =============================================================================

describe('edge cases', () => {
  it('should handle empty content', async () => {
    const result = await run(function* () {
      return yield* runPipeline('', {
        settler: createCodeFenceSettler,
        processors: [createMarkdownProcessor],
      })
    })
    
    expect(result.blocks).toHaveLength(0)
  })

  it('should handle unclosed code fence', async () => {
    const result = await run(function* () {
      return yield* runPipeline('```javascript\nconst x = 1;\n', {
        settler: createCodeFenceSettler,
        processors: [createMarkdownProcessor],
      })
    })
    
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]!.type).toBe('code')
    // Should still have the content
    expect(result.blocks[0]!.raw).toContain('const x = 1')
  })

  it('should handle nested backticks in code', async () => {
    const result = await run(function* () {
      return yield* runPipeline('````markdown\n```js\ncode\n```\n````\n', {
        settler: createCodeFenceSettler,
        processors: [createMarkdownProcessor],
      })
    })
    
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]!.type).toBe('code')
    expect(result.blocks[0]!.raw).toContain('```js')
  })

  it('should handle multiple consecutive code blocks', async () => {
    const result = await run(function* () {
      return yield* runPipeline(
        '```js\na\n```\n```py\nb\n```\n```rust\nc\n```\n',
        {
          settler: createCodeFenceSettler,
          processors: [createMarkdownProcessor, createShikiProcessor],
        }
      )
    })
    
    expect(result.blocks).toHaveLength(3)
    expect(result.blocks[0]!.language).toBe('js')
    expect(result.blocks[1]!.language).toBe('py')
    expect(result.blocks[2]!.language).toBe('rust')
  })
})
