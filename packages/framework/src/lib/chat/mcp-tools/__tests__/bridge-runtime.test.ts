/**
 * Bridge Runtime Tests
 *
 * Tests for in-app MCP tool execution with UI elicitation.
 */
import { describe, it, expect } from 'vitest'
import { run, spawn, each, sleep } from 'effection'
import { z } from 'zod'
import {
  createMcpTool,
  createBridgeHost,
  runBridgeTool,
  BranchElicitNotAllowedError,
} from '../index.ts'
import type { BridgeSamplingProvider, BridgeEvent, ElicitResponse, SampleResult, RawElicitResult } from '../index.ts'

// Mock sampling provider
function createMockSamplingProvider(responses: string[] = []): BridgeSamplingProvider & { calls: Array<{ messages: unknown[]; options?: unknown }> } {
  let callIndex = 0
  const calls: Array<{ messages: unknown[]; options?: unknown }> = []

  return {
    calls,
    sample(_messages, options) {
      return {
        *[Symbol.iterator]() {
          calls.push({ messages: _messages, options })
          const text = responses[callIndex++] ?? `Response ${callIndex}`
          return { text } as SampleResult
        },
      }
    },
  }
}

describe('Bridge Runtime', () => {
  describe('createBridgeHost', () => {
    it('should run a simple tool without elicitation', async () => {
      const tool = createMcpTool('simple_tool')
        .description('Simple tool')
        .parameters(z.object({ input: z.string() }))
        .elicits({})
        .execute(function* (params, _ctx) {
          return { result: `Processed: ${params.input}` }
        })

      const result = await run(function* () {
        const host = createBridgeHost({
          tool,
          params: { input: 'test' },
        })

        return yield* host.run()
      })

      expect(result).toEqual({ result: 'Processed: test' })
    })

    it('should emit elicit events and wait for responses', async () => {
      const tool = createMcpTool('elicit_tool')
        .description('Tool with elicitation')
        .parameters(z.object({}))
        .elicits({
          confirm: { response: z.object({ ok: z.boolean() }) },
        })
        .execute(function* (_params, ctx) {
          const result = yield* ctx.elicit('confirm', { message: 'Are you sure?' })
          if (result.action === 'accept') {
            return { confirmed: result.content.ok }
          }
          return { confirmed: false }
        })

      const events: BridgeEvent[] = []

      const result = await run(function* () {
        const host = createBridgeHost({
          tool,
          params: {},
        })

        // Spawn event handler FIRST
        yield* spawn(function* () {
          for (const event of yield* each(host.events)) {
            events.push(event)
            if (event.type === 'elicit') {
              // Respond to elicitation
              const response: ElicitResponse = {
                id: event.request.id,
                result: { action: 'accept', content: { ok: true } },
              }
              event.responseSignal.send(response)
            }
            yield* each.next()
          }
        })

        // Let the event handler start subscribing
        yield* sleep(0)

        return yield* host.run()
      })

      expect(result).toEqual({ confirmed: true })
      expect(events).toHaveLength(1)
      const elicitEvent = events[0]
      expect(elicitEvent).toBeDefined()
      expect(elicitEvent!.type).toBe('elicit')
      if (elicitEvent && elicitEvent.type === 'elicit') {
        expect(elicitEvent.request.key).toBe('confirm')
        // Message includes x-elicit-context boundary encoding for context transport
        expect(elicitEvent.request.message).toContain('Are you sure?')
      }
    })

    it('should handle declined elicitation', async () => {
      const tool = createMcpTool('decline_tool')
        .description('Tool with declined elicitation')
        .parameters(z.object({}))
        .elicits({
          confirm: { response: z.object({ ok: z.boolean() }) },
        })
        .execute(function* (_params, ctx) {
          const result = yield* ctx.elicit('confirm', { message: 'Proceed?' })
          if (result.action === 'accept') {
            return { status: 'accepted', value: result.content.ok }
          } else if (result.action === 'decline') {
            return { status: 'declined' }
          } else {
            return { status: 'cancelled' }
          }
        })

      const result = await run(function* () {
        const host = createBridgeHost({
          tool,
          params: {},
        })

        yield* spawn(function* () {
          for (const event of yield* each(host.events)) {
            if (event.type === 'elicit') {
              event.responseSignal.send({
                id: event.request.id,
                result: { action: 'decline' },
              })
            }
            yield* each.next()
          }
        })

        yield* sleep(0)
        return yield* host.run()
      })

      expect(result).toEqual({ status: 'declined' })
    })

    it('should handle multiple elicitations in sequence', async () => {
      const tool = createMcpTool('multi_elicit')
        .description('Tool with multiple elicitations')
        .parameters(z.object({}))
        .elicits({
          first: { response: z.object({ a: z.string() }) },
          second: { response: z.object({ b: z.number() }) },
        })
        .execute(function* (_params, ctx) {
          const first = yield* ctx.elicit('first', { message: 'First?' })
          if (first.action !== 'accept') return { error: 'first declined' }

          const second = yield* ctx.elicit('second', { message: 'Second?' })
          if (second.action !== 'accept') return { error: 'second declined' }

          return { a: first.content.a, b: second.content.b }
        })

      const elicitKeys: string[] = []

      const result = await run(function* () {
        const host = createBridgeHost({
          tool,
          params: {},
        })

        yield* spawn(function* () {
          for (const event of yield* each(host.events)) {
            if (event.type === 'elicit') {
              elicitKeys.push(event.request.key)
              if (event.request.key === 'first') {
                event.responseSignal.send({
                  id: event.request.id,
                  result: { action: 'accept', content: { a: 'hello' } },
                })
              } else if (event.request.key === 'second') {
                event.responseSignal.send({
                  id: event.request.id,
                  result: { action: 'accept', content: { b: 42 } },
                })
              }
            }
            yield* each.next()
          }
        })

        yield* sleep(0)
        return yield* host.run()
      })

      expect(result).toEqual({ a: 'hello', b: 42 })
      expect(elicitKeys).toEqual(['first', 'second'])
    })

    it('should validate elicit responses with Zod', async () => {
      const tool = createMcpTool('validate_tool')
        .description('Tool that validates responses')
        .parameters(z.object({}))
        .elicits({
          pick: { response: z.object({ value: z.number().min(0).max(100) }) },
        })
        .execute(function* (_params, ctx) {
          const result = yield* ctx.elicit('pick', { message: 'Pick a number' })
          if (result.action !== 'accept') return { error: 'declined' }
          return { picked: result.content.value }
        })

      // Test with invalid value (string instead of number)
      await expect(
        run(function* () {
          const host = createBridgeHost({
            tool,
            params: {},
          })

          yield* spawn(function* () {
            for (const event of yield* each(host.events)) {
              if (event.type === 'elicit') {
                event.responseSignal.send({
                  id: event.request.id,
                  result: { action: 'accept', content: { value: 'not a number' as unknown as number } },
                })
              }
              yield* each.next()
            }
          })

          yield* sleep(0)
          return yield* host.run()
        })
      ).rejects.toThrow(/validation failed/)
    })

    it('should emit log and notify events', async () => {
      const tool = createMcpTool('logging_tool')
        .description('Tool that logs')
        .parameters(z.object({}))
        .elicits({})
        .execute(function* (_params, ctx) {
          yield* ctx.log('info', 'Starting processing')
          yield* ctx.notify('Working...', 0.5)
          yield* ctx.log('debug', 'Done')
          return { done: true }
        })

      const events: BridgeEvent[] = []

      await run(function* () {
        const host = createBridgeHost({
          tool,
          params: {},
        })

        yield* spawn(function* () {
          for (const event of yield* each(host.events)) {
            events.push(event)
            yield* each.next()
          }
        })

        yield* sleep(0)
        const result = yield* host.run()
        // Give subscriber time to process remaining events before assertions
        yield* sleep(0)
        return result
      })

      const logEvents = events.filter(e => e.type === 'log')
      const notifyEvents = events.filter(e => e.type === 'notify')

      expect(logEvents).toHaveLength(2)
      expect(notifyEvents).toHaveLength(1)

      const firstLog = logEvents[0]
      expect(firstLog).toBeDefined()
      if (firstLog && firstLog.type === 'log') {
        expect(firstLog.level).toBe('info')
        expect(firstLog.message).toBe('Starting processing')
      }

      const firstNotify = notifyEvents[0]
      expect(firstNotify).toBeDefined()
      if (firstNotify && firstNotify.type === 'notify') {
        expect(firstNotify.message).toBe('Working...')
        expect(firstNotify.progress).toBe(0.5)
      }
    })

    it('should emit sample events for observability', async () => {
      const tool = createMcpTool('sample_tool')
        .description('Tool that samples')
        .parameters(z.object({}))
        .elicits({})
        .execute(function* (_params, ctx) {
          const result = yield* ctx.sample({ prompt: 'Generate something' })
          return { generated: result.text }
        })

      const samplingProvider = createMockSamplingProvider(['Generated content'])
      const events: BridgeEvent[] = []

      const result = await run(function* () {
        const host = createBridgeHost({
          tool,
          params: {},
        })

        yield* spawn(function* () {
          for (const event of yield* each(host.events)) {
            events.push(event)
            // Handle sample events by calling the provider
            if (event.type === 'sample') {
              const sampleResult = yield* samplingProvider.sample(event.messages, event.options)
              event.responseSignal.send({ result: sampleResult })
            }
            yield* each.next()
          }
        })

        yield* sleep(0)
        const result = yield* host.run()
        yield* sleep(0)
        return result
      })

      expect(result).toEqual({ generated: 'Generated content' })

      const sampleEvents = events.filter(e => e.type === 'sample')
      expect(sampleEvents).toHaveLength(1)
    })
  })

  describe('runBridgeTool', () => {
    it('should run a tool with handlers', async () => {
      const tool = createMcpTool('handled_tool')
        .description('Tool with handlers')
        .parameters(z.object({ input: z.string() }))
        .elicits({
          confirm: { response: z.object({ ok: z.boolean() }) },
        })
        .execute(function* (params, ctx) {
          const result = yield* ctx.elicit('confirm', { message: `Confirm ${params.input}?` })
          if (result.action === 'accept' && result.content.ok) {
            return { confirmed: true, input: params.input }
          }
          return { confirmed: false, input: params.input }
        })

      const samplingProvider = createMockSamplingProvider()

      const result = await run(function* () {
        return yield* runBridgeTool({
          tool,
          params: { input: 'test' },
          samplingProvider,
          handlers: {
            confirm: function* (req) {
              // Message includes x-elicit-context boundary encoding for context transport
              expect(req.message).toContain('Confirm test?')
              return { action: 'accept', content: { ok: true } }
            },
          },
        })
      })

      expect(result).toEqual({ confirmed: true, input: 'test' })
    })

    it('should call onLog and onNotify callbacks', async () => {
      const tool = createMcpTool('callback_tool')
        .description('Tool with callbacks')
        .parameters(z.object({}))
        .elicits({})
        .execute(function* (_params, ctx) {
          yield* ctx.log('info', 'Log message')
          yield* ctx.notify('Notify message', 0.75)
          return { done: true }
        })

      const samplingProvider = createMockSamplingProvider()
      const logs: Array<{ level: string; message: string }> = []
      const notifies: Array<{ message: string; progress?: number }> = []

      await run(function* () {
        return yield* runBridgeTool({
          tool,
          params: {},
          samplingProvider,
          handlers: {},
          onLog: (level, message) => logs.push({ level, message }),
          onNotify: (message, progress) => {
            const entry: { message: string; progress?: number } = { message }
            if (progress !== undefined) {
              entry.progress = progress
            }
            notifies.push(entry)
          },
        })
      })

      expect(logs).toEqual([{ level: 'info', message: 'Log message' }])
      expect(notifies).toEqual([{ message: 'Notify message', progress: 0.75 }])
    })
  })

  describe('Phase 5: Branching constraints', () => {
    it('should throw BranchElicitNotAllowedError when elicit called in sub-branch', async () => {
      const tool = createMcpTool('nested_elicit')
        .description('Tool that tries to elicit in branch')
        .parameters(z.object({}))
        .elicits({
          confirm: { response: z.object({ ok: z.boolean() }) },
        })
        .execute(function* (_params, ctx) {
          // Try to elicit inside a sub-branch - should throw
          const result = yield* ctx.branch(function* (subCtx) {
            // This should throw BranchElicitNotAllowedError
            return yield* subCtx.elicit('confirm', { message: 'Should fail' })
          })
          return { result }
        })

      await expect(
        run(function* () {
          const host = createBridgeHost({
            tool,
            params: {},
          })

          // Spawn handler (won't be called since we expect an error)
          yield* spawn(function* () {
            for (const event of yield* each(host.events)) {
              if (event.type === 'elicit') {
                event.responseSignal.send({
                  id: event.request.id,
                  result: { action: 'accept', content: { ok: true } },
                })
              }
              yield* each.next()
            }
          })

          yield* sleep(0)
          return yield* host.run()
        })
      ).rejects.toThrow(BranchElicitNotAllowedError)
    })

    it('should allow elicit at root level (depth 0)', async () => {
      const tool = createMcpTool('root_elicit')
        .description('Tool that elicits at root')
        .parameters(z.object({}))
        .elicits({
          confirm: { response: z.object({ ok: z.boolean() }) },
        })
        .execute(function* (_params, ctx) {
          // Elicit at root - should work
          const result = yield* ctx.elicit('confirm', { message: 'Should work' })
          return { action: result.action }
        })

      const result = await run(function* () {
        const host = createBridgeHost({
          tool,
          params: {},
        })

        yield* spawn(function* () {
          for (const event of yield* each(host.events)) {
            if (event.type === 'elicit') {
              event.responseSignal.send({
                id: event.request.id,
                result: { action: 'accept', content: { ok: true } },
              })
            }
            yield* each.next()
          }
        })

        yield* sleep(0)
        return yield* host.run()
      })

      expect(result).toEqual({ action: 'accept' })
    })
  })

  describe('handoff pattern', () => {
    it('should execute before/client/after phases correctly', async () => {
      const phases: string[] = []

      const tool = createMcpTool('handoff_tool')
        .description('Tool with handoff')
        .parameters(z.object({ count: z.number() }))
        .elicits({
          adjust: { response: z.object({ delta: z.number() }) },
        })
        .handoff({
          *before(params, _ctx) {
            phases.push('before')
            return { doubled: params.count * 2 }
          },
          *client(handoff, ctx) {
            phases.push('client')
            const adjustment = yield* ctx.elicit('adjust', {
              message: `Current value: ${handoff.doubled}. Adjust?`,
            })
            if (adjustment.action !== 'accept') {
              return { final: handoff.doubled }
            }
            return { final: handoff.doubled + adjustment.content.delta }
          },
          *after(handoff, client, _ctx, params) {
            phases.push('after')
            return {
              original: params.count,
              doubled: handoff.doubled,
              final: client.final,
            }
          },
        })

      const result = await run(function* () {
        const host = createBridgeHost({
          tool,
          params: { count: 5 },
        })

        yield* spawn(function* () {
          for (const event of yield* each(host.events)) {
            if (event.type === 'elicit') {
              event.responseSignal.send({
                id: event.request.id,
                result: { action: 'accept', content: { delta: 3 } },
              })
            }
            yield* each.next()
          }
        })

        yield* sleep(0)
        return yield* host.run()
      })

      expect(phases).toEqual(['before', 'client', 'after'])
      expect(result).toEqual({
        original: 5,
        doubled: 10,
        final: 13,
      })
    })
  })

  describe('elicit sequence tracking', () => {
    it('should assign sequential IDs to elicit requests', async () => {
      const tool = createMcpTool('seq_tool')
        .description('Tool with sequential elicits')
        .parameters(z.object({}))
        .elicits({
          a: { response: z.object({ val: z.string() }) },
          b: { response: z.object({ val: z.string() }) },
        })
        .execute(function* (_params, ctx) {
          const first = yield* ctx.elicit('a', { message: 'First' })
          const second = yield* ctx.elicit('b', { message: 'Second' })
          const third = yield* ctx.elicit('a', { message: 'Third' })
          return {
            first: first.action === 'accept' ? first.content.val : null,
            second: second.action === 'accept' ? second.content.val : null,
            third: third.action === 'accept' ? third.content.val : null,
          }
        })

      const seqNumbers: number[] = []

      await run(function* () {
        const host = createBridgeHost({
          tool,
          params: {},
          callId: 'test-call-123',
        })

        yield* spawn(function* () {
          for (const event of yield* each(host.events)) {
            if (event.type === 'elicit') {
              seqNumbers.push(event.request.seq)
              expect(event.request.callId).toBe('test-call-123')
              event.responseSignal.send({
                id: event.request.id,
                result: { action: 'accept', content: { val: `response-${event.request.seq}` } },
              })
            }
            yield* each.next()
          }
        })

        yield* sleep(0)
        return yield* host.run()
      })

      expect(seqNumbers).toEqual([0, 1, 2])
    })
  })

  describe('exchange accumulation', () => {
    it('should include exchange on accepted elicit result', async () => {
      const tool = createMcpTool('exchange_tool')
        .description('Tool that captures exchange')
        .parameters(z.object({}))
        .elicits({
          pick: { 
            context: z.object({ options: z.array(z.string()) }),
            response: z.object({ selected: z.string() }),
          },
        })
        .execute(function* (_params, ctx) {
          const result = yield* ctx.elicit('pick', {
            message: 'Pick an option',
            options: ['A', 'B', 'C'],  // context spread directly
          })
          
          if (result.action === 'accept') {
            // Verify exchange exists and has correct structure (MCP format)
            expect(result.exchange).toBeDefined()
            expect(result.exchange.context).toEqual({ options: ['A', 'B', 'C'] })
            expect(result.exchange.request).toBeDefined()
            expect(result.exchange.request.role).toBe('assistant')
            // MCP format: content has text block and tool_use block
            const requestContent = result.exchange.request.content as unknown[]
            expect(Array.isArray(requestContent)).toBe(true)
            expect(requestContent.length).toBe(2)
            expect(requestContent[0]).toMatchObject({ type: 'text' })
            expect(requestContent[1]).toMatchObject({ type: 'tool_use' })
            expect(result.exchange.response).toBeDefined()
            expect(result.exchange.response.role).toBe('user')
            // MCP format: response is user role with tool_result
            const responseContent = result.exchange.response.content
            expect(Array.isArray(responseContent)).toBe(true)
            expect((responseContent as unknown[])[0]).toMatchObject({ type: 'tool_result' })
            expect(result.exchange.messages).toHaveLength(2)
            
            return { selected: result.content.selected, hasExchange: true }
          }
          return { selected: null, hasExchange: false }
        })

      const result = await run(function* () {
        const host = createBridgeHost({
          tool,
          params: {},
        })

        yield* spawn(function* () {
          for (const event of yield* each(host.events)) {
            if (event.type === 'elicit') {
              event.responseSignal.send({
                id: event.request.id,
                result: { action: 'accept', content: { selected: 'B' } },
              })
            }
            yield* each.next()
          }
        })

        yield* sleep(0)
        return yield* host.run()
      })

      expect(result).toEqual({ selected: 'B', hasExchange: true })
    })

    it('should allow withArguments to customize tool call arguments', async () => {
      const tool = createMcpTool('with_args_tool')
        .description('Tool that uses withArguments')
        .parameters(z.object({}))
        .elicits({
          position: {
            context: z.object({ board: z.array(z.string()), turn: z.number() }),
            response: z.object({ row: z.number(), col: z.number() }),
          },
        })
        .execute(function* (_params, ctx) {
          const result = yield* ctx.elicit('position', {
            message: 'Select a position',
            board: ['X', '', 'O', '', '', '', '', '', ''],  // context spread
            turn: 3,
          })
          
          if (result.action === 'accept') {
            // Use withArguments to create enriched messages
            const messages = result.exchange.withArguments((context) => ({
              boardState: context.board.join(','),
              turnNumber: context.turn,
              userChoice: `row=${result.content.row},col=${result.content.col}`,
            }))
            
            expect(messages).toHaveLength(2)
            const [requestMsg, responseMsg] = messages
            
            // Request message should have the custom arguments (MCP format)
            // Content has 2 blocks: [text, tool_use]
            expect(requestMsg.role).toBe('assistant')
            const requestContent = requestMsg.content as unknown[]
            expect(requestContent).toHaveLength(2)
            expect(requestContent[0]).toMatchObject({ type: 'text' })
            expect(requestContent[1]).toMatchObject({
              type: 'tool_use',
              input: {
                boardState: 'X,,O,,,,,,',
                turnNumber: 3,
                userChoice: 'row=1,col=1',
              },
            })
            
            // Response message should be user role with tool_result (MCP format)
            expect(responseMsg.role).toBe('user')
            const responseContent = responseMsg.content as unknown[]
            expect(responseContent[0]).toMatchObject({ type: 'tool_result' })
            
            return { row: result.content.row, col: result.content.col, messagesGenerated: true }
          }
          return { row: -1, col: -1, messagesGenerated: false }
        })

      const result = await run(function* () {
        const host = createBridgeHost({
          tool,
          params: {},
        })

        yield* spawn(function* () {
          for (const event of yield* each(host.events)) {
            if (event.type === 'elicit') {
              event.responseSignal.send({
                id: event.request.id,
                result: { action: 'accept', content: { row: 1, col: 1 } },
              })
            }
            yield* each.next()
          }
        })

        yield* sleep(0)
        return yield* host.run()
      })

      expect(result).toEqual({ row: 1, col: 1, messagesGenerated: true })
    })

    it('should pass extended messages to sample when using messages mode', async () => {
      const tool = createMcpTool('accumulate_tool')
        .description('Tool that accumulates history')
        .parameters(z.object({}))
        .elicits({
          choice: {
            context: z.object({ step: z.number() }),
            response: z.object({ value: z.string() }),
          },
        })
        .execute(function* (_params, ctx) {
          // First elicit
          const first = yield* ctx.elicit('choice', {
            message: 'Make first choice',
            step: 1,  // context spread
          })
          
          if (first.action !== 'accept') return { error: 'first declined' }
          
          // Capture the exchange messages
          const history = first.exchange.withArguments((c) => ({
            stepNumber: c.step,
            userValue: first.content.value,
          }))
          
          // Second elicit
          const second = yield* ctx.elicit('choice', {
            message: 'Make second choice',
            step: 2,  // context spread
          })
          
          if (second.action !== 'accept') return { error: 'second declined' }
          
          // Add second exchange to history
          const history2 = second.exchange.withArguments((c) => ({
            stepNumber: c.step,
            userValue: second.content.value,
          }))
          
          // Now sample with accumulated history
          const allHistory = [...history, ...history2]
          const sampleResult = yield* ctx.sample({
            messages: [
              ...allHistory,
              { role: 'user', content: 'Summarize the choices made' },
            ],
          })
          
          return {
            choices: [first.content.value, second.content.value],
            summary: sampleResult.text,
            historyLength: allHistory.length,
          }
        })

      const samplingProvider = createMockSamplingProvider(['User chose alpha then beta'])
      let capturedMessages: unknown[] = []
      let elicitCount = 0

      const result = await run(function* () {
        const host = createBridgeHost({
          tool,
          params: {},
        })

        yield* spawn(function* () {
          for (const event of yield* each(host.events)) {
            if (event.type === 'elicit') {
              elicitCount++
              event.responseSignal.send({
                id: event.request.id,
                result: { action: 'accept', content: { value: elicitCount === 1 ? 'alpha' : 'beta' } },
              })
            } else if (event.type === 'sample') {
              capturedMessages = [...event.messages]
              const sampleResult = yield* samplingProvider.sample(event.messages, event.options)
              event.responseSignal.send({ result: sampleResult })
            }
            yield* each.next()
          }
        })

        yield* sleep(0)
        return yield* host.run()
      })

      expect(result.choices).toEqual(['alpha', 'beta'])
      expect(result.summary).toBe('User chose alpha then beta')
      expect(result.historyLength).toBe(4) // 2 exchanges * 2 messages each
      
      // Verify the sample received extended messages with tool_use content blocks (MCP format)
      expect(capturedMessages.length).toBe(5) // 4 history + 1 user prompt
      const assistantMsgs = capturedMessages.filter((m: any) => m.role === 'assistant')
      expect(assistantMsgs.length).toBe(2)
      assistantMsgs.forEach((msg: any) => {
        // MCP format uses content array with tool_use blocks, not tool_calls
        const toolUseBlocks = (msg.content as any[]).filter((b: any) => b.type === 'tool_use')
        expect(toolUseBlocks.length).toBe(1)
      })
    })

    it('should not include exchange on declined elicit result', async () => {
      const tool = createMcpTool('no_exchange_tool')
        .description('Tool where elicit is declined')
        .parameters(z.object({}))
        .elicits({
          confirm: { response: z.object({ ok: z.boolean() }) },
        })
        .execute(function* (_params, ctx) {
          const result = yield* ctx.elicit('confirm', { message: 'Proceed?' })
          
          if (result.action === 'decline') {
            // Declined results should not have exchange property
            expect((result as any).exchange).toBeUndefined()
            return { declined: true }
          }
          return { declined: false }
        })

      const result = await run(function* () {
        const host = createBridgeHost({
          tool,
          params: {},
        })

        yield* spawn(function* () {
          for (const event of yield* each(host.events)) {
            if (event.type === 'elicit') {
              event.responseSignal.send({
                id: event.request.id,
                result: { action: 'decline' },
              })
            }
            yield* each.next()
          }
        })

        yield* sleep(0)
        return yield* host.run()
      })

      expect(result).toEqual({ declined: true })
    })
  })
})
