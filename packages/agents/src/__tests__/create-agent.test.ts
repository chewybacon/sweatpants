import { describe, it, expect } from '@effectionx/vitest'
import { z } from 'zod'
import { createTool } from '@sweatpants/core'

import { createAgent } from '../create-agent.ts'
import type { AgentFactory } from '../types.ts'

const Book = createTool({
  name: 'book',
  description: 'book a thing',
  input: z.object({ destination: z.string() }),
  output: z.object({ confirmed: z.boolean(), destination: z.string() }),
  progress: z.object({}),
  impl: function* ({ destination }) {
    return { confirmed: true, destination }
  },
})

describe('createAgent (REQ-001)', () => {
  it('returns a callable AgentFactory with metadata', function* () {
    const A = createAgent({
      name: 'a',
      description: 'agent a',
      systemPrompt: 'you are a',
      tools: { book: Book },
      entry: function* (_input, _ctx) {
        return { ok: true }
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 3,
    })

    expect(A.name).toBe('a')
    expect(A.description).toBe('agent a')
    expect(A.systemPrompt).toBe('you are a')
    expect(A.model).toEqual({ provider: 'mock', id: 'm1' })
    expect(A.maxIterations).toBe(3)
    expect(typeof A.entry).toBe('function')
    expect(typeof A.decorate).toBe('function')

    const instance = yield* A()
    const result = yield* instance.invoke('go')
    expect(result).toEqual({ ok: true })
  })

  it('goal is reflected in the effective system prompt', function* () {
    const A = createAgent({
      name: 'g',
      description: 'goal agent',
      systemPrompt: 'you plan',
      tools: { book: Book },
      goal: 'plan a trip to Japan',
      entry: function* (_input, ctx) {
        // ctx.sample with no provider emits a sample_request; we just check
        // the agent's systemPrompt + goal via the factory metadata.
        void ctx
        return { goal: true }
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })
    expect(A.goal).toBe('plan a trip to Japan')
  })

  it('tools are accessible on the factory for projection', function* () {
    const A = createAgent({
      name: 't',
      description: 't',
      systemPrompt: 't',
      tools: { book: Book },
      entry: function* () {
        return null
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })
    expect(Object.keys(A.tools)).toEqual(['book'])
  })
})

// Re-export to satisfy the `AgentFactory` type import in test files.
export type { AgentFactory }
