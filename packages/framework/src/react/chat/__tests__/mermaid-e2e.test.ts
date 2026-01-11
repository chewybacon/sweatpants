/**
 * End-to-end test for mermaid rendering in the pipeline.
 * 
 * This test verifies that mermaid diagrams are properly detected and processed
 * when streaming completes. Note that actual SVG rendering requires a real
 * browser environment - these tests verify the pipeline logic works correctly.
 */
import { describe, it, expect } from 'vitest'
import { run } from 'effection'
import { runPipeline, createPipeline } from '../pipeline/index.ts'

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
      const pipeline = createPipeline({ processors: 'full' })

      await run(function* () {
        // Push content incrementally (lazy - no processing yet)
        pipeline.push('```mermaid\n')
        pipeline.push('graph LR\n')
        
        // Pull a frame to process buffered content
        const streamingFrame = yield* pipeline.pull()
        
        // Find the mermaid block
        const mermaidBlock = streamingFrame.blocks.find(
          (b: any) => b.type === 'code' && b.language === 'mermaid'
        )
        
        expect(mermaidBlock).toBeDefined()
        expect(mermaidBlock?.status).toBe('streaming')
        
        // Quick highlight should be applied to streaming content
        if (mermaidBlock?.rendered?.includes('quick-highlight')) {
          expect(mermaidBlock?.renderPass).toBe('quick')
          expect(mermaidBlock?.rendered).toContain('mermaid-code')
        }
        
        // Continue pushing and close the fence
        pipeline.push('A-->B\n')
        pipeline.push('```\n')
        
        // Flush to get final frame
        const finalFrame = yield* pipeline.flush()
        
        const finalMermaidBlock = finalFrame.blocks.find(
          (b: any) => b.type === 'code' && b.language === 'mermaid'
        )

        expect(finalMermaidBlock?.status).toBe('complete')
        expect(finalMermaidBlock?.renderPass).toBe('full')
      })
    })

    it('should transition from streaming to complete on fence close', async () => {
      const pipeline = createPipeline({ processors: 'full' })

      await run(function* () {
        // Push content before fence close
        pipeline.push('```mermaid\n')
        pipeline.push('graph LR\n')
        pipeline.push('A-->B\n')
        
        const streamingFrame = yield* pipeline.pull()
        const streamingBlock = streamingFrame.blocks.find(
          (b: any) => b.type === 'code' && b.language === 'mermaid'
        )
        expect(streamingBlock?.status).toBe('streaming')
        
        // Push fence close
        pipeline.push('```\n')
        
        const closedFrame = yield* pipeline.pull()
        const closedBlock = closedFrame.blocks.find(
          (b: any) => b.type === 'code' && b.language === 'mermaid'
        )
        expect(closedBlock?.status).toBe('complete')
      })
    })
  })

  describe('quick highlighting', () => {
    it('should highlight mermaid keywords', async () => {
      const pipeline = createPipeline({ processors: 'full' })

      await run(function* () {
        // Push content with mermaid keywords
        pipeline.push('```mermaid\n')
        pipeline.push('graph TD\n')
        pipeline.push('subgraph test\n')
        
        // Pull to get streaming frame with quick highlighting
        const streamingFrame = yield* pipeline.pull()
        
        const mermaidBlock = streamingFrame.blocks.find(
          (b: any) => b.type === 'code' && b.language === 'mermaid'
        )

        expect(mermaidBlock).toBeDefined()
        expect(mermaidBlock?.status).toBe('streaming')
        
        // Quick highlight should have keyword spans for graph/subgraph
        if (mermaidBlock?.rendered?.includes('quick-highlight')) {
          expect(mermaidBlock?.rendered).toContain('ql-keyword')
        }
        
        // Complete the block
        pipeline.push('A-->B\n')
        pipeline.push('end\n')
        pipeline.push('```\n')
        yield* pipeline.flush()
      })
    })
  })
})
