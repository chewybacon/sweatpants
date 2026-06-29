import { describe, it, expect } from '@effectionx/vitest'
import { z } from 'zod'
import { createTool } from '@sweatpants/core'
import { createAgent } from '../create-agent.ts'
import { createAgentSession } from '../session.ts'
import { createInMemoryAgentStreamStore } from '../stream.ts'
import { UnresolvableTargetError } from '../ctx.ts'
import { collectUntil } from './helpers.ts'

const Book = createTool('book')
  .description('book a thing')
  .parameters(z.object({ destination: z.string() }))
  .output(z.object({ confirmed: z.boolean(), destination: z.string() }))
  .execute(function* ({ destination }) {
    return { confirmed: true, destination }
  })

const BuilderEcho = createTool('builder_echo')
  .description('builder echo')
  .parameters(z.object({ text: z.string() }))
  .elicits({})
  .execute(function* ({ text }) {
    return { echoed: text }
  })

const FrameworkConfirm = createTool('framework_confirm')
  .description('canonical declared elicit confirm')
  .parameters(z.object({ item: z.string() }))
  .elicits({
    confirm: { response: z.object({ ok: z.boolean() }) },
  })
  .execute(function* ({ item }, ctx) {
    const confirmation = yield* ctx.elicit('confirm', { message: `Confirm ${item}?` })
    return {
      item,
      confirmed: confirmation.action === 'accept' && confirmation.content.ok,
    }
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
    expect(result?.value).toMatchObject({ result: { confirmed: true, destination: 'Tokyo' } })
    expect((result?.value as { exchange?: { messages: unknown[] } })?.exchange?.messages).toHaveLength(2)
    expect(events.some((e) => e.type === 'tool_call_start')).toBe(true)
    expect(events.some((e) => e.type === 'tool_call_result')).toBe(true)
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
    expect(result?.value).toMatchObject({ result: { confirmed: true, destination: 'Paris' } })
    expect((result?.value as { exchange?: { request?: { role: string } } })?.exchange?.request?.role).toBe('assistant')
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
    expect(result?.value).toMatchObject({ result: { hotel: 'Hilton Osaka' } })
    expect((result?.value as { exchange?: { request?: { role: string }; response?: { role: string } } })?.exchange?.request?.role).toBe('user')
    expect((result?.value as { exchange?: { request?: { role: string }; response?: { role: string } } })?.exchange?.response?.role).toBe('assistant')
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
    expect(result?.value).toMatchObject({ result: { hotel: 'Hilton Kyoto' } })
  })

  it('core createTool(name) builder output runs as a unified tool', function* () {
    const EchoAgent = createAgent({
      name: 'echo-agent',
      description: 'echo',
      systemPrompt: 'echo',
      tools: { builder_echo: BuilderEcho },
      entry: function* (_input, ctx) {
        return yield* ctx.tools.builder_echo({ text: 'hello' })
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(EchoAgent, {
      contextId: 'ctx-core-builder-tool',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'go' })
    const events = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'result'),
    )
    const result = events.find((e) => e.type === 'result') as
      | { type: 'result'; value: { result: { echoed: string }; exchange: { messages: unknown[] } } }
      | undefined
    expect(result?.value.result.echoed).toBe('hello')
    expect(result?.value.exchange.messages).toHaveLength(2)
  })

  it('canonical core createTool output runs directly as a unified callable tool', function* () {
    const Agent = createAgent({
      name: 'framework-tool-agent',
      description: 'framework tool agent',
      systemPrompt: 'confirm things',
      tools: { framework_confirm: FrameworkConfirm },
      entry: function* (_input, ctx) {
        return yield* ctx.tools.framework_confirm({ item: 'booking' })
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Agent, {
      contextId: 'ctx-framework-builder-tool',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'go' })

    const events = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'elicit_request'),
    )
    const request = events.find((e) => e.type === 'elicit_request') as
      | { type: 'elicit_request'; requestId: string }
      | undefined
    expect(request?.requestId).toBeTruthy()
    yield* session.send({
      type: 'respondElicit',
      requestId: request!.requestId,
      result: { status: 'accepted', value: { ok: true } },
    })

    const finalEvents = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'result'),
      events[events.length - 1]!.lsn + 1,
    )
    const result = finalEvents.find((e) => e.type === 'result') as
      | { type: 'result'; value: { result: { item: string; confirmed: boolean }; exchange: { messages: unknown[] } } }
      | undefined
    expect(result?.value.result).toEqual({ item: 'booking', confirmed: true })
    expect(result?.value.exchange.messages.length).toBeGreaterThanOrEqual(2)
  })

  it('ctx.callResult(toolName, input) returns only the typed result (REQ-028)', function* () {
    const Travel = createAgent({
      name: 'travel',
      description: 'travel',
      systemPrompt: 'travel',
      tools: { book: Book },
      entry: function* (_input, ctx) {
        return yield* ctx.callResult('book', { destination: 'Seoul' })
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Travel, {
      contextId: 'ctx-call-result',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'go' })
    const events = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'result'),
    )
    const result = events.find((e) => e.type === 'result') as
      | { type: 'result'; value: unknown }
      | undefined
    expect(result?.value).toEqual({ confirmed: true, destination: 'Seoul' })
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
