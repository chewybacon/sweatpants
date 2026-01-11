/**
 * Type-Level Tests for MCP Tool Builder
 *
 * Verifies that types flow correctly through the builder chain.
 */
import { describe, it, expectTypeOf } from 'vitest'
import { z } from 'zod'
import {
  createMCPTool,
  type InferMCPResult,
  type InferMCPParams,
  type InferMCPHandoff,
  type InferMCPClient,
} from '../builder.ts'
import type { ElicitResult } from '../types.ts'

describe('MCP Tool Builder Types', () => {
  describe('Simple Execute Tool', () => {
    it('should infer result type from execute return', () => {
      const tool = createMCPTool('calculator')
        .description('Calculate')
        .parameters(z.object({ expression: z.string() }))
        .execute(function*(params) {
          expectTypeOf(params).toEqualTypeOf<{ expression: string }>()
          return { result: 42, input: params.expression }
        })

      type Result = InferMCPResult<typeof tool>
      expectTypeOf<Result>().toEqualTypeOf<{ result: number; input: string }>()

      type Params = InferMCPParams<typeof tool>
      expectTypeOf<Params>().toEqualTypeOf<{ expression: string }>()
    })

    it('should provide MCPClientContext to execute', () => {
      const tool = createMCPTool('with_context')
        .description('Uses context')
        .parameters(z.object({ input: z.string() }))
        .execute(function*(params, ctx) {
          // ctx should have elicit, sample, log, notify
          expectTypeOf(ctx.elicit).toBeFunction()
          expectTypeOf(ctx.sample).toBeFunction()
          expectTypeOf(ctx.log).toBeFunction()
          expectTypeOf(ctx.notify).toBeFunction()
          return { done: true }
        })

      type Result = InferMCPResult<typeof tool>
      expectTypeOf<Result>().toEqualTypeOf<{ done: boolean }>()
    })
  })

  describe('Handoff Tool', () => {
    it('should infer handoff type from before() return', () => {
      const tool = createMCPTool('pick_card')
        .description('Pick a card')
        .parameters(z.object({ count: z.number() }))
        .handoff({
          *before(params) {
            expectTypeOf(params).toEqualTypeOf<{ count: number }>()
            return { cards: ['ace', 'king'] as const, secret: 'ace' }
          },
          *client(handoff, ctx) {
            expectTypeOf(handoff.cards).toEqualTypeOf<readonly ['ace', 'king']>()
            expectTypeOf(handoff.secret).toEqualTypeOf<'ace'>()
            return { picked: 'ace' as const }
          },
          *after(handoff, client) {
            expectTypeOf(handoff.secret).toEqualTypeOf<'ace'>()
            expectTypeOf(client.picked).toEqualTypeOf<'ace'>()
            return { correct: client.picked === handoff.secret }
          },
        })

      type Result = InferMCPResult<typeof tool>
      expectTypeOf<Result>().toEqualTypeOf<{ correct: boolean }>()

      type Handoff = InferMCPHandoff<typeof tool>
      expectTypeOf<Handoff>().toEqualTypeOf<{ cards: readonly ['ace', 'king']; secret: 'ace' }>()

      type Client = InferMCPClient<typeof tool>
      expectTypeOf<Client>().toEqualTypeOf<{ picked: 'ace' }>()
    })

    it('should preserve params type through handoff chain', () => {
      const tool = createMCPTool('booking')
        .description('Book something')
        .parameters(z.object({
          destination: z.string(),
          date: z.string(),
        }))
        .handoff({
          *before(params, ctx) {
            expectTypeOf(params.destination).toBeString()
            expectTypeOf(params.date).toBeString()
            expectTypeOf(ctx.callId).toBeString()
            return { flights: [{ id: 'FL1' }, { id: 'FL2' }] }
          },
          *client(handoff, ctx) {
            expectTypeOf(handoff.flights).toEqualTypeOf<{ id: string }[]>()
            return { selectedId: 'FL1' }
          },
          *after(handoff, client, ctx, params) {
            // params should be available in after()
            expectTypeOf(params.destination).toBeString()
            expectTypeOf(params.date).toBeString()
            return { booked: client.selectedId, to: params.destination }
          },
        })

      type Result = InferMCPResult<typeof tool>
      expectTypeOf<Result>().toEqualTypeOf<{ booked: string; to: string }>()
    })

    it('should type elicit responses correctly', () => {
      const tool = createMCPTool('elicit_test')
        .description('Test elicit typing')
        .parameters(z.object({}))
        .handoff({
          *before() {
            return { options: ['A', 'B', 'C'] }
          },
          *client(handoff, ctx) {
            const result = yield* ctx.elicit({
              message: 'Pick one:',
              schema: z.object({ choice: z.string() }),
            })

            // result should be ElicitResult<{ choice: string }>
            expectTypeOf(result).toEqualTypeOf<ElicitResult<{ choice: string }>>()

            if (result.action === 'accept') {
              expectTypeOf(result.content).toEqualTypeOf<{ choice: string }>()
              return { selected: result.content.choice }
            }
            return { selected: null }
          },
          *after(handoff, client) {
            return { result: client.selected }
          },
        })

      type Result = InferMCPResult<typeof tool>
      expectTypeOf<Result>().toEqualTypeOf<{ result: string | null }>()
    })

    it('should type sample responses correctly', () => {
      const tool = createMCPTool('sample_test')
        .description('Test sample typing')
        .parameters(z.object({ text: z.string() }))
        .handoff({
          *before(params) {
            return { text: params.text }
          },
          *client(handoff, ctx) {
            // Unstructured sample
            const summary = yield* ctx.sample({ prompt: 'Summarize' })
            expectTypeOf(summary).toBeString()

            // Structured sample
            const analysis = yield* ctx.sample({
              prompt: 'Analyze',
              schema: z.object({
                sentiment: z.enum(['positive', 'negative', 'neutral']),
                score: z.number(),
              }),
            })
            expectTypeOf(analysis).toEqualTypeOf<{
              sentiment: 'positive' | 'negative' | 'neutral'
              score: number
            }>()

            return { summary, analysis }
          },
          *after(handoff, client) {
            return client
          },
        })

      type Result = InferMCPResult<typeof tool>
      expectTypeOf<Result>().toEqualTypeOf<{
        summary: string
        analysis: {
          sentiment: 'positive' | 'negative' | 'neutral'
          score: number
        }
      }>()
    })
  })

  describe('Capabilities', () => {
    it('should allow requires() before execute()', () => {
      const tool = createMCPTool('with_requires')
        .description('Requires caps')
        .parameters(z.object({}))
        .requires({ elicitation: true, sampling: true })
        .execute(function*() {
          return { done: true }
        })

      expectTypeOf(tool.requires).toEqualTypeOf<
        { elicitation?: boolean; sampling?: boolean } | undefined
      >()
    })

    it('should allow requires() before handoff()', () => {
      const tool = createMCPTool('with_requires_handoff')
        .description('Requires caps')
        .parameters(z.object({}))
        .requires({ elicitation: true })
        .handoff({
          *before() { return {} },
          *client() { return {} },
          *after() { return { done: true } },
        })

      expectTypeOf(tool.requires).toEqualTypeOf<
        { elicitation?: boolean; sampling?: boolean } | undefined
      >()
    })
  })

  describe('Tool Structure', () => {
    it('should have correct finalized structure', () => {
      const tool = createMCPTool('structured')
        .description('A tool')
        .parameters(z.object({ id: z.number() }))
        .requires({ elicitation: true })
        .handoff({
          *before() { return { data: 123 } },
          *client() { return { ok: true } },
          *after() { return { done: true } },
        })

      expectTypeOf(tool.name).toEqualTypeOf<'structured'>()
      expectTypeOf(tool.description).toBeString()
      expectTypeOf(tool.parameters).toMatchTypeOf<z.ZodType<{ id: number }>>()
      expectTypeOf(tool.handoffConfig).not.toBeUndefined()
    })

    it('should not have handoffConfig for execute tools', () => {
      const tool = createMCPTool('simple')
        .description('Simple')
        .parameters(z.object({}))
        .execute(function*() { return {} })

      expectTypeOf(tool.execute).not.toBeUndefined()
      // handoffConfig should be undefined for execute tools
      expectTypeOf(tool.handoffConfig).toEqualTypeOf<undefined>()
    })
  })
})
