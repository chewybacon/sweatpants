/**
 * Execution Tests for MCP Tools
 *
 * Tests the generator execution flow with mock MCP client.
 */
import { z } from 'zod'
import { describe, it, expect } from '../../isomorphic-tools/__tests__/vitest-effection.ts'
import {
  createMCPTool,
  createMockMCPClient,
  runMCPTool,
  MCPCapabilityError,
} from '../index.ts'

describe('MCP Tool Execution', () => {
  describe('Simple Execute Tools', () => {
    it('should execute a simple tool', function*() {
      const tool = createMCPTool('echo')
        .description('Echo input')
        .parameters(z.object({ message: z.string() }))
        .execute(function*(params) {
          return { echoed: params.message }
        })

      const client = createMockMCPClient()
      const result = yield* runMCPTool(tool, { message: 'hello' }, client)

      expect(result).toEqual({ echoed: 'hello' })
    })

    it('should validate parameters', function*() {
      const tool = createMCPTool('typed')
        .description('Typed params')
        .parameters(z.object({ count: z.number().min(1) }))
        .execute(function*(params) {
          return { doubled: params.count * 2 }
        })

      const client = createMockMCPClient()

      // Valid params
      const result = yield* runMCPTool(tool, { count: 5 }, client)
      expect(result).toEqual({ doubled: 10 })

      // Invalid params should throw
      try {
        yield* runMCPTool(tool, { count: 0 } as any, client)
        expect.fail('Should have thrown')
      } catch (e) {
        expect((e as Error).message).toContain('Invalid params')
      }
    })
  })

  describe('Elicitation', () => {
    it('should handle single elicit call', function*() {
      const tool = createMCPTool('ask')
        .description('Ask user')
        .parameters(z.object({ question: z.string() }))
        .execute(function*(params, ctx) {
          const result = yield* ctx.elicit({
            message: params.question,
            schema: z.object({ answer: z.string() }),
          })

          if (result.action === 'accept') {
            return { answered: true, answer: result.content.answer }
          }
          return { answered: false, answer: null }
        })

      const client = createMockMCPClient({
        elicitResponses: [
          { action: 'accept', content: { answer: 'yes' } },
        ],
      })

      const result = yield* runMCPTool(tool, { question: 'Continue?' }, client)

      expect(result).toEqual({ answered: true, answer: 'yes' })
      expect(client.elicitCalls).toHaveLength(1)
      expect(client.elicitCalls[0].message).toBe('Continue?')
    })

    it('should handle elicit decline', function*() {
      const tool = createMCPTool('confirm')
        .description('Confirm action')
        .parameters(z.object({}))
        .execute(function*(params, ctx) {
          const result = yield* ctx.elicit({
            message: 'Confirm?',
            schema: z.object({ confirmed: z.boolean() }),
          })

          return {
            action: result.action,
            confirmed: result.action === 'accept' ? result.content.confirmed : false,
          }
        })

      const client = createMockMCPClient({
        elicitResponses: [{ action: 'decline' }],
      })

      const result = yield* runMCPTool(tool, {}, client)

      expect(result).toEqual({ action: 'decline', confirmed: false })
    })

    it('should handle elicit cancel', function*() {
      const tool = createMCPTool('modal')
        .description('Show modal')
        .parameters(z.object({}))
        .execute(function*(params, ctx) {
          const result = yield* ctx.elicit({
            message: 'Enter value',
            schema: z.object({ value: z.string() }),
          })

          return { cancelled: result.action === 'cancel' }
        })

      const client = createMockMCPClient({
        elicitResponses: [{ action: 'cancel' }],
      })

      const result = yield* runMCPTool(tool, {}, client)

      expect(result).toEqual({ cancelled: true })
    })

    it('should handle multiple elicit calls', function*() {
      const tool = createMCPTool('wizard')
        .description('Multi-step wizard')
        .parameters(z.object({}))
        .execute(function*(params, ctx) {
          const step1 = yield* ctx.elicit({
            message: 'Step 1: Enter name',
            schema: z.object({ name: z.string() }),
          })

          if (step1.action !== 'accept') {
            return { completed: false, step: 1 }
          }

          const step2 = yield* ctx.elicit({
            message: 'Step 2: Enter email',
            schema: z.object({ email: z.string() }),
          })

          if (step2.action !== 'accept') {
            return { completed: false, step: 2 }
          }

          return {
            completed: true,
            name: step1.content.name,
            email: step2.content.email,
          }
        })

      const client = createMockMCPClient({
        elicitResponses: [
          { action: 'accept', content: { name: 'Alice' } },
          { action: 'accept', content: { email: 'alice@example.com' } },
        ],
      })

      const result = yield* runMCPTool(tool, {}, client)

      expect(result).toEqual({
        completed: true,
        name: 'Alice',
        email: 'alice@example.com',
      })
      expect(client.elicitCalls).toHaveLength(2)
    })
  })

  describe('Sampling', () => {
    it('should handle sample call', function*() {
      const tool = createMCPTool('summarize')
        .description('Summarize text')
        .parameters(z.object({ text: z.string() }))
        .execute(function*(params, ctx) {
          const summary = yield* ctx.sample({
            prompt: `Summarize: ${params.text}`,
            maxTokens: 100,
          })

          return { summary }
        })

      const client = createMockMCPClient({
        sampleResponses: ['This is a summary'],
      })

      const result = yield* runMCPTool(tool, { text: 'Long text...' }, client)

      expect(result).toEqual({ summary: 'This is a summary' })
      expect(client.sampleCalls).toHaveLength(1)
      expect(client.sampleCalls[0].prompt).toContain('Long text...')
    })

    it('should handle structured sample', function*() {
      const tool = createMCPTool('analyze')
        .description('Analyze sentiment')
        .parameters(z.object({ text: z.string() }))
        .execute(function*(params, ctx) {
          const analysis = yield* ctx.sample({
            prompt: `Analyze sentiment: ${params.text}`,
            schema: z.object({
              sentiment: z.enum(['positive', 'negative', 'neutral']),
              confidence: z.number(),
            }),
          })

          return analysis
        })

      const client = createMockMCPClient({
        sampleResponses: [{ sentiment: 'positive', confidence: 0.95 }],
      })

      const result = yield* runMCPTool(tool, { text: 'Great!' }, client)

      expect(result).toEqual({ sentiment: 'positive', confidence: 0.95 })
    })
  })

  describe('Logging and Notifications', () => {
    it('should track log calls', function*() {
      const tool = createMCPTool('logger')
        .description('Logs stuff')
        .parameters(z.object({}))
        .execute(function*(params, ctx) {
          yield* ctx.log('info', 'Starting')
          yield* ctx.log('debug', 'Processing')
          yield* ctx.log('warning', 'Almost done')
          return { done: true }
        })

      const client = createMockMCPClient()
      yield* runMCPTool(tool, {}, client)

      expect(client.logCalls).toEqual([
        { level: 'info', message: 'Starting' },
        { level: 'debug', message: 'Processing' },
        { level: 'warning', message: 'Almost done' },
      ])
    })

    it('should track notify calls', function*() {
      const tool = createMCPTool('progress')
        .description('Shows progress')
        .parameters(z.object({}))
        .execute(function*(params, ctx) {
          yield* ctx.notify('Starting...', 0)
          yield* ctx.notify('Halfway there', 0.5)
          yield* ctx.notify('Done!', 1)
          return { complete: true }
        })

      const client = createMockMCPClient()
      yield* runMCPTool(tool, {}, client)

      expect(client.notifyCalls).toEqual([
        { message: 'Starting...', progress: 0 },
        { message: 'Halfway there', progress: 0.5 },
        { message: 'Done!', progress: 1 },
      ])
    })
  })

  describe('Handoff Pattern', () => {
    it('should execute before/client/after phases', function*() {
      const executionOrder: string[] = []

      const tool = createMCPTool('handoff_test')
        .description('Test handoff')
        .parameters(z.object({ input: z.string() }))
        .handoff({
          *before(params) {
            executionOrder.push('before')
            return { prepared: params.input.toUpperCase() }
          },
          *client(handoff, ctx) {
            executionOrder.push('client')
            const result = yield* ctx.elicit({
              message: `Confirm: ${handoff.prepared}`,
              schema: z.object({ ok: z.boolean() }),
            })
            return { confirmed: result.action === 'accept' && result.content.ok }
          },
          *after(handoff, client) {
            executionOrder.push('after')
            return {
              input: handoff.prepared,
              confirmed: client.confirmed,
            }
          },
        })

      const client = createMockMCPClient({
        elicitResponses: [{ action: 'accept', content: { ok: true } }],
      })

      const result = yield* runMCPTool(tool, { input: 'test' }, client)

      expect(executionOrder).toEqual(['before', 'client', 'after'])
      expect(result).toEqual({ input: 'TEST', confirmed: true })
    })

    it('should pass handoff data to after()', function*() {
      const tool = createMCPTool('data_flow')
        .description('Test data flow')
        .parameters(z.object({ seed: z.number() }))
        .handoff({
          *before(params) {
            // Simulate expensive computation
            return {
              computed: params.seed * 2,
              timestamp: Date.now(),
            }
          },
          *client(handoff) {
            return { sawComputed: handoff.computed }
          },
          *after(handoff, client) {
            return {
              originalComputed: handoff.computed,
              clientSaw: client.sawComputed,
              match: handoff.computed === client.sawComputed,
            }
          },
        })

      const client = createMockMCPClient()
      const result = yield* runMCPTool(tool, { seed: 21 }, client)

      expect(result.originalComputed).toBe(42)
      expect(result.clientSaw).toBe(42)
      expect(result.match).toBe(true)
    })

    it('should pass params to after()', function*() {
      const tool = createMCPTool('params_in_after')
        .description('Params available in after')
        .parameters(z.object({ value: z.string() }))
        .handoff({
          *before() { return { ready: true } },
          *client() { return { done: true } },
          *after(handoff, client, ctx, params) {
            return { originalValue: params.value }
          },
        })

      const client = createMockMCPClient()
      const result = yield* runMCPTool(tool, { value: 'original' }, client)

      expect(result).toEqual({ originalValue: 'original' })
    })
  })

  describe('Capability Checking', () => {
    it('should fail if elicitation required but not supported', function*() {
      const tool = createMCPTool('needs_elicit')
        .description('Needs elicitation')
        .parameters(z.object({}))
        .requires({ elicitation: true })
        .execute(function*(params, ctx) {
          yield* ctx.elicit({ message: 'Hi', schema: z.object({}) })
          return {}
        })

      const client = createMockMCPClient({
        capabilities: { elicitation: false, sampling: true },
      })

      try {
        yield* runMCPTool(tool, {}, client)
        expect.fail('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(MCPCapabilityError)
        expect((e as MCPCapabilityError).capability).toBe('elicitation')
      }
    })

    it('should fail if sampling required but not supported', function*() {
      const tool = createMCPTool('needs_sample')
        .description('Needs sampling')
        .parameters(z.object({}))
        .requires({ sampling: true })
        .execute(function*(params, ctx) {
          yield* ctx.sample({ prompt: 'Hi' })
          return {}
        })

      const client = createMockMCPClient({
        capabilities: { elicitation: true, sampling: false },
      })

      try {
        yield* runMCPTool(tool, {}, client)
        expect.fail('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(MCPCapabilityError)
        expect((e as MCPCapabilityError).capability).toBe('sampling')
      }
    })

    it('should succeed if capabilities match', function*() {
      const tool = createMCPTool('needs_both')
        .description('Needs both')
        .parameters(z.object({}))
        .requires({ elicitation: true, sampling: true })
        .execute(function*() {
          return { ok: true }
        })

      const client = createMockMCPClient({
        capabilities: { elicitation: true, sampling: true },
      })

      const result = yield* runMCPTool(tool, {}, client)
      expect(result).toEqual({ ok: true })
    })
  })

  describe('Mixed Elicit + Sample', () => {
    it('should interleave elicit and sample calls', function*() {
      const tool = createMCPTool('mixed')
        .description('Mixed interaction')
        .parameters(z.object({ topic: z.string() }))
        .execute(function*(params, ctx) {
          // First: ask user for preference
          const pref = yield* ctx.elicit({
            message: 'How detailed?',
            schema: z.object({ detail: z.enum(['brief', 'detailed']) }),
          })

          if (pref.action !== 'accept') {
            return { cancelled: true }
          }

          // Then: generate content based on preference
          const content = yield* ctx.sample({
            prompt: `Write a ${pref.content.detail} explanation of ${params.topic}`,
          })

          // Then: confirm with user
          const confirm = yield* ctx.elicit({
            message: `Generated: "${content.slice(0, 50)}..." - Accept?`,
            schema: z.object({ accept: z.boolean() }),
          })

          return {
            accepted: confirm.action === 'accept' && confirm.content.accept,
            content,
          }
        })

      const client = createMockMCPClient({
        elicitResponses: [
          { action: 'accept', content: { detail: 'brief' } },
          { action: 'accept', content: { accept: true } },
        ],
        sampleResponses: ['This is a brief explanation of quantum physics.'],
      })

      const result = yield* runMCPTool(tool, { topic: 'quantum physics' }, client)

      expect(result).toEqual({
        accepted: true,
        content: 'This is a brief explanation of quantum physics.',
      })

      // Verify order
      expect(client.elicitCalls).toHaveLength(2)
      expect(client.sampleCalls).toHaveLength(1)
      expect(client.elicitCalls[0].message).toBe('How detailed?')
      expect(client.sampleCalls[0].prompt).toContain('brief')
    })
  })
})
