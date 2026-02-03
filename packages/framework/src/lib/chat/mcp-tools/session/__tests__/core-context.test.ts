/**
 * Core-Based MCP Tool Context Tests
 *
 * Tests the context that routes MCP operations through core's transport.
 */
import { describe, it, expect, vi } from 'vitest'
import { run, spawn, sleep, createChannel, type Channel } from 'effection'
import { TransportContext } from '@sweatpants/core'
import type { CorrelatedTransport, ElicitResponse, NotifyResponse, SampleResponse } from '@sweatpants/core'
import { z } from 'zod'
import {
  createContextFromTransport,
  createContextWithElicitsFromTransport,
} from '../core-context.ts'

describe('Core-Based MCP Tool Context', () => {
  /** Union of all possible responses */
  type AnyResponse = ElicitResponse | NotifyResponse | SampleResponse

  /**
   * Create a mock CorrelatedTransport for testing.
   * Returns the transport and a way to respond to requests.
   */
  function createMockCorrelatedTransport() {
    const requests: Array<{
      id: string
      kind: string
      type: string
      payload: unknown
      respond: (response: AnyResponse) => void
    }> = []

    const transport: CorrelatedTransport = {
      request<TProgress, TResponse extends AnyResponse>(message: {
        id: string
        kind: string
        type: string
        payload: unknown
      }) {
        return {
          *[Symbol.iterator]() {
            // Create a channel for the response
            const channel = createChannel<TProgress, TResponse>()

            // Store request with respond callback
            requests.push({
              ...message,
              respond: (response) => {
                // In a real implementation this would use run() but for testing
                // we'll use the channel directly
                run(function* () {
                  yield* (channel as Channel<TProgress, TResponse>).close(response as TResponse)
                })
              },
            })

            // Return subscription
            return yield* channel
          },
        }
      },
    }

    return { transport, requests }
  }

  describe('createContextFromTransport', () => {
    it('should create a context with correct initial state', () => {
      const { transport } = createMockCorrelatedTransport()

      const ctx = createContextFromTransport(transport, {
        toolName: 'test_tool',
        callId: 'call_123',
        parentMessages: [{ role: 'user', content: 'Hello' }],
        parentSystemPrompt: 'You are a helpful assistant',
        depth: 0,
      })

      expect(ctx.parentMessages).toEqual([{ role: 'user', content: 'Hello' }])
      expect(ctx.parentSystemPrompt).toBe('You are a helpful assistant')
      expect(ctx.messages).toEqual([])
      expect(ctx.depth).toBe(0)
    })

    it('should handle sample request with prompt mode', async () => {
      const { transport, requests } = createMockCorrelatedTransport()

      const ctx = createContextFromTransport(transport, {
        toolName: 'test_tool',
        callId: 'call_123',
      })

      const resultPromise = run(function* () {
        return yield* ctx.sample({ prompt: 'Tell me a joke' })
      })

      // Wait for request to be made
      await sleep(10)
      expect(requests.length).toBe(1)
      expect(requests[0].kind).toBe('sample')
      expect(requests[0].type).toBe('sample')
      expect((requests[0].payload as { messages: unknown[] }).messages).toEqual([
        { role: 'user', content: 'Tell me a joke' },
      ])

      // Respond to the request
      requests[0].respond({
        status: 'accepted',
        content: {
          text: 'Why did the chicken cross the road?',
          model: 'test-model',
          stopReason: 'endTurn',
        },
      })

      const result = await resultPromise

      expect(result.text).toBe('Why did the chicken cross the road?')
      expect(result.model).toBe('test-model')
      expect(result.stopReason).toBe('endTurn')
      expect(result.exchange).toBeDefined()
    })

    it('should handle elicit request', async () => {
      const { transport, requests } = createMockCorrelatedTransport()

      const ctx = createContextFromTransport(transport, {
        toolName: 'test_tool',
        callId: 'call_123',
      })

      const resultPromise = run(function* () {
        return yield* ctx.elicit({
          message: 'Pick a number',
          schema: z.object({ number: z.number() }),
        })
      })

      // Wait for request to be made
      await sleep(10)
      expect(requests.length).toBe(1)
      expect(requests[0].kind).toBe('elicit')
      expect(requests[0].type).toBe('elicit')
      expect((requests[0].payload as { message: string }).message).toBe('Pick a number')

      // Respond with acceptance
      requests[0].respond({
        status: 'accepted',
        content: { number: 42 },
      })

      const result = await resultPromise

      expect(result.action).toBe('accept')
      if (result.action === 'accept') {
        expect(result.content).toEqual({ number: 42 })
        expect(result.exchange).toBeDefined()
        expect(result.exchange.messages.length).toBe(2)
      }
    })

    it('should handle elicit decline', async () => {
      const { transport, requests } = createMockCorrelatedTransport()

      const ctx = createContextFromTransport(transport, {
        toolName: 'test_tool',
        callId: 'call_123',
      })

      const resultPromise = run(function* () {
        return yield* ctx.elicit({
          message: 'Confirm action?',
          schema: z.object({ confirmed: z.boolean() }),
        })
      })

      await sleep(10)
      requests[0].respond({ status: 'declined' })

      const result = await resultPromise
      expect(result.action).toBe('decline')
    })

    it('should handle elicit cancel', async () => {
      const { transport, requests } = createMockCorrelatedTransport()

      const ctx = createContextFromTransport(transport, {
        toolName: 'test_tool',
        callId: 'call_123',
      })

      const resultPromise = run(function* () {
        return yield* ctx.elicit({
          message: 'Confirm action?',
          schema: z.object({ confirmed: z.boolean() }),
        })
      })

      await sleep(10)
      requests[0].respond({ status: 'cancelled' })

      const result = await resultPromise
      expect(result.action).toBe('cancel')
    })

    it('should handle log notifications', async () => {
      const { transport, requests } = createMockCorrelatedTransport()

      const ctx = createContextFromTransport(transport, {
        toolName: 'test_tool',
        callId: 'call_123',
      })

      const promise = run(function* () {
        yield* ctx.log('info', 'Test log message')
      })

      await sleep(10)
      expect(requests.length).toBe(1)
      expect(requests[0].kind).toBe('notify')
      expect(requests[0].type).toBe('log')
      expect((requests[0].payload as { level: string; message: string }).level).toBe('info')
      expect((requests[0].payload as { level: string; message: string }).message).toBe('Test log message')

      requests[0].respond({ ok: true })
      await promise
    })

    it('should handle progress notifications', async () => {
      const { transport, requests } = createMockCorrelatedTransport()

      const ctx = createContextFromTransport(transport, {
        toolName: 'test_tool',
        callId: 'call_123',
      })

      const promise = run(function* () {
        yield* ctx.notify('Processing...', 0.5)
      })

      await sleep(10)
      expect(requests.length).toBe(1)
      expect(requests[0].kind).toBe('notify')
      expect(requests[0].type).toBe('progress')
      expect((requests[0].payload as { message: string; progress: number }).message).toBe('Processing...')
      expect((requests[0].payload as { message: string; progress: number }).progress).toBe(0.5)

      requests[0].respond({ ok: true })
      await promise
    })

    it('should create branch context with inherited messages', async () => {
      const { transport, requests } = createMockCorrelatedTransport()

      const ctx = createContextFromTransport(transport, {
        toolName: 'test_tool',
        callId: 'call_123',
        parentMessages: [{ role: 'user', content: 'Parent message' }],
        parentSystemPrompt: 'System prompt',
        depth: 0,
      })

      let branchCtx: typeof ctx | undefined

      const promise = run(function* () {
        yield* ctx.branch(function* (childCtx) {
          branchCtx = childCtx
          // Make a sample request to verify the child context works
          return yield* childCtx.sample({ prompt: 'From branch' })
        })
      })

      await sleep(10)
      expect(requests.length).toBe(1)

      // Respond
      requests[0].respond({
        status: 'accepted',
        content: { text: 'Response', model: 'test' },
      })

      await promise

      expect(branchCtx).toBeDefined()
      expect(branchCtx!.depth).toBe(1)
      expect(branchCtx!.parentMessages).toEqual([{ role: 'user', content: 'Parent message' }])
      expect(branchCtx!.parentSystemPrompt).toBe('System prompt')
    })

    it('should create branch context without inherited messages when inheritMessages is false', async () => {
      const { transport, requests } = createMockCorrelatedTransport()

      const ctx = createContextFromTransport(transport, {
        toolName: 'test_tool',
        callId: 'call_123',
        parentMessages: [{ role: 'user', content: 'Parent message' }],
        depth: 0,
      })

      let branchCtx: typeof ctx | undefined

      const promise = run(function* () {
        yield* ctx.branch(
          function* (childCtx) {
            branchCtx = childCtx
            return yield* childCtx.sample({ prompt: 'From isolated branch' })
          },
          { inheritMessages: false, messages: [{ role: 'assistant', content: 'Fresh start' }] }
        )
      })

      await sleep(10)
      requests[0].respond({
        status: 'accepted',
        content: { text: 'Response', model: 'test' },
      })

      await promise

      expect(branchCtx!.parentMessages).toEqual([{ role: 'assistant', content: 'Fresh start' }])
    })
  })

  describe('createContextWithElicitsFromTransport', () => {
    const elicitsMap = {
      pickOption: {
        response: z.object({ option: z.enum(['a', 'b', 'c']) }),
      },
      confirmWithContext: {
        response: z.object({ confirmed: z.boolean() }),
        context: z.object({ details: z.string() }),
      },
    }

    it('should handle keyed elicitation', async () => {
      const { transport, requests } = createMockCorrelatedTransport()

      const ctx = createContextWithElicitsFromTransport(transport, {
        toolName: 'test_tool',
        callId: 'call_123',
      }, elicitsMap)

      const resultPromise = run(function* () {
        return yield* ctx.elicit('pickOption', { message: 'Pick an option' })
      })

      await sleep(10)
      expect(requests.length).toBe(1)
      expect((requests[0].payload as { key: string }).key).toBe('pickOption')

      requests[0].respond({
        status: 'accepted',
        content: { option: 'b' },
      })

      const result = await resultPromise

      expect(result.action).toBe('accept')
      if (result.action === 'accept') {
        expect(result.content).toEqual({ option: 'b' })
      }
    })

    it('should handle keyed elicitation with context', async () => {
      const { transport, requests } = createMockCorrelatedTransport()

      const ctx = createContextWithElicitsFromTransport(transport, {
        toolName: 'test_tool',
        callId: 'call_123',
      }, elicitsMap)

      const resultPromise = run(function* () {
        return yield* ctx.elicit('confirmWithContext', {
          message: 'Please confirm',
          details: 'This is important context',
        })
      })

      await sleep(10)
      expect(requests.length).toBe(1)
      expect((requests[0].payload as { key: string }).key).toBe('confirmWithContext')
      expect((requests[0].payload as { context: unknown }).context).toEqual({
        details: 'This is important context',
      })

      requests[0].respond({
        status: 'accepted',
        content: { confirmed: true },
      })

      const result = await resultPromise

      expect(result.action).toBe('accept')
      if (result.action === 'accept') {
        expect(result.content).toEqual({ confirmed: true })
        // The exchange should have the context
        expect(result.exchange.context).toEqual({
          details: 'This is important context',
        })
      }
    })

    it('should preserve keyed elicitation in branch', async () => {
      const { transport, requests } = createMockCorrelatedTransport()

      const ctx = createContextWithElicitsFromTransport(transport, {
        toolName: 'test_tool',
        callId: 'call_123',
      }, elicitsMap)

      const resultPromise = run(function* () {
        return yield* ctx.branch(function* (childCtx) {
          return yield* childCtx.elicit('pickOption', { message: 'Pick in branch' })
        })
      })

      await sleep(10)
      expect(requests.length).toBe(1)
      expect((requests[0].payload as { key: string }).key).toBe('pickOption')

      requests[0].respond({
        status: 'accepted',
        content: { option: 'c' },
      })

      const result = await resultPromise

      expect(result.action).toBe('accept')
      if (result.action === 'accept') {
        expect(result.content).toEqual({ option: 'c' })
      }
    })

    it('should throw for unknown elicit key', async () => {
      const { transport } = createMockCorrelatedTransport()

      const ctx = createContextWithElicitsFromTransport(transport, {
        toolName: 'test_tool',
        callId: 'call_123',
      }, elicitsMap)

      await expect(
        run(function* () {
          // @ts-expect-error - Testing runtime error for unknown key
          return yield* ctx.elicit('unknownKey', { message: 'Test' })
        })
      ).rejects.toThrow('Unknown elicit key: unknownKey')
    })
  })

  describe('Exchange construction', () => {
    it('should create proper MCP exchange for accepted elicitation', async () => {
      const { transport, requests } = createMockCorrelatedTransport()

      const ctx = createContextFromTransport(transport, {
        toolName: 'test_tool',
        callId: 'call_123',
      })

      const resultPromise = run(function* () {
        return yield* ctx.elicit({
          message: 'Pick a number',
          schema: z.object({ number: z.number() }),
        })
      })

      await sleep(10)
      requests[0].respond({
        status: 'accepted',
        content: { number: 42 },
      })

      const result = await resultPromise

      expect(result.action).toBe('accept')
      if (result.action === 'accept') {
        const [request, response] = result.exchange.messages
        const requestContent = Array.isArray(request.content) ? request.content : [request.content]
        const responseContent = Array.isArray(response.content) ? response.content : [response.content]

        // Request should be assistant with tool_use
        expect(request.role).toBe('assistant')
        expect(requestContent[0].type).toBe('tool_use')

        // Response should be user with tool_result
        expect(response.role).toBe('user')
        expect(responseContent[0].type).toBe('tool_result')
        const toolResult = responseContent[0] as { content: Array<{ text: string }> }
        expect(JSON.parse(toolResult.content[0].text)).toEqual({ number: 42 })
      }
    })

    it('should support withArguments for exchange customization', async () => {
      const { transport, requests } = createMockCorrelatedTransport()

      const elicitsMap = {
        pickFlight: {
          response: z.object({ flightId: z.string() }),
          context: z.object({ destination: z.string(), date: z.string() }),
        },
      }

      const ctx = createContextWithElicitsFromTransport(transport, {
        toolName: 'book_flight',
        callId: 'call_123',
      }, elicitsMap)

      const resultPromise = run(function* () {
        return yield* ctx.elicit('pickFlight', {
          message: 'Pick your flight',
          destination: 'NYC',
          date: '2024-03-15',
        })
      })

      await sleep(10)
      requests[0].respond({
        status: 'accepted',
        content: { flightId: 'FL123' },
      })

      const result = await resultPromise

      if (result.action === 'accept') {
        const defaultContent = Array.isArray(result.exchange.messages[0].content)
          ? result.exchange.messages[0].content
          : [result.exchange.messages[0].content]

        // Default messages have empty input (safe default)
        expect(defaultContent[0]).toMatchObject({
          type: 'tool_use',
          input: {},
        })

        // withArguments allows deriving arguments from context
        const customMessages = result.exchange.withArguments((ctx) => ({
          destination: ctx.destination,
          date: ctx.date,
        }))

        const customContent = Array.isArray(customMessages[0].content)
          ? customMessages[0].content
          : [customMessages[0].content]

        expect(customContent[0]).toMatchObject({
          type: 'tool_use',
          input: { destination: 'NYC', date: '2024-03-15' },
        })
      }
    })
  })
})
