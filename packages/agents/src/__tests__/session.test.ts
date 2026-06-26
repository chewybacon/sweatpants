import { describe, it, expect } from '@effectionx/vitest'
import { createAgent } from '../create-agent.ts'
import { createAgentSession } from '../session.ts'
import { createInMemoryAgentStreamStore } from '../stream.ts'
import { createMockSampleProvider, collectUntil } from './helpers.ts'
import { messageText } from '../events.ts'

describe('AgentSession harness (REQ-007/009/011/012/013)', () => {
  it('sendMessage runs the entry harness (TC-026) and ctx.sample streams a text_delta (TC-027)', function* () {
    const Travel = createAgent({
      name: 'travel',
      description: 'travel',
      systemPrompt: 'you are a travel planner',
      tools: {},
      entry: function* (_input, ctx) {
        const res = yield* ctx.sample({ prompt: 'plan' })
        return { plan: res.content }
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Travel, {
      contextId: 'ctx-sample',
      store,
      sampleProvider: createMockSampleProvider(() => 'Visit Tokyo in spring.'),
    })
    yield* session.send({ type: 'sendMessage', message: 'plan a trip' })

    const events = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'result'),
    )
    expect(events.some((e) => e.type === 'text_delta')).toBe(true)
    const delta = events.find((e) => e.type === 'text_delta') as
      | { type: 'text_delta'; delta: string }
      | undefined
    expect(delta?.delta).toBe('Visit Tokyo in spring.')
    const result = events.find((e) => e.type === 'result') as
      | { type: 'result'; value: unknown }
      | undefined
    expect(result?.value).toEqual({ plan: 'Visit Tokyo in spring.' })
  })

  it('emits a checkpoint at the turn boundary (TC-038)', function* () {
    const Travel = createAgent({
      name: 'travel',
      description: 'travel',
      systemPrompt: 'travel',
      tools: {},
      entry: function* () {
        return { done: true }
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Travel, {
      contextId: 'ctx-checkpoint',
      store,
      sampleProvider: createMockSampleProvider(() => 'ok'),
    })
    yield* session.send({ type: 'sendMessage', message: 'go' })
    const events = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'checkpoint'),
    )
    const cp = events.find((e) => e.type === 'checkpoint') as
      | { type: 'checkpoint'; checkpoint: { contextId: string; messages: unknown[] } }
      | undefined
    expect(cp?.checkpoint.contextId).toBe('ctx-checkpoint')
    expect(cp?.checkpoint.messages.length).toBeGreaterThan(0)
  })

  it('restores from a checkpoint on a subsequent sendMessage (TC-031/034)', function* () {
    let seenMessages: string[] = []
    const Travel = createAgent({
      name: 'travel',
      description: 'travel',
      systemPrompt: 'travel',
      tools: {},
      entry: function* (input, ctx) {
        seenMessages = ctx.messages.map((m) => messageText(m))
        return { echo: input }
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Travel, {
      contextId: 'ctx-restore',
      store,
      sampleProvider: createMockSampleProvider(() => 'ok'),
    })

    yield* session.send({ type: 'sendMessage', message: 'first' })
    yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'checkpoint'),
    )
    // Second turn: restoration should load the checkpoint so prior messages persist.
    yield* session.send({ type: 'sendMessage', message: 'second' })
    yield* collectUntil(
      session,
      (e) => e.filter((x) => x.type === 'result').length === 2,
    )
    expect(seenMessages).toContain('first')
    expect(seenMessages).toContain('second')
  })

  it('sendMessage with snapshot seeds state when the stream is empty (TC-035)', function* () {
    let seeded = 0
    const Travel = createAgent({
      name: 'travel',
      description: 'travel',
      systemPrompt: 'travel',
      tools: {},
      entry: function* (_input, ctx) {
        seeded = ctx.messages.length
        return { ok: true }
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Travel, {
      contextId: 'ctx-snapshot',
      store,
      sampleProvider: createMockSampleProvider(() => 'ok'),
    })
    yield* session.send({
      type: 'sendMessage',
      message: 'next',
      snapshot: {
        messages: [{ id: 'p', role: 'user', content: 'prior' }],
        state: {},
      },
    })
    yield* collectUntil(session, (e) => e.some((x) => x.type === 'result'))
    // prior message + the new 'next' message
    expect(seeded).toBe(2)
  })

  it('cancel halts the running harness and emits cancelled (TC for §5)', function* () {
    const Travel = createAgent({
      name: 'travel',
      description: 'travel',
      systemPrompt: 'travel',
      tools: {},
      entry: function* (_input, ctx) {
        // Park on an elicit so the harness is mid-run when we cancel.
        yield* ctx.elicit('block', { message: 'waiting' })
        return { unreachable: true }
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Travel, {
      contextId: 'ctx-cancel',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'go' })
    yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'elicit_request'),
    )
    yield* session.send({ type: 'cancel', reason: 'user aborted' })
    const events = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'cancelled'),
    )
    expect(events.some((e) => e.type === 'cancelled')).toBe(true)
    expect(session.status()).toBe('idle')
  })
})
