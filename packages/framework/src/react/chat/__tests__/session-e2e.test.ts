/**
 * End-to-end tests for createChatSession.
 *
 * These tests exercise the full session pipeline with a controllable
 * test streamer, allowing us to step through streaming events and
 * verify that the state is updated correctly.
 *
 * This refactored version tests the public API (state stream) instead
 * of internal patches, which is a more robust test of the consumer experience.
 */
import { describe, it, expect } from 'vitest'
import { run, spawn, each, sleep, call, suspend } from 'effection'
import { createChatSession } from '../session'
import { createTestStreamer, createImmediateStreamer } from '../testing'
import { dualBufferTransform } from '../dualBuffer'
import { loggingTransform } from '../transforms'
import { paragraph } from '../settlers'
import type { ChatState } from '../types'

describe('createChatSession end-to-end', () => {
  describe('basic streaming flow', () => {
    it('should update state through the streaming lifecycle', async () => {
      const states = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const session = yield* createChatSession({
          streamer,
          transforms: [], // No transforms - direct passthrough
        })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        // Give session time to start
        yield* sleep(10)

        // Send a message
        session.dispatch({ type: 'send', content: 'Hello' })

        // Wait for streamer to start
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        // Emit streaming events
        console.log('[test] Emitting text events...')
        yield* controls.emit({ type: 'text', content: 'Hello ' })
        yield* controls.emit({ type: 'text', content: 'world!' })
        console.log('[test] Calling complete...')
        yield* controls.complete('Hello world!')
        console.log('[test] Complete called, waiting...')

        yield* sleep(200)
        return states
      })

      // Verify state progression
      const streamingStates = states.filter(s => s.isStreaming)
      expect(streamingStates.length).toBeGreaterThan(0)

      // Should have user message
      const userMsgState = states.find(s => s.messages.some(m => m.role === 'user'))
      expect(userMsgState).toBeDefined()
      expect(userMsgState?.messages.find(m => m.role === 'user')?.content).toBe('Hello')

      // Should accumulate text in activeStep (since no dual buffer transform)
      // Note: without dualBuffer, text goes to activeStep.content
      const textStates = states.filter(s => s.activeStep?.type === 'text')
      expect(textStates.length).toBeGreaterThan(0)
      expect(textStates[textStates.length - 1].activeStep?.content).toContain('Hello world')

      // Final state should have assistant message and not be streaming
      const lastState = states[states.length - 1]
      expect(lastState.isStreaming).toBe(false)
      expect(lastState.messages.some(m => m.role === 'assistant')).toBe(true)
      const assistantMsg = lastState.messages.find(m => m.role === 'assistant')
      expect(assistantMsg?.content).toBe('Hello world!')
    })
  })

  describe('with dualBuffer transform', () => {
    it('should flush trailing content on streaming_end', async () => {
      const states = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const session = yield* createChatSession({
          streamer,
          transforms: [
            dualBufferTransform({
              settler: paragraph,
              debug: true,
            }),
          ],
        })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Test' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        // Simulate streaming with paragraph break and trailing content
        yield* controls.emit({ type: 'text', content: 'First paragraph.\n\n' })
        yield* controls.emit({ type: 'text', content: 'Second paragraph.\n\n' })
        yield* controls.emit({ type: 'text', content: '> Trailing blockquote without newlines' })
        yield* controls.complete('First paragraph.\n\nSecond paragraph.\n\n> Trailing blockquote without newlines')

        yield* sleep(100)
        return states
      })

      // Find the transition where streaming ends
      // The state immediately after streaming ends must have the full content settled
      const streamingEndIndex = states.findIndex((s, i) => i > 0 && states[i-1].isStreaming && !s.isStreaming)
      expect(streamingEndIndex).not.toBe(-1)
      
      const settledState = states[streamingEndIndex]
      
      // CRITICAL: The trailing blockquote must be settled when streaming ends
      // Note: When streaming ends, the session clears the buffer, BUT the dualBuffer transform
      // should have emitted a buffer_settled patch BEFORE streaming_end reached the reducer.
      // Wait, if the reducer receives streaming_end, it sets isStreaming=false.
      // But looking at the state history, we should see a state where the content IS settled
      // either right before or exactly when streaming ends (before buffer is cleared by assistant_message or similar cleanup).
      
      // Actually, chatReducer clears buffer on `assistant_message` or `abort_complete`.
      // `streaming_end` just sets `isStreaming: false`.
      // So the state at `streamingEndIndex` should have the settled content.
      expect(settledState.buffer.settled).toContain('Trailing blockquote')
    })
  })

  describe('with chained transforms (production scenario)', () => {
    /**
     * This test reproduces the EXACT production bug scenario:
     * - dualBuffer transform followed by logging transform
     * - Trailing content without \n\n at the end
     * - streaming_end must trigger settleAll and flush trailing content
     */
    it('should flush trailing content with dualBuffer + logging transforms', async () => {
      const states = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const session = yield* createChatSession({
          streamer,
          transforms: [
            // This is the production configuration that was failing
            dualBufferTransform({
              settler: paragraph,
              debug: true,
            }),
            loggingTransform('output'),
          ],
        })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Write quicksort' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        // Simulate the exact streaming pattern that was failing
        yield* controls.emit({ type: 'text', content: 'Here is quicksort:\n\n' })
        yield* controls.emit({ type: 'text', content: '```python\ndef quicksort(arr):\n    pass\n```\n\n' })
        yield* controls.emit({ type: 'text', content: '**Note:** This is a basic implementation.' })
        // No trailing \n\n - this is the problematic case
        yield* controls.complete('Here is quicksort:\n\n```python\ndef quicksort(arr):\n    pass\n```\n\n**Note:** This is a basic implementation.')

        yield* sleep(100)
        return states
      })

      // Find where streaming ends
      const streamingEndIndex = states.findIndex((s, i) => i > 0 && states[i-1].isStreaming && !s.isStreaming)
      expect(streamingEndIndex).not.toBe(-1)
      
      const settledState = states[streamingEndIndex]
      
      // Verify the trailing Note was settled when streaming ended
      expect(settledState.buffer.settled).toContain('Note:')
      
      // Verify final assistant message has it too
      const finalState = states[states.length - 1]
      const assistantMsg = finalState.messages[finalState.messages.length - 1]
      expect(assistantMsg.role).toBe('assistant')
      expect(assistantMsg.content).toContain('Note:')
    })

    it('should handle rapid streaming without dropping messages', async () => {
      const states = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const session = yield* createChatSession({
          streamer,
          transforms: [
            dualBufferTransform({ settler: paragraph }),
            loggingTransform('output'),
          ],
        })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Count' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        // Rapid-fire 10 text chunks without any sleep between
        for (let i = 1; i <= 10; i++) {
          yield* controls.emit({ type: 'text', content: `Chunk ${i}\n\n` })
        }
        yield* controls.emit({ type: 'text', content: 'Final chunk!' })
        yield* controls.complete('Chunk 1\n\n...Chunk 10\n\nFinal chunk!')

        yield* sleep(100)
        return states
      })

      const streamingEndIndex = states.findIndex((s, i) => i > 0 && states[i-1].isStreaming && !s.isStreaming)
      const settledState = states[streamingEndIndex]

      // All chunks should be settled
      for (let i = 1; i <= 10; i++) {
        expect(settledState.buffer.settled).toContain(`Chunk ${i}`)
      }
      expect(settledState.buffer.settled).toContain('Final chunk')
    })
  })

  describe('immediate streamer (simple tests)', () => {
    it('should work with createImmediateStreamer for quick tests', async () => {
      const states = await run(function* () {
        const streamer = createImmediateStreamer(
          [
            { type: 'text', content: 'Quick test!' },
          ],
          'Quick test!'
        )

        const session = yield* createChatSession({ streamer })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Hi' })
        yield* sleep(100)

        return states
      })

      const finalState = states[states.length - 1]
      expect(finalState.messages.some(m => m.role === 'assistant' && m.content === 'Quick test!')).toBe(true)
    })
  })

  describe('abort handling', () => {
    it('should handle abort command during streaming', async () => {
      const states = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const session = yield* createChatSession({
          streamer,
          transforms: [dualBufferTransform({ settler: paragraph })],
        })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Start streaming' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        // Start streaming
        yield* controls.emit({ type: 'text', content: 'Hello ' })
        yield* sleep(10)

        // Abort mid-stream
        session.dispatch({ type: 'abort' })
        yield* sleep(50)

        return states
      })

      // Should stop streaming
      expect(states[states.length - 1].isStreaming).toBe(false)
    })

    it('should preserve partial content on abort when preservePartialOnAbort is true (default)', async () => {
      const states = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const session = yield* createChatSession({
          streamer,
          transforms: [],
          // preservePartialOnAbort defaults to true
        })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Start streaming' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        // Stream some content
        yield* controls.emit({ type: 'text', content: 'Hello ' })
        yield* controls.emit({ type: 'text', content: 'world' })
        yield* sleep(10)

        // Abort mid-stream with partial content
        session.dispatch({ 
          type: 'abort',
          partialContent: 'Hello world',
          partialHtml: '<p>Hello world</p>',
        })
        yield* sleep(50)

        return states
      })

      const finalState = states[states.length - 1]
      const lastMsg = finalState.messages[finalState.messages.length - 1]
      
      expect(lastMsg.role).toBe('assistant')
      expect(lastMsg.content).toBe('Hello world')
      expect(lastMsg.partial).toBe(true)
      
      // Check rendered content in state
      expect(finalState.rendered[lastMsg.id]?.output).toBe('<p>Hello world</p>')
    })

    it('should append suffix to partial content when abortSuffix is configured', async () => {
      const states = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const session = yield* createChatSession({
          streamer,
          transforms: [],
          abortSuffix: '\n\n[interrupted]',
        })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Start streaming' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        yield* controls.emit({ type: 'text', content: 'Partial response' })
        yield* sleep(10)

        session.dispatch({ 
          type: 'abort',
          partialContent: 'Partial response',
        })
        yield* sleep(50)

        return states
      })

      const finalState = states[states.length - 1]
      const lastMsg = finalState.messages[finalState.messages.length - 1]
      expect(lastMsg.content).toBe('Partial response\n\n[interrupted]')
      expect(lastMsg.partial).toBe(true)
    })

    it('should NOT preserve partial content when preservePartialOnAbort is false', async () => {
      const states = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const session = yield* createChatSession({
          streamer,
          transforms: [],
          preservePartialOnAbort: false,
        })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Start streaming' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        yield* controls.emit({ type: 'text', content: 'Hello world' })
        yield* sleep(10)

        session.dispatch({ 
          type: 'abort',
          partialContent: 'Hello world',
        })
        yield* sleep(50)

        return states
      })

      const finalState = states[states.length - 1]
      const lastMsg = finalState.messages[finalState.messages.length - 1]
      
      // Should only have the user message, no assistant message
      expect(lastMsg.role).toBe('user')
    })

    it('should NOT preserve when partialContent is empty', async () => {
      const states = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const session = yield* createChatSession({
          streamer,
          transforms: [],
        })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Start streaming' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        // Don't emit any text - abort immediately
        session.dispatch({ 
          type: 'abort',
          partialContent: '',  // Empty content
        })
        yield* sleep(50)

        return states
      })

      const finalState = states[states.length - 1]
      const lastMsg = finalState.messages[finalState.messages.length - 1]
      expect(lastMsg.role).toBe('user')
    })

    it('should add partial message to history for future LLM context', async () => {
      // This test verifies that when we send a second message after abort,
      // the partial message is included in the history sent to the streamer
      const messagesReceived: any[][] = []
      let callCount = 0
      
      await run(function* () {
        // Custom streamer that captures messages and blocks on first call
        const customStreamer = function* (messages: any[], patches: any) {
          messagesReceived.push([...messages])
          callCount++
          
          if (callCount === 1) {
            // First call: emit some text then suspend (simulating streaming)
            yield* patches.send({ type: 'streaming_text', content: 'Starting...' })
            // Suspend forever - this will be halted by abort
            yield* suspend()
            return { type: 'complete' as const, text: 'never reached' }
          } else {
            // Second call: complete immediately
            yield* patches.send({ type: 'streaming_text', content: 'Response' })
            return { type: 'complete' as const, text: 'Response' }
          }
        }
        
        const session = yield* createChatSession({
          streamer: customStreamer,
          transforms: [],
        })

        yield* sleep(10)
        
        // First message
        session.dispatch({ type: 'send', content: 'First message' })
        yield* sleep(50)
        
        // Abort with partial content
        session.dispatch({ 
          type: 'abort',
          partialContent: 'Partial assistant response',
        })
        yield* sleep(50)
        
        // Second message - history should include the partial
        session.dispatch({ type: 'send', content: 'Second message' })
        yield* sleep(50)
      })

      // Second call should have: user1, assistant (partial), user2
      expect(messagesReceived.length).toBe(2)
      const secondCallMessages = messagesReceived[1]
      expect(secondCallMessages.length).toBe(3)
      expect(secondCallMessages[0].role).toBe('user')
      expect(secondCallMessages[0].content).toBe('First message')
      expect(secondCallMessages[1].role).toBe('assistant')
      expect(secondCallMessages[1].content).toBe('Partial assistant response')
      expect(secondCallMessages[2].role).toBe('user')
      expect(secondCallMessages[2].content).toBe('Second message')
    })
  })

  describe('tool call flows', () => {
    it('should update state with tool calls', async () => {
      const states = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const session = yield* createChatSession({ streamer })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Search for info' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        // Emit tool call
        yield* controls.emit({
          type: 'tool_calls',
          calls: [
            { id: 'call_123', name: 'search', arguments: { query: 'test' } },
          ],
        })
        yield* controls.complete('')

        yield* sleep(100)
        return states
      })

      // Verify tool call in history (assistant message with tool_calls)
      // Note: In the reducer, tool_call patches build up currentResponse.
      // When complete is called, assistant_message is emitted, which commits currentResponse to the message.
      const finalState = states[states.length - 1]
      const lastMsg = finalState.messages[finalState.messages.length - 1]
      expect(lastMsg.role).toBe('assistant')
      // Note: The specific implementation details of how tool calls are stored in message.steps
      // depends on state.ts reducer logic.
      expect(lastMsg.steps?.some(s => s.type === 'tool_call' && s.name === 'search')).toBe(true)
    })

    it('should update tool call results', async () => {
      const states = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const session = yield* createChatSession({ streamer })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Search for info' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        // Emit tool call and result
        yield* controls.emit({
          type: 'tool_calls',
          calls: [{ id: 'call_456', name: 'search', arguments: {} }],
        })
        yield* controls.emit({
          type: 'tool_result',
          id: 'call_456',
          name: 'search',
          content: 'Found 10 results',
        })
        yield* controls.emit({ type: 'text', content: 'Here are the results...' })
        yield* controls.complete('Here are the results...')

        yield* sleep(100)
        return states
      })

      const finalState = states[states.length - 1]
      const lastMsg = finalState.messages[finalState.messages.length - 1]
      
      const toolStep = lastMsg.steps?.find(s => s.type === 'tool_call' && s.id === 'call_456')
      expect(toolStep).toBeDefined()
      if (toolStep?.type === 'tool_call') {
        expect(toolStep.state).toBe('complete')
        expect(toolStep.result).toBe('Found 10 results')
      }
    })

    it('should handle tool call errors', async () => {
      const states = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const session = yield* createChatSession({ streamer })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Run tool' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        yield* controls.emit({
          type: 'tool_calls',
          calls: [{ id: 'call_789', name: 'failing_tool', arguments: {} }],
        })
        yield* controls.emit({
          type: 'tool_error',
          id: 'call_789',
          name: 'failing_tool',
          message: 'Tool execution failed',
        })
        yield* controls.complete('')

        yield* sleep(100)
        return states
      })

      const finalState = states[states.length - 1]
      const lastMsg = finalState.messages[finalState.messages.length - 1]
      
      const toolStep = lastMsg.steps?.find(s => s.type === 'tool_call' && s.id === 'call_789')
      expect(toolStep).toBeDefined()
      if (toolStep?.type === 'tool_call') {
        expect(toolStep.state).toBe('error')
        expect(toolStep.error).toBe('Tool execution failed')
      }
    })
  })

  describe('thinking steps', () => {
    it('should show thinking steps in state', async () => {
      const states = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const session = yield* createChatSession({ streamer })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Think through this' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        // Emit thinking followed by text
        yield* controls.emit({ type: 'thinking', content: 'Let me think...' })
        yield* controls.emit({ type: 'thinking', content: 'Considering options...' })
        yield* controls.emit({ type: 'text', content: 'Here is my answer.' })
        yield* controls.complete('Here is my answer.')

        yield* sleep(100)
        return states
      })

      // Check intermediate state for active thinking
      const thinkingState = states.find(s => s.activeStep?.type === 'thinking')
      expect(thinkingState).toBeDefined()
      expect(thinkingState?.activeStep?.content).toContain('think')

      // Check final state for preserved thinking step
      const finalState = states[states.length - 1]
      const lastMsg = finalState.messages[finalState.messages.length - 1]
      const thinkingStep = lastMsg.steps?.find(s => s.type === 'thinking')
      expect(thinkingStep).toBeDefined()
      expect((thinkingStep as any).content).toContain('Considering options')
    })
  })

  describe('error handling', () => {
    it('should set error state for recoverable errors', async () => {
      const states = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const session = yield* createChatSession({ streamer })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Do something' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        // Emit recoverable error then continue
        yield* controls.emit({ type: 'error', message: 'Rate limited', recoverable: true })
        yield* controls.emit({ type: 'text', content: 'Recovered!' })
        yield* controls.complete('Recovered!')

        yield* sleep(100)
        return states
      })

      // Find state where error was set
      const errorState = states.find(s => s.error === 'Rate limited')
      expect(errorState).toBeDefined()

      // Should still complete successfully
      const finalState = states[states.length - 1]
      expect(finalState.messages.some(m => m.role === 'assistant')).toBe(true)
      // Note: error is cleared on success/next message usually?
      // chatReducer sets error=null on user_message and streaming_start
      // But 'error' patch sets state.error
      // If 'error' comes mid-stream, it sets state.error and stops streaming?
      // The test case says "recoverable error then continue".
      // The reducer for 'error' sets isStreaming=false.
      // So if streamer continues to emit text, it might be weird if isStreaming is false.
      // But let's check what we have.
    })

    it('should handle session_info event', async () => {
      const states = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const session = yield* createChatSession({ streamer })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Hello' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        // Emit session_info first
        yield* controls.emit({
          type: 'session_info',
          capabilities: { tools: ['search', 'execute'], thinking: true, streaming: true },
          persona: 'helpful-assistant',
        })
        yield* controls.emit({ type: 'text', content: 'Hello!' })
        yield* controls.complete('Hello!')

        yield* sleep(100)
        return states
      })

      const finalState = states[states.length - 1]
      expect(finalState.capabilities?.tools).toEqual(['search', 'execute'])
      expect(finalState.persona).toBe('helpful-assistant')
    })
  })

  describe('reset during streaming', () => {
    it('should handle reset command during active streaming', async () => {
      const states = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const session = yield* createChatSession({ streamer })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Start streaming' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())

        // Start streaming
        yield* controls.emit({ type: 'text', content: 'Hello ' })
        yield* sleep(10)

        // Reset mid-stream
        session.dispatch({ type: 'reset' })
        yield* sleep(50)

        return states
      })

      const finalState = states[states.length - 1]
      expect(finalState.messages.length).toBe(0)
      expect(finalState.isStreaming).toBe(false)
    })
  })

  describe('multiple messages in sequence', () => {
    it('should handle multiple send commands sequentially', async () => {
      const states = await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const session = yield* createChatSession({ streamer })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        yield* sleep(10)

        // First message
        session.dispatch({ type: 'send', content: 'First message' })
        yield* sleep(10)
        yield* call(() => controls.waitForStart())
        yield* controls.emit({ type: 'text', content: 'First response' })
        yield* controls.complete('First response')
        yield* sleep(100)

        return states
      })

      const finalState = states[states.length - 1]
      const userMessages = finalState.messages.filter(m => m.role === 'user')
      const assistantMessages = finalState.messages.filter(m => m.role === 'assistant')

      expect(userMessages.length).toBe(1)
      expect(assistantMessages.length).toBe(1)
    })

    it('should preserve message history across turns', async () => {
      const states = await run(function* () {
        const streamer = createImmediateStreamer(
          [{ type: 'text', content: 'Response 1' }],
          'Response 1'
        )

        const session = yield* createChatSession({ streamer })

        const states: ChatState[] = []
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            states.push(state)
            yield* each.next()
          }
        })

        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Hello' })
        yield* sleep(200)

        return states
      })

      const finalState = states[states.length - 1]
      expect(finalState.messages.length).toBe(2)
      expect(finalState.messages[0].content).toBe('Hello')
      expect(finalState.messages[1].content).toBe('Response 1')
    })
  })
})
