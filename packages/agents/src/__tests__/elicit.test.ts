import { describe, it, expect } from '@effectionx/vitest'
import { z } from 'zod'
import { all } from 'effection'
import { createTool } from '@sweatpants/core'
import { createAgent } from '../create-agent.ts'
import { createAgentSession } from '../session.ts'
import { createInMemoryAgentStreamStore } from '../stream.ts'
import { parallel } from '../parallel.ts'
import { collectUntil } from './helpers.ts'

const ElicitTool = createTool({
  name: 'ask',
  description: 'ask the user',
  input: z.object({ question: z.string() }),
  output: z.object({ answer: z.string() }),
  progress: z.object({}),
  // No impl: this tool is only invoked via the harness ctx.call which routes
  // to the tool factory. We give it an impl that calls ctx... but the existing
  // tool API has no ctx. So we test elicit at the harness level instead.
  impl: function* ({ question }) {
    return { answer: `echo:${question}` }
  },
})

describe('ctx.elicit (REQ-014/015)', () => {
  it('ctx.elicit emits elicit_request and parks until respondElicit (TC-028)', function* () {
    const Travel = createAgent({
      name: 'travel',
      description: 'travel',
      systemPrompt: 'travel',
      tools: { ask: ElicitTool },
      entry: function* (_input, ctx) {
        const res = yield* ctx.elicit('confirm', { message: 'Book the flight?' })
        return { status: res.status, value: res.value }
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Travel, {
      contextId: 'ctx-elicit',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'go' })

    // Wait for the elicit_request to appear.
    const before = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'elicit_request'),
    )
    const req = before.find((e) => e.type === 'elicit_request') as
      | { type: 'elicit_request'; requestId: string }
      | undefined
    expect(req?.requestId).toBeTruthy()

    // Respond.
    yield* session.send({
      type: 'respondElicit',
      requestId: req!.requestId,
      result: { status: 'accepted', value: 'yes' },
    })

    const after = yield* collectUntil(
      session,
      (e) => e.some((x) => x.type === 'result'),
      before[before.length - 1]!.lsn + 1,
    )
    const result = after.find((e) => e.type === 'result') as
      | { type: 'result'; value: unknown }
      | undefined
    expect(result?.value).toEqual({ status: 'accepted', value: 'yes' })
  })

  it('elicit propagates from a sub-agent to the top-level stream (TC-044)', function* () {
    const Leaf = createAgent({
      name: 'leaf',
      description: 'leaf',
      systemPrompt: 'leaf',
      tools: {},
      entry: function* (_input, ctx) {
        const res = yield* ctx.elicit('leaf-q', { message: 'which?' })
        return { answered: res.value }
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const Travel = createAgent({
      name: 'travel',
      description: 'travel',
      systemPrompt: 'travel',
      tools: {},
      subAgents: { leaf: Leaf },
      entry: function* (_input, ctx) {
        return yield* ctx.agents.leaf({ any: true })
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Travel, {
      contextId: 'ctx-nested-elicit',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'go' })

    const before = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'elicit_request'),
    )
    const req = before.find((e) => e.type === 'elicit_request') as
      | { type: 'elicit_request'; requestId: string; key: string }
      | undefined
    expect(req?.key).toBe('leaf-q')

    yield* session.send({
      type: 'respondElicit',
      requestId: req!.requestId,
      result: { status: 'accepted', value: 'option-A' },
    })
    const after = yield* collectUntil(
      session,
      (e) => e.some((x) => x.type === 'result'),
      before[before.length - 1]!.lsn + 1,
    )
    const result = after.find((e) => e.type === 'result') as
      | { type: 'result'; value: unknown }
      | undefined
    expect(result?.value).toMatchObject({ result: { answered: 'option-A' } })
  })

  it('parallel sub-agents each receive their elicit response by requestId (TC-015)', function* () {
    const Echo = createAgent({
      name: 'echo',
      description: 'echo',
      systemPrompt: 'echo',
      tools: {},
      entry: function* (input: { tag: string }, ctx) {
        const res = yield* ctx.elicit(input.tag, { message: input.tag })
        return { tag: input.tag, value: res.value }
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const Travel = createAgent({
      name: 'travel',
      description: 'travel',
      systemPrompt: 'travel',
      tools: {},
      subAgents: { echo: Echo },
      entry: function* (_input, ctx) {
        const [a, b] = yield* all([
          ctx.agents.echo({ tag: 'A' }),
          ctx.agents.echo({ tag: 'B' }),
        ])
        return { a, b }
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Travel, {
      contextId: 'ctx-parallel-elicit',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'go' })

    const before = yield* collectUntil(
      session,
      (e) => e.filter((x) => x.type === 'elicit_request').length === 2,
    )
    const reqs = before.filter((e) => e.type === 'elicit_request') as Array<{
      type: 'elicit_request'
      requestId: string
      key: string
    }>
    expect(reqs.map((r) => r.key).sort()).toEqual(['A', 'B'])

    // Respond in reverse order to prove requestId routing, not positional.
    yield* session.send({
      type: 'respondElicit',
      requestId: reqs[1]!.requestId,
      result: { status: 'accepted', value: 'B-val' },
    })
    yield* session.send({
      type: 'respondElicit',
      requestId: reqs[0]!.requestId,
      result: { status: 'accepted', value: 'A-val' },
    })

    const after = yield* collectUntil(
      session,
      (e) => e.some((x) => x.type === 'result'),
      before[before.length - 1]!.lsn + 1,
    )
    const result = after.find((e) => e.type === 'result') as
      | { type: 'result'; value: { a: unknown; b: unknown } }
      | undefined
    expect(result?.value.a).toMatchObject({ result: { tag: 'A', value: 'A-val' } })
    expect(result?.value.b).toMatchObject({ result: { tag: 'B', value: 'B-val' } })
  })

  it('parallel() helper runs sub-calls concurrently like all() (TC-016)', function* () {
    const Count = createAgent({
      name: 'count',
      description: 'count',
      systemPrompt: 'count',
      tools: {},
      entry: function* (input: { n: number }) {
        return input.n * 2
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const Travel = createAgent({
      name: 'travel',
      description: 'travel',
      systemPrompt: 'travel',
      tools: {},
      subAgents: { count: Count },
      entry: function* (_input, ctx) {
        const [r1, r2] = yield* parallel([
          ctx.agents.count({ n: 5 }),
          ctx.agents.count({ n: 7 }),
        ])
        return { r1, r2 }
      },
      model: { provider: 'mock', id: 'm1' },
      maxIterations: 1,
    })

    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Travel, {
      contextId: 'ctx-parallel',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'go' })
    const events = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'result'),
    )
    const result = events.find((e) => e.type === 'result') as
      | { type: 'result'; value: { r1: number; r2: number } }
      | undefined
    expect(result?.value).toMatchObject({ r1: { result: 10 }, r2: { result: 14 } })
  })
})
