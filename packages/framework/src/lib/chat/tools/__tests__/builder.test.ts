/**
 * Builder Tests
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createTool } from '../builder.ts'
import type {
  FinalizedTool,
  InferToolParams,
  InferToolResult,
  InferToolElicits,
} from '../types.ts'

describe('createTool builder', () => {
  describe('simple execute pattern', () => {
    it('creates a tool with execute function', () => {
      const tool = createTool('calculator')
        .description('Calculate expression')
        .parameters(z.object({ expr: z.string() }))
        .execute(function* (params) {
          return { result: params.expr }
        })

      expect(tool.name).toBe('calculator')
      expect(tool.description).toBe('Calculate expression')
      expect(tool.mode).toBe('execute')
      expect(tool.execute).toBeDefined()
      expect(tool.handoffConfig).toBeUndefined()
    })

    it('validates parameter schema', () => {
      const tool = createTool('test')
        .description('Test')
        .parameters(z.object({ num: z.number(), str: z.string() }))
        .execute(function* () {
          return {}
        })

      const valid = tool.parameters.safeParse({ num: 42, str: 'hello' })
      expect(valid.success).toBe(true)

      const invalid = tool.parameters.safeParse({ num: 'not a number' })
      expect(invalid.success).toBe(false)
    })
  })

  describe('handoff pattern', () => {
    it('creates a tool with handoff config', () => {
      const tool = createTool('picker')
        .description('Pick something')
        .parameters(z.object({ options: z.array(z.string()) }))
        .handoff({
          *before(params) {
            return { items: params.options }
          },
          *client(handoff) {
            return { picked: handoff.items[0] }
          },
          *after(handoff, client) {
            return { result: client.picked }
          },
        })

      expect(tool.name).toBe('picker')
      expect(tool.mode).toBe('handoff')
      expect(tool.handoffConfig).toBeDefined()
      expect(tool.execute).toBeUndefined()
    })
  })

  describe('elicitation', () => {
    it('supports single elicit definition', () => {
      const tool = createTool('confirm')
        .description('Confirm action')
        .parameters(z.object({ action: z.string() }))
        .elicit('confirm', z.object({ ok: z.boolean() }))
        .execute(function* () {
          return { confirmed: true }
        })

      expect(tool.elicits).toHaveProperty('confirm')
      expect(Object.keys(tool.elicits)).toHaveLength(1)
    })

    it('supports chained elicit definitions', () => {
      const tool = createTool('wizard')
        .description('Multi-step wizard')
        .parameters(z.object({}))
        .elicit('step1', z.object({ name: z.string() }))
        .elicit('step2', z.object({ email: z.string() }))
        .elicit('step3', z.object({ confirm: z.boolean() }))
        .execute(function* () {
          return { complete: true }
        })

      expect(Object.keys(tool.elicits)).toHaveLength(3)
      expect(tool.elicits).toHaveProperty('step1')
      expect(tool.elicits).toHaveProperty('step2')
      expect(tool.elicits).toHaveProperty('step3')
    })

    it('works with handoff pattern', () => {
      const tool = createTool('pick_card')
        .description('Pick a card')
        .parameters(z.object({}))
        .elicit('pick', z.object({ card: z.string() }))
        .handoff({
          *before() {
            return { cards: ['A', 'K', 'Q'] }
          },
          *client(handoff) {
            return { picked: handoff.cards[0] }
          },
          *after(handoff, client) {
            return { selected: client.picked }
          },
        })

      expect(tool.mode).toBe('handoff')
      expect(tool.elicits).toHaveProperty('pick')
    })
  })

  describe('limits', () => {
    it('supports execution limits', () => {
      const tool = createTool('limited')
        .description('Limited tool')
        .parameters(z.object({}))
        .limits({ maxTokens: 1000, timeout: 30000 })
        .execute(function* () {
          return {}
        })

      expect(tool.limits).toEqual({ maxTokens: 1000, timeout: 30000 })
    })

    it('limits are optional', () => {
      const tool = createTool('unlimited')
        .description('Unlimited tool')
        .parameters(z.object({}))
        .execute(function* () {
          return {}
        })

      expect(tool.limits).toBeUndefined()
    })
  })

  describe('type inference', () => {
    it('infers params type', () => {
      const tool = createTool('typed')
        .description('Typed tool')
        .parameters(z.object({ name: z.string(), age: z.number() }))
        .execute(function* () {
          return {}
        })

      // Type-level test - if this compiles, types are correct
      type Params = InferToolParams<typeof tool>
      const _params: Params = { name: 'test', age: 42 }
      expect(_params).toBeDefined()
    })

    it('infers result type', () => {
      const tool = createTool('typed')
        .description('Typed tool')
        .parameters(z.object({}))
        .execute(function* () {
          return { value: 42, message: 'done' }
        })

      // Type-level test
      type Result = InferToolResult<typeof tool>
      const _result: Result = { value: 42, message: 'done' }
      expect(_result).toBeDefined()
    })

    it('infers elicits type', () => {
      const tool = createTool('typed')
        .description('Typed tool')
        .parameters(z.object({}))
        .elicit('confirm', z.object({ ok: z.boolean() }))
        .elicit('input', z.object({ value: z.string() }))
        .execute(function* () {
          return {}
        })

      // Type-level test
      type Elicits = InferToolElicits<typeof tool>
      type Keys = keyof Elicits
      const _key: Keys = 'confirm'
      expect(_key).toBe('confirm')
    })
  })

  describe('error handling', () => {
    it('throws if execute called without parameters', () => {
      expect(() => {
        const builder = createTool('test').description('Test') as any
        builder.execute(function* () {
          return {}
        })
      }).toThrow('.parameters() must be called')
    })

    it('throws if elicit called without parameters', () => {
      expect(() => {
        const builder = createTool('test').description('Test') as any
        builder.elicit('key', z.object({}))
      }).toThrow('.parameters() must be called')
    })
  })
})
