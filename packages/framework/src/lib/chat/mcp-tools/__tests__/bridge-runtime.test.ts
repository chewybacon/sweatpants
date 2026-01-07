/**
 * Bridge Runtime Tests
 *
 * Tests for in-app MCP tool execution with UI elicitation.
 */
import { describe, it, expect } from 'vitest'
import { run, spawn, each, sleep } from 'effection'
import { z } from 'zod'
import {
  createBranchTool,
  createBridgeHost,
  runBridgeTool,
  BranchElicitNotAllowedError,
} from '../index'
import type { BridgeSamplingProvider, BridgeEvent, ElicitResponse, SampleResult } from '../index'

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
      const tool = createBranchTool('simple_tool')
        .description('Simple tool')
        .parameters(z.object({ input: z.string() }))
        .elicits({})
        .execute(function* (params, _ctx) {
          return { result: `Processed: ${params.input}` }
        })

      const samplingProvider = createMockSamplingProvider()

      const result = await run(function* () {
        const host = createBridgeHost({
          tool,
          params: { input: 'test' },
          samplingProvider,
        })

        return yield* host.run()
      })

      expect(result).toEqual({ result: 'Processed: test' })
    })

    it('should emit elicit events and wait for responses', async () => {
      const tool = createBranchTool('elicit_tool')
        .description('Tool with elicitation')
        .parameters(z.object({}))
        .elicits({
          confirm: z.object({ ok: z.boolean() }),
        })
        .execute(function* (_params, ctx) {
          const result = yield* ctx.elicit('confirm', { message: 'Are you sure?' })
          if (result.action === 'accept') {
            return { confirmed: result.content.ok }
          }
          return { confirmed: false }
        })

      const samplingProvider = createMockSamplingProvider()
      const events: BridgeEvent[] = []

      const result = await run(function* () {
        const host = createBridgeHost({
          tool,
          params: {},
          samplingProvider,
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
        expect(elicitEvent.request.message).toBe('Are you sure?')
      }
    })

    it('should handle declined elicitation', async () => {
      const tool = createBranchTool('decline_tool')
        .description('Tool with declined elicitation')
        .parameters(z.object({}))
        .elicits({
          confirm: z.object({ ok: z.boolean() }),
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

      const samplingProvider = createMockSamplingProvider()

      const result = await run(function* () {
        const host = createBridgeHost({
          tool,
          params: {},
          samplingProvider,
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
      const tool = createBranchTool('multi_elicit')
        .description('Tool with multiple elicitations')
        .parameters(z.object({}))
        .elicits({
          first: z.object({ a: z.string() }),
          second: z.object({ b: z.number() }),
        })
        .execute(function* (_params, ctx) {
          const first = yield* ctx.elicit('first', { message: 'First?' })
          if (first.action !== 'accept') return { error: 'first declined' }

          const second = yield* ctx.elicit('second', { message: 'Second?' })
          if (second.action !== 'accept') return { error: 'second declined' }

          return { a: first.content.a, b: second.content.b }
        })

      const samplingProvider = createMockSamplingProvider()
      const elicitKeys: string[] = []

      const result = await run(function* () {
        const host = createBridgeHost({
          tool,
          params: {},
          samplingProvider,
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
      const tool = createBranchTool('validate_tool')
        .description('Tool that validates responses')
        .parameters(z.object({}))
        .elicits({
          pick: z.object({ value: z.number().min(0).max(100) }),
        })
        .execute(function* (_params, ctx) {
          const result = yield* ctx.elicit('pick', { message: 'Pick a number' })
          if (result.action !== 'accept') return { error: 'declined' }
          return { picked: result.content.value }
        })

      const samplingProvider = createMockSamplingProvider()

      // Test with invalid value (string instead of number)
      await expect(
        run(function* () {
          const host = createBridgeHost({
            tool,
            params: {},
            samplingProvider,
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
      const tool = createBranchTool('logging_tool')
        .description('Tool that logs')
        .parameters(z.object({}))
        .elicits({})
        .execute(function* (_params, ctx) {
          yield* ctx.log('info', 'Starting processing')
          yield* ctx.notify('Working...', 0.5)
          yield* ctx.log('debug', 'Done')
          return { done: true }
        })

      const samplingProvider = createMockSamplingProvider()
      const events: BridgeEvent[] = []

      await run(function* () {
        const host = createBridgeHost({
          tool,
          params: {},
          samplingProvider,
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
      const tool = createBranchTool('sample_tool')
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
          samplingProvider,
        })

        yield* spawn(function* () {
          for (const event of yield* each(host.events)) {
            events.push(event)
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
      const tool = createBranchTool('handled_tool')
        .description('Tool with handlers')
        .parameters(z.object({ input: z.string() }))
        .elicits({
          confirm: z.object({ ok: z.boolean() }),
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
              expect(req.message).toBe('Confirm test?')
              return { action: 'accept', content: { ok: true } }
            },
          },
        })
      })

      expect(result).toEqual({ confirmed: true, input: 'test' })
    })

    it('should call onLog and onNotify callbacks', async () => {
      const tool = createBranchTool('callback_tool')
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
      const tool = createBranchTool('nested_elicit')
        .description('Tool that tries to elicit in branch')
        .parameters(z.object({}))
        .elicits({
          confirm: z.object({ ok: z.boolean() }),
        })
        .execute(function* (_params, ctx) {
          // Try to elicit inside a sub-branch - should throw
          const result = yield* ctx.branch(function* (subCtx) {
            // This should throw BranchElicitNotAllowedError
            return yield* subCtx.elicit('confirm', { message: 'Should fail' })
          })
          return { result }
        })

      const samplingProvider = createMockSamplingProvider()

      await expect(
        run(function* () {
          const host = createBridgeHost({
            tool,
            params: {},
            samplingProvider,
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
      const tool = createBranchTool('root_elicit')
        .description('Tool that elicits at root')
        .parameters(z.object({}))
        .elicits({
          confirm: z.object({ ok: z.boolean() }),
        })
        .execute(function* (_params, ctx) {
          // Elicit at root - should work
          const result = yield* ctx.elicit('confirm', { message: 'Should work' })
          return { action: result.action }
        })

      const samplingProvider = createMockSamplingProvider()

      const result = await run(function* () {
        const host = createBridgeHost({
          tool,
          params: {},
          samplingProvider,
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

      const tool = createBranchTool('handoff_tool')
        .description('Tool with handoff')
        .parameters(z.object({ count: z.number() }))
        .elicits({
          adjust: z.object({ delta: z.number() }),
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

      const samplingProvider = createMockSamplingProvider()

      const result = await run(function* () {
        const host = createBridgeHost({
          tool,
          params: { count: 5 },
          samplingProvider,
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
      const tool = createBranchTool('seq_tool')
        .description('Tool with sequential elicits')
        .parameters(z.object({}))
        .elicits({
          a: z.object({ val: z.string() }),
          b: z.object({ val: z.string() }),
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

      const samplingProvider = createMockSamplingProvider()
      const seqNumbers: number[] = []

      await run(function* () {
        const host = createBridgeHost({
          tool,
          params: {},
          samplingProvider,
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
})
