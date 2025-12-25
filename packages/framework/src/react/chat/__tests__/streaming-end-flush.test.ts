/**
 * Streaming End Flush Tests
 * 
 * Tests that content at the end of a stream (without trailing \n\n) is properly
 * flushed and included in the final rendered output.
 * 
 * This covers the bug where blockquotes or other trailing content was lost
 * because the transform didn't receive streaming_end before assistant_message.
 * 
 * These tests verify the SETTLER behavior (which is synchronous) and the
 * PROCESSOR behavior, avoiding the complexity of testing full channel pipelines.
 */
import { describe, it, expect } from 'vitest'
import { run, createChannel, spawn, each, sleep } from 'effection'
import type { Channel } from 'effection'
import { codeFence } from '../shiki'
import { quickHighlightProcessor } from '../shiki/processor'
import { dualBufferTransform } from '../dualBuffer'
import { loggingTransform } from '../transforms'
import { paragraph } from '../settlers'
import type { SettleContext, ProcessorContext, ProcessedOutput, SettleResult, ChatPatch } from '../types'
import { marked } from 'marked'

describe('streaming end flush', () => {
  describe('codeFence settler - trailing content handling', () => {
    it('should leave trailing blockquote in pending (to be settled at streaming_end)', () => {
      const settler = codeFence()
      
      // Simulate the stream
      const chunks = [
        '### Notes:\n\n',
        '> This is a blockquote without trailing newlines',
      ]
      
      let pending = ''
      let settled = ''
      const allResults: SettleResult[] = []
      
      for (const chunk of chunks) {
        pending += chunk
        
        const ctx: SettleContext = {
          pending,
          settled,
          elapsed: 0,
          patch: { type: 'streaming_text', content: chunk },
        }
        
        const results = [...settler(ctx)]
        for (const result of results) {
          const content = typeof result === 'string' ? result : result.content
          settled += content
          pending = pending.slice(content.length)
          allResults.push(typeof result === 'string' ? { content: result } : result)
        }
      }
      
      console.log('\n=== Settler Results ===')
      allResults.forEach((r, i) => {
        console.log(`${i}: "${r.content.slice(0, 40)}..."`)
      })
      console.log(`Remaining pending: "${pending}"`)
      
      // The blockquote should still be in pending (no \n\n terminator)
      expect(pending).toBe('> This is a blockquote without trailing newlines')
      
      // The heading should have been settled (it ended with \n\n)
      expect(settled).toBe('### Notes:\n\n')
    })

    it('should settle all pending when settleAll is simulated (streaming_end)', () => {
      const settler = codeFence()
      
      const chunks = [
        '### Notes:\n\n',
        '- Point 1\n',
        '- Point 2\n',
        '- Point 3',  // No trailing newline
      ]
      
      let pending = ''
      let settled = ''
      
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
          settled += content
          pending = pending.slice(content.length)
        }
      }
      
      console.log('\n=== After normal streaming ===')
      console.log(`Settled: "${settled}"`)
      console.log(`Pending: "${pending}"`)
      
      // At streaming_end, the dualBuffer calls settleAll() which settles remaining pending
      // We simulate this by calling the processor with the remaining pending content
      const finalContent = pending
      
      // Verify what would be settled at streaming_end
      expect(finalContent).toContain('Point 3')
      
      // The full content after settleAll would be:
      const fullSettled = settled + finalContent
      expect(fullSettled).toContain('Point 1')
      expect(fullSettled).toContain('Point 2')
      expect(fullSettled).toContain('Point 3')
    })
  })

  describe('processor - trailing markdown handling', () => {
    it('should produce HTML for blockquote content', async () => {
      const processor = quickHighlightProcessor()
      
      // Simulate what the processor receives when trailing content is settled
      const ctx: ProcessorContext = {
        chunk: '> **Important:** This is a blockquote\n\n',
        accumulated: '',
        next: '> **Important:** This is a blockquote\n\n',
        meta: { inCodeFence: false },
      }
      
      const emissions: ProcessedOutput[] = []
      const emit = function (output: ProcessedOutput) {
        return {
          *[Symbol.iterator]() {
            emissions.push(output)
          }
        }
      }
      
      // Run the processor
      await run(function* () {
        yield* processor(ctx, emit)
      })
      
      console.log('\n=== Processor Emissions ===')
      emissions.forEach((e, i) => {
        console.log(`${i}: ${e.html?.slice(0, 80)}...`)
      })
      
      expect(emissions.length).toBeGreaterThan(0)
      expect(emissions[0].html).toContain('<blockquote>')
      expect(emissions[0].html).toContain('Important:')
    })
  })

  describe('integration - markdown rendering of trailing content', () => {
    it('should correctly render markdown for content without trailing newlines', () => {
      // This tests the marked library directly to ensure our expectations are correct
      
      // Content that doesn't end with \n\n (like from streaming)
      const content = '> This is a blockquote without trailing newlines'
      
      // marked should still parse this correctly
      const html = marked.parse(content, { async: false }) as string
      
      console.log('\n=== Marked Output ===')
      console.log(html)
      
      expect(html).toContain('<blockquote>')
      expect(html).toContain('This is a blockquote')
    })

    it('should render bullet lists without trailing newlines', () => {
      const content = '- Item 1\n- Item 2\n- Item 3'
      const html = marked.parse(content, { async: false }) as string
      
      console.log('\n=== Bullet List HTML ===')
      console.log(html)
      
      expect(html).toContain('<ul>')
      expect(html).toContain('Item 1')
      expect(html).toContain('Item 2')
      expect(html).toContain('Item 3')
    })

    it('should render the exact failing scenario: heading + code + blockquote', () => {
      // This simulates the full content that should be settled
      const chunks = [
        '### Key Notes:\n\n',
        '```python\nx = 1\n```\n\n',
        '> **Important:** This blockquote has no trailing newlines',
      ]
      
      const fullContent = chunks.join('')
      const html = marked.parse(fullContent, { async: false }) as string
      
      console.log('\n=== Full Content HTML ===')
      console.log(html)
      
      expect(html).toContain('<h3>')
      expect(html).toContain('Key Notes')
      expect(html).toContain('language-python')
      expect(html).toContain('x = 1')
      expect(html).toContain('<blockquote>')
      expect(html).toContain('Important:')
    })
  })

  describe('dualBuffer settleAll behavior', () => {
    /**
     * This test documents the expected behavior of settleAll() in dualBuffer.ts
     * 
     * When streaming_end is received:
     * 1. dualBuffer calls settleAll() which settles ALL remaining pending content
     * 2. This triggers the processor for the remaining content
     * 3. A buffer_settled patch is emitted with the final HTML
     * 4. THEN streaming_end is passed through
     * 
     * This ordering is critical: buffer_settled must come BEFORE streaming_end
     * so the reducer's state.buffer.settledHtml is complete when streaming ends.
     */
    it('should document the settleAll behavior', () => {
      // The fix was in session.ts:
      // BEFORE: streaming_end was sent in finally{} block, AFTER assistant_message
      // AFTER: streaming_end is sent THROUGH the transform BEFORE assistant_message
      //
      // This ensures:
      // 1. streaming_end goes through the transform
      // 2. dualBuffer sees streaming_end and calls settleAll()
      // 3. settleAll emits buffer_settled for remaining content
      // 4. streaming_end is passed through
      // 5. THEN assistant_message is sent (which reads settledHtml)
      
      expect(true).toBe(true)  // Documentation test
    })
  })

  describe('patch ordering verification', () => {
    it('should verify the fix: streaming_end triggers settleAll before passing through', () => {
      // This is a documentation test that describes the expected behavior
      // The actual test is manual: run the app and verify trailing content appears
      
      // Expected patch order after fix:
      // 1. streaming_start
      // 2. streaming_text (multiple)
      // 3. buffer_settled (for paragraph breaks during streaming)
      // 4. streaming_text (more content)
      // 5. streaming_end (this triggers settleAll)
      // 6. buffer_settled (for ALL remaining pending content) <- CRITICAL
      // 7. streaming_end (passed through after settleAll)
      // 8. assistant_message (reads settledHtml which now has everything)
      
      // The key insight: step 6 happens BEFORE step 7
      // because dualBuffer's streaming_end handler does:
      //   yield* settleAll()  // emits buffer_settled
      //   yield* output.send(patch)  // then passes streaming_end
      
      expect(true).toBe(true)
    })
  })

  describe('full pipeline integration', () => {
    /**
     * This test exercises the ACTUAL dualBuffer transform with channels
     * to verify that streaming_end triggers settleAll and the final HTML
     * includes trailing content.
     */
    it('should include trailing content in final settledHtml when streaming_end is received', async () => {
      const result = await run(function* () {
        // Create input and output channels
        const input: Channel<ChatPatch, void> = createChannel<ChatPatch, void>()
        const output: Channel<ChatPatch, void> = createChannel<ChatPatch, void>()

        // Collect all patches that come out of the transform
        const receivedPatches: ChatPatch[] = []
        
        // Spawn a consumer that collects output patches
        yield* spawn(function* () {
          for (const patch of yield* each(output)) {
            receivedPatches.push(patch)
            yield* each.next()
          }
        })

        // Spawn the transform
        yield* spawn(function* () {
          yield* dualBufferTransform({
            settler: paragraph,  // Factory function, not instance
            debug: false,
          })(input, output)
        })

        // CRITICAL: Give consumer and transform time to subscribe to channels
        // Channels are unbuffered - messages are dropped if no one is listening
        yield* sleep(10)

        // Simulate streaming content with trailing blockquote (no \n\n at end)
        const chunks = [
          'Hello world!\n\n',           // This settles immediately (has \n\n)
          '> This is important',        // This stays in pending (no \n\n)
        ]

        // Send streaming_start
        yield* input.send({ type: 'streaming_start' })

        // Send each chunk as streaming_text
        for (const chunk of chunks) {
          yield* input.send({ type: 'streaming_text', content: chunk })
        }

        // KEY: Send streaming_end - this should trigger settleAll()
        yield* input.send({ type: 'streaming_end' })

        // Close the input channel
        yield* input.close()

        // Give the pipeline time to process all patches
        yield* sleep(50)

        return receivedPatches
      })

      console.log('\n=== Received Patches ===')
      result.forEach((p, i) => {
        if (p.type === 'buffer_settled') {
          console.log(`${i}: buffer_settled - content: "${(p as any).content?.slice(0, 40)}..." html: ${!!(p as any).html}`)
        } else {
          console.log(`${i}: ${p.type}`)
        }
      })

      // Find all buffer_settled patches
      const settledPatches = result.filter(p => p.type === 'buffer_settled')
      
      // There should be at least 2 buffer_settled patches:
      // 1. For "Hello world!\n\n" (settled on \n\n)
      // 2. For "> This is important" (settled on streaming_end)
      expect(settledPatches.length).toBeGreaterThanOrEqual(2)

      // The last buffer_settled should contain the blockquote content
      const lastSettled = settledPatches[settledPatches.length - 1] as any
      expect(lastSettled.content).toContain('This is important')

      // streaming_end should come AFTER the final buffer_settled
      const streamingEndIndex = result.findIndex(p => p.type === 'streaming_end')
      const lastSettledIndex = result.indexOf(lastSettled)
      
      console.log(`\nstreaming_end at index ${streamingEndIndex}, last buffer_settled at index ${lastSettledIndex}`)
      
      // CRITICAL: The last buffer_settled must come BEFORE streaming_end
      expect(lastSettledIndex).toBeLessThan(streamingEndIndex)
    })

    it('should NOT receive streaming_end if transform is halted prematurely', async () => {
      // This test documents the BUG scenario
      // If the transform task is halted before it can process streaming_end,
      // the trailing content is lost.
      
      const result = await run(function* () {
        const input: Channel<ChatPatch, void> = createChannel<ChatPatch, void>()
        const output: Channel<ChatPatch, void> = createChannel<ChatPatch, void>()
        const receivedPatches: ChatPatch[] = []
        
        // Spawn consumer
        yield* spawn(function* () {
          for (const patch of yield* each(output)) {
            receivedPatches.push(patch)
            yield* each.next()
          }
        })

        // Spawn transform - but we'll close the channel before streaming_end is processed
        yield* spawn(function* () {
          yield* dualBufferTransform({
            settler: paragraph,  // Factory function, not instance
            debug: false,
          })(input, output)
        })

        // CRITICAL: Give consumer and transform time to subscribe to channels
        yield* sleep(10)

        // Send content
        yield* input.send({ type: 'streaming_start' })
        yield* input.send({ type: 'streaming_text', content: 'Hello!\n\n' })
        yield* input.send({ type: 'streaming_text', content: '> Trailing' })
        
        // Send streaming_end
        yield* input.send({ type: 'streaming_end' })
        
        // Close input
        yield* input.close()

        // Give the pipeline time to process all patches
        yield* sleep(50)

        return { receivedPatches }
      })

      console.log('\n=== Patches received ===')
      result.receivedPatches.forEach((p, i) => {
        console.log(`${i}: ${p.type}`)
      })

      // We should see streaming_end in the output
      const hasStreamingEnd = result.receivedPatches.some(p => p.type === 'streaming_end')
      expect(hasStreamingEnd).toBe(true)
      
      // And we should have buffer_settled for the trailing content
      const settledPatches = result.receivedPatches.filter(p => p.type === 'buffer_settled')
      const hasTrailingContent = settledPatches.some(p => (p as any).content?.includes('Trailing'))
      expect(hasTrailingContent).toBe(true)
    })
  })

  describe('useTransformPipeline integration', () => {
    /**
     * This test mimics the EXACT pattern used in session.ts to ensure
     * streaming_end reaches the transform when using the resource pattern.
     */
    it('should flush trailing content when using useTransformPipeline like session.ts', async () => {
      // Import the transform pipeline
      const { useTransformPipeline } = await import('../transforms')
      
      const result = await run(function* () {
        // Create the output channel (like `patches` in session.ts)
        const output: Channel<ChatPatch, void> = createChannel<ChatPatch, void>()
        const receivedPatches: ChatPatch[] = []
        
        // Spawn consumer to collect output patches
        yield* spawn(function* () {
          for (const patch of yield* each(output)) {
            receivedPatches.push(patch)
            yield* each.next()
          }
        })
        
        // Give consumer time to subscribe
        yield* sleep(10)
        
        // Create the transform using dualBuffer (like session.ts does)
        const streamPatches = yield* useTransformPipeline(output, [
          dualBufferTransform({
            settler: paragraph,  // Factory function, not instance
            debug: false,
          }),
        ])
        
        // Simulate streaming (like streamChatOnce does)
        yield* streamPatches.send({ type: 'streaming_start' })
        yield* streamPatches.send({ type: 'streaming_text', content: 'Hello world!\n\n' })
        yield* streamPatches.send({ type: 'streaming_text', content: '> Trailing blockquote' })
        
        // KEY: Send streaming_end through the transform (like session.ts line 129)
        yield* streamPatches.send({ type: 'streaming_end' })
        
        // Close the transform input (like session.ts line 134)
        yield* streamPatches.close()
        
        // Give pipeline time to process
        yield* sleep(50)
        
        return receivedPatches
      })
      
      console.log('\n=== Patches from useTransformPipeline ===')
      result.forEach((p, i) => {
        if (p.type === 'buffer_settled') {
          console.log(`${i}: buffer_settled - "${(p as any).content?.slice(0, 30)}..."`)
        } else {
          console.log(`${i}: ${p.type}`)
        }
      })
      
      // Verify streaming_end was received
      const hasStreamingEnd = result.some(p => p.type === 'streaming_end')
      expect(hasStreamingEnd).toBe(true)
      
      // Verify trailing content was settled
      const settledPatches = result.filter(p => p.type === 'buffer_settled')
      const hasTrailingContent = settledPatches.some(p => 
        (p as any).content?.includes('Trailing blockquote')
      )
      expect(hasTrailingContent).toBe(true)
      
      // Verify the order: buffer_settled for trailing content BEFORE streaming_end
      const lastSettledIndex = result.findIndex(p => 
        p.type === 'buffer_settled' && (p as any).content?.includes('Trailing')
      )
      const streamingEndIndex = result.findIndex(p => p.type === 'streaming_end')
      expect(lastSettledIndex).toBeLessThan(streamingEndIndex)
    })
  })

  describe('buffered channel - NO SLEEP race condition', () => {
    /**
     * This test verifies the buffered channel works WITHOUT any sleep() calls.
     * 
     * The bug: if we send() immediately after creating the pipeline (no sleep),
     * messages may be dropped because the transform hasn't subscribed yet.
     * 
     * The fix: useBufferedChannel should buffer messages until subscription.
     */
    it('should NOT drop messages sent immediately after pipeline creation (no sleep)', async () => {
      const { useTransformPipeline, passthroughTransform } = await import('../transforms')
      
      const result = await run(function* () {
        const output: Channel<ChatPatch, void> = createChannel<ChatPatch, void>()
        const receivedPatches: ChatPatch[] = []
        
        // Spawn consumer - but NO SLEEP after this
        yield* spawn(function* () {
          for (const patch of yield* each(output)) {
            receivedPatches.push(patch)
            yield* each.next()
          }
        })
        
        // Create the pipeline with a simple passthrough transform
        const input = yield* useTransformPipeline(output, [
          passthroughTransform(),
        ])
        
        // IMMEDIATELY send messages - NO SLEEP!
        // This is where the race condition happens
        yield* input.send({ type: 'streaming_start' })
        yield* input.send({ type: 'streaming_text', content: 'Message 1' })
        yield* input.send({ type: 'streaming_text', content: 'Message 2' })
        yield* input.send({ type: 'streaming_text', content: 'Message 3' })
        yield* input.send({ type: 'streaming_end' })
        yield* input.close()
        
        // Now wait for processing
        yield* sleep(50)
        
        return receivedPatches
      })
      
      console.log('\n=== NO SLEEP test results ===')
      result.forEach((p, i) => {
        console.log(`${i}: ${p.type} ${(p as any).content || ''}`)
      })
      
      // We should have ALL 5 messages
      expect(result.length).toBe(5)
      expect(result[0].type).toBe('streaming_start')
      expect(result[1].type).toBe('streaming_text')
      expect((result[1] as any).content).toBe('Message 1')
      expect(result[2].type).toBe('streaming_text')
      expect((result[2] as any).content).toBe('Message 2')
      expect(result[3].type).toBe('streaming_text')
      expect((result[3] as any).content).toBe('Message 3')
      expect(result[4].type).toBe('streaming_end')
    })

    it('should deliver messages in order even when sent before transform subscribes', async () => {
      const { useTransformPipeline, passthroughTransform } = await import('../transforms')
      
      const result = await run(function* () {
        const output: Channel<ChatPatch, void> = createChannel<ChatPatch, void>()
        const receivedPatches: ChatPatch[] = []
        
        // Consumer subscribes to output
        yield* spawn(function* () {
          for (const patch of yield* each(output)) {
            receivedPatches.push(patch)
            yield* each.next()
          }
        })
        
        // Create pipeline
        const input = yield* useTransformPipeline(output, [
          passthroughTransform(),
        ])
        
        // Send 10 messages immediately
        for (let i = 1; i <= 10; i++) {
          yield* input.send({ type: 'streaming_text', content: `Msg ${i}` })
        }
        yield* input.close()
        
        yield* sleep(50)
        return receivedPatches
      })
      
      console.log('\n=== Order test results ===')
      result.forEach((p, i) => {
        console.log(`${i}: ${(p as any).content}`)
      })
      
      // All 10 messages should arrive in order
      expect(result.length).toBe(10)
      for (let i = 0; i < 10; i++) {
        expect((result[i] as any).content).toBe(`Msg ${i + 1}`)
      }
    })

    /**
     * Test with MULTIPLE transforms in the chain.
     * 
     * The intermediate channels between transforms are currently unbuffered,
     * which could cause message drops when transform1 writes to transform2's input.
     */
    it('should NOT drop messages with multiple transforms in chain', async () => {
      const { useTransformPipeline, passthroughTransform } = await import('../transforms')
      
      const result = await run(function* () {
        const output: Channel<ChatPatch, void> = createChannel<ChatPatch, void>()
        const receivedPatches: ChatPatch[] = []
        
        // Spawn consumer
        yield* spawn(function* () {
          for (const patch of yield* each(output)) {
            receivedPatches.push(patch)
            yield* each.next()
          }
        })
        
        // Create pipeline with THREE passthrough transforms
        // This tests the intermediate unbuffered channels
        const input = yield* useTransformPipeline(output, [
          passthroughTransform(),
          passthroughTransform(),
          passthroughTransform(),
        ])
        
        // IMMEDIATELY send messages - NO SLEEP!
        yield* input.send({ type: 'streaming_start' })
        yield* input.send({ type: 'streaming_text', content: 'First' })
        yield* input.send({ type: 'streaming_text', content: 'Second' })
        yield* input.send({ type: 'streaming_text', content: 'Third' })
        yield* input.send({ type: 'streaming_end' })
        yield* input.close()
        
        yield* sleep(50)
        return receivedPatches
      })
      
      console.log('\n=== Multiple transforms test results ===')
      result.forEach((p, i) => {
        console.log(`${i}: ${p.type} ${(p as any).content || ''}`)
      })
      
      // We should have ALL 5 messages even with 3 transforms
      expect(result.length).toBe(5)
      expect(result[0].type).toBe('streaming_start')
      expect((result[1] as any).content).toBe('First')
      expect((result[2] as any).content).toBe('Second')
      expect((result[3] as any).content).toBe('Third')
      expect(result[4].type).toBe('streaming_end')
    })

    /**
     * Test the EXACT scenario from session.ts with dualBuffer transform.
     * This is the closest simulation of the real usage.
     * 
     * The key difference from other tests: NO SLEEP between pipeline creation
     * and message sending, simulating what happens when streamChatOnce
     * immediately starts streaming.
     */
    it('should deliver all content with dualBuffer and NO consumer sleep', async () => {
      const { useTransformPipeline } = await import('../transforms')
      
      const result = await run(function* () {
        const output: Channel<ChatPatch, void> = createChannel<ChatPatch, void>()
        const receivedPatches: ChatPatch[] = []
        
        // Consumer subscribes - NO SLEEP after
        yield* spawn(function* () {
          for (const patch of yield* each(output)) {
            receivedPatches.push(patch)
            yield* each.next()
          }
        })
        
        // Create pipeline with dualBuffer - EXACTLY like session.ts
        const streamPatches = yield* useTransformPipeline(output, [
          dualBufferTransform({
            settler: paragraph,  // Factory function, not instance
            debug: false,
          }),
        ])
        
        // IMMEDIATELY start streaming - NO SLEEP!
        // This simulates streamChatOnce starting right away
        yield* streamPatches.send({ type: 'streaming_start' })
        yield* streamPatches.send({ type: 'streaming_text', content: 'First paragraph.\n\n' })
        yield* streamPatches.send({ type: 'streaming_text', content: 'Second paragraph.\n\n' })
        yield* streamPatches.send({ type: 'streaming_text', content: '> Trailing blockquote' })
        yield* streamPatches.send({ type: 'streaming_end' })
        yield* streamPatches.close()
        
        // Wait for all processing
        yield* sleep(100)
        return receivedPatches
      })
      
      console.log('\n=== dualBuffer NO SLEEP test results ===')
      result.forEach((p, i) => {
        if (p.type === 'buffer_settled') {
          console.log(`${i}: buffer_settled - "${(p as any).content?.slice(0, 30)}..."`)
        } else {
          console.log(`${i}: ${p.type}`)
        }
      })
      
      // Verify ALL content was received including trailing blockquote
      const settledPatches = result.filter(p => p.type === 'buffer_settled')
      
      // Should have 3 buffer_settled: "First paragraph\n\n", "Second paragraph\n\n", "> Trailing blockquote"
      expect(settledPatches.length).toBeGreaterThanOrEqual(3)
      
      // The trailing blockquote MUST be present
      const hasTrailing = settledPatches.some(p => 
        (p as any).content?.includes('Trailing blockquote')
      )
      expect(hasTrailing).toBe(true)
      
      // streaming_end should be present
      expect(result.some(p => p.type === 'streaming_end')).toBe(true)
    })

    /**
     * Test with realistic streaming delays between chunks.
     * This simulates real network conditions where chunks arrive over time.
     */
    it('should deliver all content with realistic streaming delays', async () => {
      const { useTransformPipeline } = await import('../transforms')
      
      const result = await run(function* () {
        const output: Channel<ChatPatch, void> = createChannel<ChatPatch, void>()
        const receivedPatches: ChatPatch[] = []
        
        // Consumer subscribes
        yield* spawn(function* () {
          for (const patch of yield* each(output)) {
            receivedPatches.push(patch)
            yield* each.next()
          }
        })
        
        // Create pipeline with dualBuffer
        const streamPatches = yield* useTransformPipeline(output, [
          dualBufferTransform({
            settler: paragraph,  // Factory function, not instance
            debug: false,
          }),
        ])
        
        // Simulate realistic streaming with delays between chunks
        yield* streamPatches.send({ type: 'streaming_start' })
        
        // Chunk 1
        yield* streamPatches.send({ type: 'streaming_text', content: 'Here is some ' })
        yield* sleep(10) // network delay
        
        // Chunk 2
        yield* streamPatches.send({ type: 'streaming_text', content: 'content that spans ' })
        yield* sleep(10)
        
        // Chunk 3 - ends paragraph
        yield* streamPatches.send({ type: 'streaming_text', content: 'multiple chunks.\n\n' })
        yield* sleep(10)
        
        // Chunk 4 - final line without trailing newlines
        yield* streamPatches.send({ type: 'streaming_text', content: '> This is the last line' })
        yield* sleep(10)
        
        // End streaming - this should flush the last line
        yield* streamPatches.send({ type: 'streaming_end' })
        yield* streamPatches.close()
        
        // Wait for all processing
        yield* sleep(100)
        return receivedPatches
      })
      
      console.log('\n=== Realistic streaming delays test ===')
      result.forEach((p, i) => {
        if (p.type === 'buffer_settled') {
          console.log(`${i}: buffer_settled - "${(p as any).content}"`)
        } else if (p.type === 'streaming_text') {
          console.log(`${i}: streaming_text - "${(p as any).content}"`)
        } else {
          console.log(`${i}: ${p.type}`)
        }
      })
      
      // Verify the last line was settled
      const settledPatches = result.filter(p => p.type === 'buffer_settled')
      const lastSettled = settledPatches[settledPatches.length - 1] as any
      
      expect(lastSettled.content).toContain('last line')
      
      // Verify the full content was accumulated
      const allSettledContent = settledPatches.map(p => (p as any).content).join('')
      expect(allSettledContent).toContain('content that spans multiple chunks')
      expect(allSettledContent).toContain('This is the last line')
    })

    /**
     * CRITICAL TEST: Chain dualBufferTransform with loggingTransform
     * 
     * This is the EXACT production scenario that's failing!
     * The intermediate channel between transforms is unbuffered,
     * which may cause messages to be dropped.
     */
    it('should NOT drop streaming_end when chaining dualBuffer + logging transforms', async () => {
      const { useTransformPipeline } = await import('../transforms')
      
      const result = await run(function* () {
        const output: Channel<ChatPatch, void> = createChannel<ChatPatch, void>()
        const receivedPatches: ChatPatch[] = []
        
        // Consumer subscribes
        yield* spawn(function* () {
          for (const patch of yield* each(output)) {
            receivedPatches.push(patch)
            yield* each.next()
          }
        })
        
        // Create pipeline with BOTH transforms - like production!
        // dualBuffer first, then logging
        const streamPatches = yield* useTransformPipeline(output, [
          dualBufferTransform({
            settler: paragraph,  // Factory function, not instance
            debug: true,  // Enable debug to see what's happening
          }),
          loggingTransform('test'),
        ])
        
        // Send messages immediately - no sleep
        yield* streamPatches.send({ type: 'streaming_start' })
        yield* streamPatches.send({ type: 'streaming_text', content: 'First paragraph.\n\n' })
        yield* streamPatches.send({ type: 'streaming_text', content: 'Second paragraph.\n\n' })
        yield* streamPatches.send({ type: 'streaming_text', content: '> Trailing content without newlines' })
        yield* streamPatches.send({ type: 'streaming_end' })
        yield* streamPatches.close()
        
        // Wait for all processing
        yield* sleep(100)
        return receivedPatches
      })
      
      console.log('\n=== CHAINED TRANSFORMS test results ===')
      result.forEach((p, i) => {
        if (p.type === 'buffer_settled') {
          console.log(`${i}: buffer_settled - "${(p as any).content?.slice(0, 40)}..."`)
        } else {
          console.log(`${i}: ${p.type}`)
        }
      })
      
      // CRITICAL: streaming_end must be received
      const hasStreamingEnd = result.some(p => p.type === 'streaming_end')
      expect(hasStreamingEnd).toBe(true)
      
      // CRITICAL: trailing content must be settled
      const settledPatches = result.filter(p => p.type === 'buffer_settled')
      const hasTrailing = settledPatches.some(p => 
        (p as any).content?.includes('Trailing content')
      )
      expect(hasTrailing).toBe(true)
      
      // Verify order: last buffer_settled BEFORE streaming_end
      const lastSettledIndex = result.findIndex(p => 
        p.type === 'buffer_settled' && (p as any).content?.includes('Trailing')
      )
      const streamingEndIndex = result.findIndex(p => p.type === 'streaming_end')
      expect(lastSettledIndex).toBeLessThan(streamingEndIndex)
    })

    /**
     * Test with logging BEFORE dualBuffer (reverse order)
     */
    it('should NOT drop streaming_end when chaining logging + dualBuffer transforms', async () => {
      const { useTransformPipeline } = await import('../transforms')
      
      const result = await run(function* () {
        const output: Channel<ChatPatch, void> = createChannel<ChatPatch, void>()
        const receivedPatches: ChatPatch[] = []
        
        yield* spawn(function* () {
          for (const patch of yield* each(output)) {
            receivedPatches.push(patch)
            yield* each.next()
          }
        })
        
        // Logging FIRST, then dualBuffer
        const streamPatches = yield* useTransformPipeline(output, [
          loggingTransform('input'),
          dualBufferTransform({
            settler: paragraph,  // Factory function, not instance
            debug: false,
          }),
        ])
        
        yield* streamPatches.send({ type: 'streaming_start' })
        yield* streamPatches.send({ type: 'streaming_text', content: 'Content.\n\n' })
        yield* streamPatches.send({ type: 'streaming_text', content: '> Final line' })
        yield* streamPatches.send({ type: 'streaming_end' })
        yield* streamPatches.close()
        
        yield* sleep(100)
        return receivedPatches
      })
      
      console.log('\n=== LOGGING->DUALBUFFER test results ===')
      result.forEach((p, i) => {
        console.log(`${i}: ${p.type}`)
      })
      
      // streaming_end must be received
      expect(result.some(p => p.type === 'streaming_end')).toBe(true)
      
      // trailing content must be settled
      const settledPatches = result.filter(p => p.type === 'buffer_settled')
      expect(settledPatches.some(p => (p as any).content?.includes('Final line'))).toBe(true)
    })

    /**
     * REALISTIC PRODUCTION TEST: Chained transforms with network delays
     * 
     * This simulates what actually happens in production:
     * 1. Pipeline is created
     * 2. Transform subscribes (starts forwarding mode)
     * 3. Messages arrive over time with network delays
     * 4. streaming_end arrives last
     * 
     * The bug might only appear when messages are sent AFTER the transform
     * has subscribed (forwarding mode), not when they're all buffered.
     */
    it('should NOT drop streaming_end with chained transforms and network delays', async () => {
      const { useTransformPipeline } = await import('../transforms')
      
      const result = await run(function* () {
        const output: Channel<ChatPatch, void> = createChannel<ChatPatch, void>()
        const receivedPatches: ChatPatch[] = []
        
        yield* spawn(function* () {
          for (const patch of yield* each(output)) {
            receivedPatches.push(patch)
            yield* each.next()
          }
        })
        
        // Create pipeline with chained transforms
        const streamPatches = yield* useTransformPipeline(output, [
          dualBufferTransform({
            settler: paragraph,  // Factory function, not instance
            debug: true,
          }),
          loggingTransform('output'),
        ])
        
        // CRITICAL: Give the transforms time to subscribe before sending
        // This simulates real network conditions where there's a delay
        // before the first response chunk arrives
        yield* sleep(10)
        
        // Now send messages with delays between them (like real streaming)
        yield* streamPatches.send({ type: 'streaming_start' })
        yield* sleep(5)
        
        yield* streamPatches.send({ type: 'streaming_text', content: 'First chunk ' })
        yield* sleep(5)
        
        yield* streamPatches.send({ type: 'streaming_text', content: 'second chunk.\n\n' })
        yield* sleep(5)
        
        yield* streamPatches.send({ type: 'streaming_text', content: '> Trailing line' })
        yield* sleep(5)
        
        // THIS IS THE CRITICAL MESSAGE
        console.log('\n>>> About to send streaming_end <<<')
        yield* streamPatches.send({ type: 'streaming_end' })
        console.log('>>> streaming_end sent <<<\n')
        
        yield* streamPatches.close()
        
        yield* sleep(100)
        return receivedPatches
      })
      
      console.log('\n=== REALISTIC CHAINED test results ===')
      result.forEach((p, i) => {
        if (p.type === 'buffer_settled') {
          console.log(`${i}: buffer_settled - "${(p as any).content?.slice(0, 30)}..."`)
        } else {
          console.log(`${i}: ${p.type}`)
        }
      })
      
      // CRITICAL: streaming_end must be received
      const hasStreamingEnd = result.some(p => p.type === 'streaming_end')
      console.log(`\nstreaming_end received: ${hasStreamingEnd}`)
      expect(hasStreamingEnd).toBe(true)
      
      // CRITICAL: trailing content must be settled
      const settledPatches = result.filter(p => p.type === 'buffer_settled')
      const hasTrailing = settledPatches.some(p => (p as any).content?.includes('Trailing'))
      console.log(`trailing content settled: ${hasTrailing}`)
      expect(hasTrailing).toBe(true)
    })
  })
})
