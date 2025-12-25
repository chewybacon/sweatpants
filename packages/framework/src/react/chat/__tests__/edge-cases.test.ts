/**
 * edge-cases.test.ts
 *
 * Tests for edge cases in the chat streaming system.
 */
import { describe, it, expect } from 'vitest'
import { run, createSignal, createChannel, spawn, each, sleep, call } from 'effection'
import { runChatSession } from '../session'
import { createTestStreamer, createImmediateStreamer } from '../testing'
import { dualBufferTransform } from '../dualBuffer'
import { paragraph, codeFence, line, maxSize } from '../settlers'
import type { ChatCommand, ChatPatch } from '../types'

describe('edge cases', () => {
  describe('empty and minimal content', () => {
    it('should handle empty text content gracefully', async () => {
      const result = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const commands = createSignal<ChatCommand, void>()
        const patches = createChannel<ChatPatch, void>()
        const received: ChatPatch[] = []

        yield* spawn(function* () {
          for (const patch of yield* each(patches)) {
            received.push(patch)
            yield* each.next()
          }
        })

        yield* spawn(function* () {
          yield* runChatSession(commands, patches, { streamer })
        })

        yield* sleep(10)
        commands.send({ type: 'send', content: 'Hello' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        // Empty text event
        yield* controls.emit({ type: 'text', content: '' })
        yield* controls.complete('')

        yield* sleep(100)
        return received
      })

      // Should complete without error
      expect(result.some(p => p.type === 'streaming_end')).toBe(true)
      expect(result.some(p => p.type === 'assistant_message')).toBe(true)
      
      // Assistant message should have empty content
      const assistantMsg = result.find(p => p.type === 'assistant_message')
      expect((assistantMsg as any)?.message?.content).toBe('')
    })

    it('should handle whitespace-only content', async () => {
      const result = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const commands = createSignal<ChatCommand, void>()
        const patches = createChannel<ChatPatch, void>()
        const received: ChatPatch[] = []

        yield* spawn(function* () {
          for (const patch of yield* each(patches)) {
            received.push(patch)
            yield* each.next()
          }
        })

        yield* spawn(function* () {
          yield* runChatSession(commands, patches, {
            streamer,
            transforms: [dualBufferTransform({ settler: paragraph })],
          })
        })

        yield* sleep(10)
        commands.send({ type: 'send', content: 'Hello' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        yield* controls.emit({ type: 'text', content: '   \n\n   ' })
        yield* controls.complete('   \n\n   ')

        yield* sleep(100)
        return received
      })

      // Should process whitespace normally
      expect(result.some(p => p.type === 'buffer_settled')).toBe(true)
    })

    it('should handle single character messages', async () => {
      const result = await run(function* () {
        const streamer = createImmediateStreamer(
          [{ type: 'text', content: 'X' }],
          'X'
        )

        const commands = createSignal<ChatCommand, void>()
        const patches = createChannel<ChatPatch, void>()
        const received: ChatPatch[] = []

        yield* spawn(function* () {
          for (const patch of yield* each(patches)) {
            received.push(patch)
            yield* each.next()
          }
        })

        yield* spawn(function* () {
          yield* runChatSession(commands, patches, { streamer })
        })

        yield* sleep(10)
        commands.send({ type: 'send', content: 'A' })
        yield* sleep(200)

        return received
      })

      const assistantMsg = result.find(p => p.type === 'assistant_message')
      expect((assistantMsg as any)?.message?.content).toBe('X')
    })
  })

  describe('very long content', () => {
    it('should handle very long streaming text', async () => {
      const longContent = 'A'.repeat(10000)
      
      const result = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const commands = createSignal<ChatCommand, void>()
        const patches = createChannel<ChatPatch, void>()
        const received: ChatPatch[] = []

        yield* spawn(function* () {
          for (const patch of yield* each(patches)) {
            received.push(patch)
            yield* each.next()
          }
        })

        yield* spawn(function* () {
          yield* runChatSession(commands, patches, { streamer })
        })

        yield* sleep(10)
        commands.send({ type: 'send', content: 'Generate long text' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        yield* controls.emit({ type: 'text', content: longContent })
        yield* controls.complete(longContent)

        yield* sleep(100)
        return received
      })

      const textPatch = result.find(p => p.type === 'streaming_text')
      expect((textPatch as any)?.content?.length).toBe(10000)
    })

    it('should handle long content with maxSize settler', async () => {
      const result = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const commands = createSignal<ChatCommand, void>()
        const patches = createChannel<ChatPatch, void>()
        const received: ChatPatch[] = []

        yield* spawn(function* () {
          for (const patch of yield* each(patches)) {
            received.push(patch)
            yield* each.next()
          }
        })

        yield* spawn(function* () {
          yield* runChatSession(commands, patches, {
            streamer,
            transforms: [dualBufferTransform({ settler: () => maxSize(100) })],
          })
        })

        yield* sleep(10)
        commands.send({ type: 'send', content: 'Test' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        // Send content exceeding max size
        yield* controls.emit({ type: 'text', content: 'X'.repeat(150) })
        yield* controls.complete('X'.repeat(150))

        yield* sleep(100)
        return received
      })

      // Should settle when exceeding 100 chars
      const settledPatches = result.filter(p => p.type === 'buffer_settled')
      expect(settledPatches.length).toBeGreaterThanOrEqual(1)
    })

    it('should handle many small chunks', async () => {
      const result = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const commands = createSignal<ChatCommand, void>()
        const patches = createChannel<ChatPatch, void>()
        const received: ChatPatch[] = []

        yield* spawn(function* () {
          for (const patch of yield* each(patches)) {
            received.push(patch)
            yield* each.next()
          }
        })

        yield* spawn(function* () {
          yield* runChatSession(commands, patches, {
            streamer,
            transforms: [dualBufferTransform({ settler: line })],
          })
        })

        yield* sleep(10)
        commands.send({ type: 'send', content: 'Test' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        // Send 50 individual lines
        for (let i = 0; i < 50; i++) {
          yield* controls.emit({ type: 'text', content: `Line ${i}\n` })
        }
        yield* controls.complete(Array.from({ length: 50 }, (_, i) => `Line ${i}\n`).join(''))

        yield* sleep(100)
        return received
      })

      const settledPatches = result.filter(p => p.type === 'buffer_settled')
      expect(settledPatches.length).toBe(50)
    })
  })

  describe('unicode and special characters', () => {
    it('should handle emoji in content', async () => {
      const result = await run(function* () {
        const streamer = createImmediateStreamer(
          [{ type: 'text', content: 'Hello! 👋🌍🎉 How are you? 😊' }],
          'Hello! 👋🌍🎉 How are you? 😊'
        )

        const commands = createSignal<ChatCommand, void>()
        const patches = createChannel<ChatPatch, void>()
        const received: ChatPatch[] = []

        yield* spawn(function* () {
          for (const patch of yield* each(patches)) {
            received.push(patch)
            yield* each.next()
          }
        })

        yield* spawn(function* () {
          yield* runChatSession(commands, patches, { streamer })
        })

        yield* sleep(10)
        commands.send({ type: 'send', content: 'Hi' })
        yield* sleep(200)

        return received
      })

      const textPatch = result.find(p => p.type === 'streaming_text')
      expect((textPatch as any)?.content).toContain('👋')
      expect((textPatch as any)?.content).toContain('🌍')
      expect((textPatch as any)?.content).toContain('😊')
    })

    it('should handle Chinese characters', async () => {
      const result = await run(function* () {
        const streamer = createImmediateStreamer(
          [{ type: 'text', content: '你好世界！这是一个测试。' }],
          '你好世界！这是一个测试。'
        )

        const commands = createSignal<ChatCommand, void>()
        const patches = createChannel<ChatPatch, void>()
        const received: ChatPatch[] = []

        yield* spawn(function* () {
          for (const patch of yield* each(patches)) {
            received.push(patch)
            yield* each.next()
          }
        })

        yield* spawn(function* () {
          yield* runChatSession(commands, patches, { streamer })
        })

        yield* sleep(10)
        commands.send({ type: 'send', content: '你好' })
        yield* sleep(200)

        return received
      })

      const textPatch = result.find(p => p.type === 'streaming_text')
      expect((textPatch as any)?.content).toBe('你好世界！这是一个测试。')
    })

    it('should handle mixed RTL and LTR text', async () => {
      const mixedText = 'Hello مرحبا שלום World'
      
      const result = await run(function* () {
        const streamer = createImmediateStreamer(
          [{ type: 'text', content: mixedText }],
          mixedText
        )

        const commands = createSignal<ChatCommand, void>()
        const patches = createChannel<ChatPatch, void>()
        const received: ChatPatch[] = []

        yield* spawn(function* () {
          for (const patch of yield* each(patches)) {
            received.push(patch)
            yield* each.next()
          }
        })

        yield* spawn(function* () {
          yield* runChatSession(commands, patches, { streamer })
        })

        yield* sleep(10)
        commands.send({ type: 'send', content: 'Test' })
        yield* sleep(200)

        return received
      })

      const textPatch = result.find(p => p.type === 'streaming_text')
      expect((textPatch as any)?.content).toBe(mixedText)
    })

    it('should handle special markdown characters', async () => {
      const specialContent = '`code` *bold* _italic_ [link](url) > quote # heading'
      
      const result = await run(function* () {
        const streamer = createImmediateStreamer(
          [{ type: 'text', content: specialContent }],
          specialContent
        )

        const commands = createSignal<ChatCommand, void>()
        const patches = createChannel<ChatPatch, void>()
        const received: ChatPatch[] = []

        yield* spawn(function* () {
          for (const patch of yield* each(patches)) {
            received.push(patch)
            yield* each.next()
          }
        })

        yield* spawn(function* () {
          yield* runChatSession(commands, patches, { streamer })
        })

        yield* sleep(10)
        commands.send({ type: 'send', content: 'Test' })
        yield* sleep(200)

        return received
      })

      const textPatch = result.find(p => p.type === 'streaming_text')
      expect((textPatch as any)?.content).toBe(specialContent)
    })
  })

  describe('code fence edge cases', () => {
    it('should handle unclosed code fence', async () => {
      const result = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const commands = createSignal<ChatCommand, void>()
        const patches = createChannel<ChatPatch, void>()
        const received: ChatPatch[] = []

        yield* spawn(function* () {
          for (const patch of yield* each(patches)) {
            received.push(patch)
            yield* each.next()
          }
        })

        yield* spawn(function* () {
          yield* runChatSession(commands, patches, {
            streamer,
            transforms: [dualBufferTransform({ settler: codeFence })],
          })
        })

        yield* sleep(10)
        commands.send({ type: 'send', content: 'Show code' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        // Unclosed fence
        yield* controls.emit({ type: 'text', content: '```python\ndef foo():\n    pass\n' })
        // Stream ends without closing ```
        yield* controls.complete('```python\ndef foo():\n    pass\n')

        yield* sleep(100)
        return received
      })

      // Should still complete and settle remaining content
      expect(result.some(p => p.type === 'streaming_end')).toBe(true)
      const settledPatches = result.filter(p => p.type === 'buffer_settled')
      expect(settledPatches.length).toBeGreaterThan(0)
    })

    it('should handle nested code block syntax (code showing code)', async () => {
      const codeShowingCode = '````markdown\n```python\ncode\n```\n````\n\n'
      
      const result = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const commands = createSignal<ChatCommand, void>()
        const patches = createChannel<ChatPatch, void>()
        const received: ChatPatch[] = []

        yield* spawn(function* () {
          for (const patch of yield* each(patches)) {
            received.push(patch)
            yield* each.next()
          }
        })

        yield* spawn(function* () {
          yield* runChatSession(commands, patches, {
            streamer,
            transforms: [dualBufferTransform({ settler: paragraph })],
          })
        })

        yield* sleep(10)
        commands.send({ type: 'send', content: 'Show code example' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        yield* controls.emit({ type: 'text', content: codeShowingCode })
        yield* controls.complete(codeShowingCode)

        yield* sleep(100)
        return received
      })

      // Should process without errors
      expect(result.some(p => p.type === 'buffer_settled')).toBe(true)
    })

    it('should handle empty code block', async () => {
      const result = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const commands = createSignal<ChatCommand, void>()
        const patches = createChannel<ChatPatch, void>()
        const received: ChatPatch[] = []

        yield* spawn(function* () {
          for (const patch of yield* each(patches)) {
            received.push(patch)
            yield* each.next()
          }
        })

        yield* spawn(function* () {
          yield* runChatSession(commands, patches, {
            streamer,
            transforms: [dualBufferTransform({ settler: codeFence })],
          })
        })

        yield* sleep(10)
        commands.send({ type: 'send', content: 'Empty code' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        yield* controls.emit({ type: 'text', content: '```\n```\n' })
        yield* controls.complete('```\n```\n')

        yield* sleep(100)
        return received
      })

      const settledPatches = result.filter(p => p.type === 'buffer_settled')
      // Should have fence open and fence close
      expect(settledPatches.length).toBeGreaterThanOrEqual(2)
    })

    it('should handle code block with only whitespace', async () => {
      const result = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const commands = createSignal<ChatCommand, void>()
        const patches = createChannel<ChatPatch, void>()
        const received: ChatPatch[] = []

        yield* spawn(function* () {
          for (const patch of yield* each(patches)) {
            received.push(patch)
            yield* each.next()
          }
        })

        yield* spawn(function* () {
          yield* runChatSession(commands, patches, {
            streamer,
            transforms: [dualBufferTransform({ settler: codeFence })],
          })
        })

        yield* sleep(10)
        commands.send({ type: 'send', content: 'Whitespace code' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        yield* controls.emit({ type: 'text', content: '```\n   \n\t\n```\n' })
        yield* controls.complete('```\n   \n\t\n```\n')

        yield* sleep(100)
        return received
      })

      expect(result.some(p => p.type === 'buffer_settled')).toBe(true)
    })
  })

  describe('newline variations', () => {
    it('should handle Windows line endings (CRLF)', async () => {
      const windowsContent = 'Line 1\r\nLine 2\r\nLine 3\r\n'
      
      const result = await run(function* () {
        const streamer = createImmediateStreamer(
          [{ type: 'text', content: windowsContent }],
          windowsContent
        )

        const commands = createSignal<ChatCommand, void>()
        const patches = createChannel<ChatPatch, void>()
        const received: ChatPatch[] = []

        yield* spawn(function* () {
          for (const patch of yield* each(patches)) {
            received.push(patch)
            yield* each.next()
          }
        })

        yield* spawn(function* () {
          yield* runChatSession(commands, patches, { streamer })
        })

        yield* sleep(10)
        commands.send({ type: 'send', content: 'Test' })
        yield* sleep(200)

        return received
      })

      const textPatch = result.find(p => p.type === 'streaming_text')
      expect((textPatch as any)?.content).toContain('\r\n')
    })

    it('should handle mixed line endings', async () => {
      const mixedContent = 'Unix\nWindows\r\nMac\rEnd'
      
      const result = await run(function* () {
        const streamer = createImmediateStreamer(
          [{ type: 'text', content: mixedContent }],
          mixedContent
        )

        const commands = createSignal<ChatCommand, void>()
        const patches = createChannel<ChatPatch, void>()
        const received: ChatPatch[] = []

        yield* spawn(function* () {
          for (const patch of yield* each(patches)) {
            received.push(patch)
            yield* each.next()
          }
        })

        yield* spawn(function* () {
          yield* runChatSession(commands, patches, { streamer })
        })

        yield* sleep(10)
        commands.send({ type: 'send', content: 'Test' })
        yield* sleep(200)

        return received
      })

      const textPatch = result.find(p => p.type === 'streaming_text')
      expect((textPatch as any)?.content).toBe(mixedContent)
    })
  })
})
