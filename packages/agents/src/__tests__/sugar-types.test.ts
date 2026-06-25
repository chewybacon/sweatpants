/**
 * CB-1 regression coverage (runtime): sub-agent sugar must compose two
 * sub-agents with DIFFERENT input shapes. The bug (infer V → union of
 * factories) didn't break the call at runtime, but collapsed each accessor's
 * return type to `never`, losing output inference. The authoritative
 * regression guard is the `SugarMap` comment in ctx.ts (do not revert `M[K]`
 * to `infer V`); this test confirms the composition still works end-to-end.
 */
import { describe, it, expect } from '@effectionx/vitest'
import { createAgent } from '../create-agent.ts'
import { createAgentSession } from '../session.ts'
import { createInMemoryAgentStreamStore } from '../stream.ts'
import { collectUntil } from './helpers.ts'

const Hotel = createAgent({
  name: 'hotel',
  description: 'h',
  systemPrompt: 'h',
  tools: {},
  entry: function* (input: { city: string }) {
    return { hotel: `Hilton ${input.city}` }
  },
  model: { provider: 'mock', id: 'm1' },
  maxIterations: 1,
})

const Car = createAgent({
  name: 'car',
  description: 'c',
  systemPrompt: 'c',
  tools: {},
  entry: function* (input: { pickup: string }) {
    return { car: `Rent at ${input.pickup}` }
  },
  model: { provider: 'mock', id: 'm1' },
  maxIterations: 1,
})

const Travel = createAgent({
  name: 'travel',
  description: 't',
  systemPrompt: 't',
  tools: {},
  subAgents: { hotel: Hotel, car: Car },
  entry: function* (_input, ctx) {
    const hotel = yield* ctx.agents.hotel({ city: 'Tokyo' })
    const car = yield* ctx.agents.car({ pickup: 'NRT' })
    return { hotel, car }
  },
  model: { provider: 'mock', id: 'm1' },
  maxIterations: 1,
})

describe('CB-1 sub-agent sugar (REQ-004)', () => {
  it('two sub-agents with different inputs resolve with correct results', function* () {
    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Travel, {
      contextId: 'cb1',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'go' })
    const events = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'result'),
    )
    const result = events.find((e) => e.type === 'result') as
      | {
          type: 'result'
          value: { hotel: { hotel: string }; car: { car: string } }
        }
      | undefined
    expect(result?.value.hotel.hotel).toBe('Hilton Tokyo')
    expect(result?.value.car.car).toBe('Rent at NRT')
  })
})
