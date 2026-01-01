/**
 * End-to-end test for mermaid rendering in the pipeline.
 * 
 * This test verifies that mermaid diagrams are properly detected and processed
 * when streaming completes. Note that actual SVG rendering requires a real
 * browser environment - these tests verify the pipeline logic works correctly.
 */
import { describe, it, expect } from 'vitest'
import { run } from 'effection'
import { runPipeline, createPipeline } from '../pipeline'

describe('mermaid end-to-end', () => {
  describe('pipeline detection', () => {
    it('should detect mermaid code blocks and mark them complete', async () => {
      const content = `Here's a diagram:

\`\`\`mermaid
graph LR
A-->B
\`\`\`

Done.`

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      // Find the mermaid block
      const mermaidBlock = frame.blocks.find(
        b => b.type === 'code' && b.language === 'mermaid'
      )

      expect(mermaidBlock).toBeDefined()
      expect(mermaidBlock?.status).toBe('complete')
      expect(mermaidBlock?.raw).toContain('graph LR')
      expect(mermaidBlock?.raw).toContain('A-->B')
      
      // In test environment (no DOM), mermaid rendering fails
      // but the block should still be processed
      expect(mermaidBlock?.renderPass).toBe('full')
      
      // Error should be stored in meta (mermaid needs DOM)
      expect(mermaidBlock?.meta?.mermaidError).toBeDefined()
    })

    it('should detect sequenceDiagram syntax', async () => {
      const content = `\`\`\`mermaid
sequenceDiagram
Alice->>Bob: Hello
Bob->>Alice: Hi
\`\`\``

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      const mermaidBlock = frame.blocks.find(
        b => b.type === 'code' && b.language === 'mermaid'
      )

      expect(mermaidBlock).toBeDefined()
      expect(mermaidBlock?.type).toBe('code')
      expect(mermaidBlock?.language).toBe('mermaid')
      expect(mermaidBlock?.status).toBe('complete')
      expect(mermaidBlock?.raw).toContain('sequenceDiagram')
      expect(mermaidBlock?.raw).toContain('Alice->>Bob')
    })

    it('should not treat other code blocks as mermaid', async () => {
      const content = `\`\`\`javascript
const x = 1
\`\`\`

\`\`\`mermaid
graph TD
A-->B
\`\`\``

      const frame = await run(function* () {
        return yield* runPipeline(content, { processors: 'full' })
      })

      const codeBlocks = frame.blocks.filter(b => b.type === 'code')
      expect(codeBlocks).toHaveLength(2)

      const jsBlock = codeBlocks.find(b => b.language === 'javascript')
      const mermaidBlock = codeBlocks.find(b => b.language === 'mermaid')

      expect(jsBlock).toBeDefined()
      expect(mermaidBlock).toBeDefined()

      // JS block should NOT have mermaid error
      expect(jsBlock?.meta?.mermaidError).toBeUndefined()
      
      // Mermaid block should have error (no DOM in test)
      expect(mermaidBlock?.meta?.mermaidError).toBeDefined()
    })
  })

  describe('streaming behavior', () => {
    it('should apply quick highlighting while streaming', async () => {
      const frames: any[] = []
      const pipeline = createPipeline(
        { processors: 'full' },
        function* (frame) {
          frames.push(JSON.parse(JSON.stringify(frame)))
        }
      )

      await run(function* () {
        yield* pipeline.process('```mermaid\n')
        yield* pipeline.process('graph LR\n')
        yield* pipeline.process('A-->B\n')
        yield* pipeline.process('```\n')
        yield* pipeline.flush()
      })

      // Should have emitted frames during streaming
      expect(frames.length).toBeGreaterThan(0)

      // Find streaming frames (before fence close)
      const streamingFrames = frames.filter(f => 
        f.blocks.some((b: any) => 
          b.type === 'code' && 
          b.language === 'mermaid' && 
          b.status === 'streaming'
        )
      )

      expect(streamingFrames.length).toBeGreaterThan(0)

      // At least one streaming frame should have mermaid's quick-highlighted HTML
      // (Note: frames are emitted after each processor, so some frames will have
      // markdown's basic output and others will have mermaid's enhanced output)
      const mermaidHighlightedFrames = streamingFrames.filter(frame => {
        const mermaidBlock = frame.blocks.find(
          (b: any) => b.type === 'code' && b.language === 'mermaid'
        )
        return mermaidBlock?.rendered?.includes('quick-highlight')
      })

      expect(mermaidHighlightedFrames.length).toBeGreaterThan(0)

      // Check that mermaid-highlighted frames have proper syntax highlighting
      for (const frame of mermaidHighlightedFrames) {
        const mermaidBlock = frame.blocks.find(
          (b: any) => b.type === 'code' && b.language === 'mermaid'
        )
        expect(mermaidBlock?.renderPass).toBe('quick')
        expect(mermaidBlock?.rendered).toContain('mermaid-code')
      }

      // Final frame should have complete block
      const lastFrame = frames[frames.length - 1]
      const finalMermaidBlock = lastFrame?.blocks.find(
        (b: any) => b.type === 'code' && b.language === 'mermaid'
      )

      expect(finalMermaidBlock?.status).toBe('complete')
      expect(finalMermaidBlock?.renderPass).toBe('full')
    })

    it('should transition from streaming to complete on fence close', async () => {
      const statusHistory: string[] = []
      const pipeline = createPipeline(
        { processors: 'full' },
        function* (frame) {
          const mermaidBlock = frame.blocks.find(
            (b: any) => b.type === 'code' && b.language === 'mermaid'
          )
          if (mermaidBlock) {
            statusHistory.push(mermaidBlock.status)
          }
        }
      )

      await run(function* () {
        yield* pipeline.process('```mermaid\n')
        yield* pipeline.process('graph LR\n')
        yield* pipeline.process('A-->B\n')
        yield* pipeline.process('```\n')
        yield* pipeline.flush()
      })

      // Should have streaming statuses followed by complete
      expect(statusHistory.filter(s => s === 'streaming').length).toBeGreaterThan(0)
      expect(statusHistory[statusHistory.length - 1]).toBe('complete')
    })
  })

  describe('quick highlighting', () => {
    it('should highlight mermaid keywords', async () => {
      const frames: any[] = []
      const pipeline = createPipeline(
        { processors: 'full' },
        function* (frame) {
          frames.push(JSON.parse(JSON.stringify(frame)))
        }
      )

      await run(function* () {
        yield* pipeline.process('```mermaid\n')
        yield* pipeline.process('graph TD\n')
        yield* pipeline.process('subgraph test\n')
        yield* pipeline.process('A-->B\n')
        yield* pipeline.process('end\n')
        yield* pipeline.process('```\n')
        yield* pipeline.flush()
      })

      // Find a streaming frame with content
      const streamingFrame = frames.find(f => {
        const block = f.blocks.find((b: any) => 
          b.type === 'code' && 
          b.language === 'mermaid' &&
          b.status === 'streaming' &&
          b.raw.includes('subgraph')
        )
        return block !== undefined
      })

      // Find a frame with mermaid's quick highlighting that has actual content
      const highlightedFrame = frames.find(f => {
        const block = f.blocks.find((b: any) => 
          b.type === 'code' && 
          b.language === 'mermaid' &&
          b.rendered?.includes('quick-highlight') &&
          b.raw?.includes('graph') // Has actual content
        )
        return block !== undefined
      })

      expect(highlightedFrame).toBeDefined()

      if (highlightedFrame) {
        const mermaidBlock = highlightedFrame.blocks.find(
          (b: any) => b.type === 'code' && b.language === 'mermaid'
        )
        
        // Quick highlight should have keyword spans for graph/subgraph
        expect(mermaidBlock?.rendered).toContain('ql-keyword')
      }
    })
  })
})
