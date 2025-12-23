/**
 * Type-Level Tests for Isomorphic Tool Builder
 *
 * These tests verify that types flow correctly through the builder chain.
 * Uses vitest's expectTypeOf for compile-time type assertions.
 */
import { describe, it, expectTypeOf } from 'vitest'
import { z } from 'zod'
import {
  createIsomorphicTool,
  type InferToolResult,
  type InferToolParams,
  type InferToolHandoff,
  type InferToolClientOutput,
} from '../builder'

describe('Isomorphic Tool Builder Types', () => {
  describe('Server Authority with Handoff', () => {
    it('should infer handoff type from before() return', () => {
      const tool = createIsomorphicTool('test')
        .description('Test tool')
        .parameters(z.object({ prompt: z.string() }))
        .authority('server')
        .handoff({
          *before(params) {
            // params should be { prompt: string }
            expectTypeOf(params).toEqualTypeOf<{ prompt: string }>()
            return { secret: 'ace', choices: ['ace', 'king'] as const }
          },
          *client(handoff, _ctx, _params) {
            // handoff should be { secret: string, choices: readonly ['ace', 'king'] }
            expectTypeOf(handoff.secret).toBeString()
            expectTypeOf(handoff.choices).toEqualTypeOf<readonly ['ace', 'king']>()
            return { guess: 'ace' as const }
          },
          *after(handoff, client) {
            // handoff should be same as before() return
            expectTypeOf(handoff.secret).toBeString()
            // client should be { guess: 'ace' }
            expectTypeOf(client.guess).toEqualTypeOf<'ace'>()
            return { correct: client.guess === handoff.secret }
          },
        })

      // Final result type should be { correct: boolean }
      type Result = InferToolResult<typeof tool>
      expectTypeOf<Result>().toEqualTypeOf<{ correct: boolean }>()
    })

    it('should preserve params type through handoff chain', () => {
      const paramsSchema = z.object({
        difficulty: z.enum(['easy', 'hard']),
        numChoices: z.number(),
      })

      const tool = createIsomorphicTool('card_game')
        .description('Card game')
        .parameters(paramsSchema)
        .authority('server')
        .handoff({
          *before(params) {
            // params should have both fields
            expectTypeOf(params.difficulty).toEqualTypeOf<'easy' | 'hard'>()
            expectTypeOf(params.numChoices).toBeNumber()
            return { picked: params.difficulty }
          },
          *client(handoff, _ctx, params) {
            // params available in client too
            expectTypeOf(params.difficulty).toEqualTypeOf<'easy' | 'hard'>()
            expectTypeOf(handoff.picked).toEqualTypeOf<'easy' | 'hard'>()
            return { selected: true }
          },
          *after(handoff, client, _ctx, params) {
            // params available in after as well
            expectTypeOf(params.numChoices).toBeNumber()
            return { mode: handoff.picked, done: client.selected }
          },
        })

      type Result = InferToolResult<typeof tool>
      expectTypeOf<Result>().toEqualTypeOf<{ mode: 'easy' | 'hard'; done: boolean }>()
    })
  })

  describe('Client Authority', () => {
    it('should flow client output to server', () => {
      const tool = createIsomorphicTool('user_input')
        .description('Get user input')
        .parameters(z.object({ options: z.array(z.string()) }))
        .authority('client')
        .client(function*(params, _ctx) {
          expectTypeOf(params.options).toEqualTypeOf<string[]>()
          return { choice: 'option1', confidence: 0.9 }
        })
        .server(function*(_params, _ctx, clientOutput) {
          // clientOutput should be { choice: string, confidence: number }
          expectTypeOf(clientOutput.choice).toBeString()
          expectTypeOf(clientOutput.confidence).toBeNumber()
          return { validated: true, selected: clientOutput.choice }
        })

      type Result = InferToolResult<typeof tool>
      expectTypeOf<Result>().toEqualTypeOf<{ validated: boolean; selected: string }>()

      type ClientOutput = InferToolClientOutput<typeof tool>
      expectTypeOf<ClientOutput>().toEqualTypeOf<{ choice: string; confidence: number }>()
    })

    it('should allow client-only tools (server defaults to passthrough)', () => {
      const tool = createIsomorphicTool('client_only')
        .description('Client only (passthrough)')
        .parameters(z.object({ prompt: z.string() }))
        .authority('client')
        .client(function*(params) {
          return { echoed: params.prompt }
        })
        .build()

      type Result = InferToolResult<typeof tool>
      expectTypeOf<Result>().toEqualTypeOf<{ echoed: string }>()

      type ClientOutput = InferToolClientOutput<typeof tool>
      expectTypeOf<ClientOutput>().toEqualTypeOf<{ echoed: string }>()

      // Authority remains explicitly client
      expectTypeOf(tool.authority).toEqualTypeOf<'client'>()
    })

    it('should forbid handoff in client authority mode', () => {
      const builder = createIsomorphicTool('bad_client_handoff')
        .description('Bad')
        .parameters(z.object({ x: z.string() }))
        .authority('client')

      // @ts-expect-error handoff is server mode only
      builder.handoff({
        *before() {
          return { a: 1 }
        },
        *client() {
          return { b: 2 }
        },
        *after() {
          return { c: 3 }
        },
      })
    })
  })

  describe('Server Authority without Handoff', () => {
    it('should type server output flowing to client', () => {
      const tool = createIsomorphicTool('celebrate')
        .description('Celebrate')
        .parameters(z.object({ message: z.string() }))
        .authority('server')
        .server(function*(params, _ctx) {
          return { celebrated: true, message: params.message }
        })
        .client(function*(serverOutput, _ctx, _params) {
          // serverOutput should be { celebrated: boolean, message: string }
          expectTypeOf(serverOutput.celebrated).toBeBoolean()
          expectTypeOf(serverOutput.message).toBeString()
          return { displayed: true }
        })

      type Result = InferToolResult<typeof tool>
      expectTypeOf<Result>().toEqualTypeOf<{ celebrated: boolean; message: string }>()
    })

    it('should allow server-only tools', () => {
      const tool = createIsomorphicTool('server_only')
        .description('Server only')
        .parameters(z.object({ data: z.number() }))
        .authority('server')
        .server(function*(params) {
          return { processed: params.data * 2 }
        })
        .build()

      type Result = InferToolResult<typeof tool>
      expectTypeOf<Result>().toEqualTypeOf<{ processed: number }>()
    })
  })


  describe('Type Inference Helpers', () => {
    it('should infer params type', () => {
      const tool = createIsomorphicTool('test')
        .description('Test')
        .parameters(z.object({ x: z.number(), y: z.string() }))
        .authority('server')
        .server(function*(_params) { return { done: true } })
        .build()

      type Params = InferToolParams<typeof tool>
      expectTypeOf<Params>().toEqualTypeOf<{ x: number; y: string }>()
    })

    it('should infer handoff type for handoff tools', () => {
      const tool = createIsomorphicTool('handoff_test')
        .description('Test')
        .parameters(z.object({ input: z.string() }))
        .authority('server')
        .handoff({
          *before() { return { secret: 123, hint: 'test' } },
          *client(_handoff) { return { saw: true } },
          *after(handoff, _client) { return { value: handoff.secret } },
        })

      type Handoff = InferToolHandoff<typeof tool>
      expectTypeOf<Handoff>().toEqualTypeOf<{ secret: number; hint: string }>()
    })
  })

  describe('FinalizedIsomorphicTool Structure', () => {
    it('should have correct property types', () => {
      const tool = createIsomorphicTool('structured')
        .description('A structured tool')
        .parameters(z.object({ id: z.number() }))
        .authority('server')
        .handoff({
          *before(params) { return { computed: params.id * 2 } },
          *client(_handoff) { return { acknowledged: true } },
          *after(handoff, _client) { return { result: handoff.computed } },
        })

      // Check structure
      expectTypeOf(tool.name).toEqualTypeOf<'structured'>()
      expectTypeOf(tool.description).toBeString()
      expectTypeOf(tool.authority).toEqualTypeOf<'server'>()
      expectTypeOf(tool.parameters).toMatchTypeOf<z.ZodType<{ id: number }>>()
    })
  })
})
