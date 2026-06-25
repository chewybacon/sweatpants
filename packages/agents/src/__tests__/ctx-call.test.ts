import { describe, it, expect } from '@effectionx/vitest'
import { z } from 'zod'
import { createTool } from '@sweatpants/core'
import { createAgent } from '../create-agent.ts'
import { createAgentSession } from '../session.ts'
import { createInMemoryAgentStreamStore } from '../stream.ts'
import { UnresolvableTargetError } from '../ctx.ts'
import { collectUntil } from './helpers.ts'

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

const Hotel = createAgent({
  name: 'hotel',
  description: 'hotel agent',
  systemPrompt: 'book hotels',
  tools: {},
  entry: function* (input: { city: string }, _ctx) {
    return { hotel: `Hilton ${input.city}` }
  },
  model: { provider: 'mock', id: 'm1' },
  maxIterations: 1,
})

describe('ctx.call composition (REQ-003/004/006)', () => {
  it('ctx.call(toolName, input) runs a local tool (TC-006)', function* () {
    const Travel = createAgent({
      name: 'travel',
      description: 'travel',
      systemPrompt: 'travel',
      tools: { book: Book },
      entry: function* (_input, ctx) {
        return yield* ctx.call('book', { destination: 'Tokyo' })
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Travel, {
      contextId: 'ctx-tool',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'go' })

    const events = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'result'),
    )
    const result = events.find((e) => e.type === 'result') as
      | { type: 'result'; value: unknown }
      | undefined
    expect(result?.value).toEqual({ confirmed: true, destination: 'Tokyo' })
    expect(events.some((e) => e.type === 'tool_call_start')).toBe(true)
    expect(events.some((e) => e.type === 'tool_call_end')).toBe(true)
  })

  it('ctx.tools.book(input) is typed sugar over ctx.call (TC-011)', function* () {
    const Travel = createAgent({
      name: 'travel',
      description: 'travel',
      systemPrompt: 'travel',
      tools: { book: Book },
      entry: function* (_input, ctx) {
        return yield* ctx.tools.book({ destination: 'Paris' })
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Travel, {
      contextId: 'ctx-sugar-tool',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'go' })
    const events = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'result'),
    )
    const result = events.find((e) => e.type === 'result') as
      | { type: 'result'; value: unknown }
      | undefined
    expect(result?.value).toEqual({ confirmed: true, destination: 'Paris' })
  })

  it('ctx.call(AgentFactory, input) runs a sub-agent in-process (TC-007/017)', function* () {
    const Travel = createAgent({
      name: 'travel',
      description: 'travel',
      systemPrompt: 'travel',
      tools: {},
      subAgents: { hotel: Hotel },
      entry: function* (_input, ctx) {
        return yield* ctx.call(Hotel, { city: 'Osaka' })
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Travel, {
      contextId: 'ctx-subagent',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'go' })
    const events = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'result'),
    )
    const result = events.find((e) => e.type === 'result') as
      | { type: 'result'; value: unknown }
      | undefined
    expect(result?.value).toEqual({ hotel: 'Hilton Osaka' })
    // Sub-session events are tagged on the parent stream.
    expect(events.some((e) => e.type === 'sub_session_start')).toBe(true)
    expect(events.some((e) => e.type === 'sub_session_end')).toBe(true)
  })

  it('ctx.agents.hotel(input) is typed sugar (TC-010)', function* () {
    const Travel = createAgent({
      name: 'travel',
      description: 'travel',
      systemPrompt: 'travel',
      tools: {},
      subAgents: { hotel: Hotel },
      entry: function* (_input, ctx) {
        return yield* ctx.agents.hotel({ city: 'Kyoto' })
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Travel, {
      contextId: 'ctx-sugar-agent',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'go' })
    const events = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'result'),
    )
    const result = events.find((e) => e.type === 'result') as
      | { type: 'result'; value: unknown }
      | undefined
    expect(result?.value).toEqual({ hotel: 'Hilton Kyoto' })
  })

  it('ctx.call with an unresolvable target raises a descriptive error (TC-009)', function* () {
    const Travel = createAgent({
      name: 'travel',
      description: 'travel',
      systemPrompt: 'travel',
      tools: { book: Book },
      entry: function* (_input, ctx) {
        return yield* ctx.call('nope', {})
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Travel, {
      contextId: 'ctx-unresolvable',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'go' })
    const events = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'error'),
    )
    const err = events.find((e) => e.type === 'error') as
      | { type: 'error'; message: string }
      | undefined
    expect(err?.message).toContain('nope')
    expect(err?.message).toContain('book')
  })

  it('UnresolvableTargetError names the target and available tools', function* () {
    expect(() => {
      void new UnresolvableTargetError('nope', {
        name: 'travel',
        description: '',
        systemPrompt: '',
        tools: { book: Book },
        entry: (() => ({})) as never,
        model: { provider: 'mock', id: 'm1' },
        maxIterations: 1,
      } as never)
    }).not.toThrow()
    const e = new UnresolvableTargetError('nope', {
      name: 'travel',
      description: '',
      systemPrompt: '',
      tools: { book: Book },
      entry: (() => ({})) as never,
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    } as never)
    expect(e.message).toContain('nope')
    expect(e.message).toContain('book')
  })
})
