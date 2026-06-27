/**
 * Plugin Builder Tests
 *
 * Tests for makePlugin() and type-safe elicitation.
 */
import { describe, it, expect, expectTypeOf } from 'vitest'
import { z } from 'zod'
import { createMcpTool, makePlugin } from '../index.ts'
import type { InferMcpToolResult } from '../index.ts'
import type { RawElicitResult } from '../types.ts'
import type { RenderableProps } from '../plugin.ts'

describe('makePlugin', () => {
  describe('type safety', () => {
    it('should enforce exhaustive elicitation handlers', () => {
      // Define a bridgeable tool
      const tool = createMcpTool('test_tool')
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

    it('should preserve execute parameter, elicit context, elicit response, and result inference', () => {
      const tool = createMcpTool('book_like_tool')
        .description('Book-like typed tool')
        .parameters(
          z.object({
            from: z.string(),
            destination: z.string(),
          }),
        )
        .elicits({
          pickFlight: {
            response: z.object({ flightId: z.string() }),
            context: z.object({ flights: z.array(z.object({ id: z.string() })) }),
          },
          pickSeat: {
            response: z.object({ row: z.number(), seat: z.string() }),
            context: z.object({ seatMap: z.object({ rows: z.number() }) }),
          },
        })
        .execute(function* (params, ctx) {
          expectTypeOf(params).toEqualTypeOf<{ from: string; destination: string }>()

          const flight = yield* ctx.elicit('pickFlight', {
            message: `Pick a flight from ${params.from} to ${params.destination}`,
            flights: [{ id: 'FL001' }],
          })
          if (flight.action !== 'accept') return { success: false as const }
          expectTypeOf(flight.content).toEqualTypeOf<{ flightId: string }>()

          const seat = yield* ctx.elicit('pickSeat', {
            message: 'Pick a seat',
            seatMap: { rows: 10 },
          })
          if (seat.action !== 'accept') return { success: false as const }
          expectTypeOf(seat.content).toEqualTypeOf<{ row: number; seat: string }>()

          const tip = yield* ctx.sample({ prompt: 'Give a tip' })
          expectTypeOf(tip.text).toBeString()

          return {
            success: true as const,
            flightId: flight.content.flightId,
            seat: `${seat.content.row}${seat.content.seat}`,
            tip: tip.text,
          }
        })

      type Result = InferMcpToolResult<typeof tool>
      expectTypeOf<Result>().toEqualTypeOf<
        | { success: false }
        | { success: true; flightId: string; seat: string; tip: string }
      >()
    })

    it('should infer ctx.render response type from component props', () => {
      type PickerResponse = { itemId: string }
      type PickerProps = {
        label: string
      } & RenderableProps<PickerResponse>
      const Picker = (_props: PickerProps) => null

      const tool = createMcpTool('render_inference_tool')
        .description('Render inference tool')
        .parameters(z.object({}))
        .elicits({
          selectItem: z.object({ itemId: z.string() }),
        })
        .execute(function* (_params, ctx) {
          const selected = yield* ctx.elicit('selectItem', { message: 'Pick' })
          return selected.action === 'accept' ? selected.content : { itemId: 'none' }
        })

      const plugin = makePlugin(tool)
        .onElicit({
          selectItem: function* (_req, ctx) {
            const result = yield* ctx.render(Picker, { label: 'Pick one' })
            expectTypeOf(result).toEqualTypeOf<PickerResponse>()
            return { action: 'accept', content: result }
          },
        })
        .build()

      expect(plugin.client.toolName).toBe('render_inference_tool')
    })

    it('should preserve tool types through plugin', () => {
      const tool = createMcpTool('typed_tool')
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
      const tool = createMcpTool('key_test')
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
