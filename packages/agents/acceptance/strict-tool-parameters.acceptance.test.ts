import { run } from 'effection'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTool } from '../src/index.ts'

describe('@sweatpants/agents strict tool parameter acceptance', () => {
  it('rejects invalid tool params before the agent tool implementation runs', async () => {
    await run(function* () {
      let calls = 0
      const BookFlight = createTool('book_flight')
        .description('Book a flight')
        .parameters(z.object({ from: z.string(), destination: z.string() }))
        .elicits({})
        .execute(function* (params) {
          calls += 1
          return { route: `${params.from}-${params.destination}` }
        })

      const invoke = yield* BookFlight({
        history: [],
        elicit: (() => { throw new Error('not used') }) as never,
        elicitDynamic: (() => { throw new Error('not used') }) as never,
        sample: (() => { throw new Error('not used') }) as never,
        notify: function* () {},
        log: function* () {},
      })

      try {
        yield* invoke({ destination: 'NYC' } as unknown as { from: string; destination: string })
        throw new Error('expected validation failure')
      } catch (error) {
        expect(error).toMatchObject({ code: 'invalid_tool_input' })
      }
      expect(calls).toBe(0)

      expect(yield* invoke({ from: 'Boston', destination: 'NYC' })).toEqual({ route: 'Boston-NYC' })
      expect(calls).toBe(1)
    })
  })
})
