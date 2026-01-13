/**
 * Plugin Builder Tests
 *
 * Tests for makePlugin() and type-safe elicitation.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createBranchTool, makePlugin } from '../index.ts'
import type { RawElicitResult } from '../types.ts'

describe('makePlugin', () => {
  describe('type safety', () => {
    it('should enforce exhaustive elicitation handlers', () => {
      // Define a bridgeable tool
      const tool = createBranchTool('test_tool')
        .description('Test tool')
        .parameters(z.object({ input: z.string() }))
        .elicits({
          confirm: z.object({ ok: z.boolean() }),
          selectItem: z.object({ itemId: z.string() }),
        })
        .execute(function* (_params, ctx) {
          const confirm = yield* ctx.elicit('confirm', { message: 'Confirm?' })
          if (confirm.action !== 'accept') return { cancelled: true }

          const item = yield* ctx.elicit('selectItem', { message: 'Pick item' })
          if (item.action !== 'accept') return { cancelled: true }

          return { confirmed: true, itemId: item.content.itemId }
        })

      // Build the plugin with exhaustive handlers
      const plugin = makePlugin(tool)
        .onElicit({
          confirm: function* (_req, _ctx) {
            // Return type must match { ok: boolean }
            return { action: 'accept', content: { ok: true } } satisfies RawElicitResult<{
              ok: boolean
            }>
          },
          selectItem: function* (_req, _ctx) {
            // Return type must match { itemId: string }
            return {
              action: 'accept',
              content: { itemId: 'item-123' },
            } satisfies RawElicitResult<{ itemId: string }>
          },
        })
        .build()

      // Verify plugin structure
      expect(plugin.server.toolName).toBe('test_tool')
      expect(plugin.server.tools).toHaveLength(1)
      expect(plugin.server.tools[0]).toBe(tool)

      expect(plugin.client.toolName).toBe('test_tool')
      expect(plugin.client.handlers).toHaveProperty('confirm')
      expect(plugin.client.handlers).toHaveProperty('selectItem')
      expect(plugin.client.schemas).toBe(tool.elicits)
    })

    it('should preserve tool types through plugin', () => {
      const tool = createBranchTool('typed_tool')
        .description('Typed tool')
        .parameters(z.object({ count: z.number() }))
        .elicits({
          pickNumber: z.object({ n: z.number() }),
        })
        .handoff({
          *before(params, _ctx) {
            return { doubled: params.count * 2 }
          },
          *client(handoff, ctx) {
            const pick = yield* ctx.elicit('pickNumber', { message: 'Pick' })
            if (pick.action !== 'accept') return { sum: 0 }
            return { sum: handoff.doubled + pick.content.n }
          },
          *after(handoff, client, _ctx, _params) {
            return {
              original: handoff.doubled / 2,
              result: client.sum,
            }
          },
        })

      const plugin = makePlugin(tool)
        .onElicit({
          pickNumber: function* (_req, _ctx) {
            return { action: 'accept', content: { n: 42 } }
          },
        })
        .build()

      // Tool should be accessible from plugin
      expect(plugin.tool.name).toBe('typed_tool')
      expect(plugin.tool.elicits).toHaveProperty('pickNumber')
    })
  })

  describe('elicit key typing', () => {
    it('ctx.elicit should only accept declared keys', () => {
      // This is a compile-time test - if this compiles, the types work
      const tool = createBranchTool('key_test')
        .description('Key test')
        .parameters(z.object({}))
        .elicits({
          alpha: z.object({ a: z.string() }),
          beta: z.object({ b: z.number() }),
        })
        .execute(function* (_params, ctx) {
          // These should compile
          const a = yield* ctx.elicit('alpha', { message: 'A' })
          const b = yield* ctx.elicit('beta', { message: 'B' })

          // This would NOT compile (uncomment to verify):
          // const c = yield* ctx.elicit('gamma', { message: 'C' })

          return {
            a: a.action === 'accept' ? a.content.a : null,
            b: b.action === 'accept' ? b.content.b : null,
          }
        })

      expect(tool.elicits).toHaveProperty('alpha')
      expect(tool.elicits).toHaveProperty('beta')
    })
  })
})
