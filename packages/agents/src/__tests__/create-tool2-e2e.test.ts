/**
 * createTool2 E2E — a tool authored natively on the unified `(input, ctx: ToolCtx)`
 * signature composes via `ctx.tools.X` and elicits/samples through the stream.
 *
 * This is the terminal authoring surface (design REQ-2): framework tools are used directly
 * adapter, no framework finalized runtime object. The tool's `ctx.elicit`/`ctx.sample`/
 * `ctx.notify` are the same `ToolCtx` the agent projects at call time.
 */
import { describe, it, expect } from '@effectionx/vitest'
import { z } from 'zod'
import { createAgent } from '../create-agent.ts'
import { createAgentSession } from '../session.ts'
import { createInMemoryAgentStreamStore } from '../stream.ts'
import { createTool2 } from '../create-tool2.ts'
import { collectUntil } from './helpers.ts'
import type { AgentEvent } from '../events.ts'

// A native unified tool that uses all three mid-run primitives.
const askFavorite = createTool2({
  name: 'ask_favorite',
  description: 'Ask the user for their favorite color and summarize it.',
  input: z.object({ topic: z.string() }),
  output: z.object({ color: z.string(), summary: z.string() }),
  capabilities: { elicitation: true, sampling: true },
  elicits: {
    favorite: {
      response: z.object({ value: z.string() }),
      reason: 'favorite-color',
    },
  },
  impl: function* (input, ctx) {
    yield* ctx.notify(`Asking about favorite ${input.topic}`, 0.3)

    const res = yield* ctx.elicit('favorite', {
      message: `What is your favorite ${input.topic}?`,
    })
    if (res.status !== 'accepted') {
      return { color: 'unknown', summary: `user declined` }
    }
    const color = (res.value as { value: string }).value

    const summary = yield* ctx.sample({
      prompt: `Say something nice about the color ${color} in one sentence.`,
    })

    yield* ctx.notify('Done', 1)
    return { color, summary: summary.content }
  },
})

const Agent = createAgent({
  name: 'fav',
  description: 'asks favorites',
  systemPrompt: 'you ask about favorites',
  tools: { ask_favorite: askFavorite  },
  entry: function* (_g: string, ctx) {
    return yield* ctx.tools.ask_favorite({ topic: 'color' })
  },
  model: { provider: 'mock', id: 'm1' },
  maxIterations: 1,
})

function firstRequest(events: AgentEvent[], type: 'elicit_request' | 'sample_request') {
  return events.find((e) => e.type === type) as
    | { type: 'elicit_request'; requestId: string }
    | { type: 'sample_request'; requestId: string }
    | undefined
}

describe('createTool2 E2E (native unified tool)', () => {
  it('elicits + samples + notifies through the stream via ctx.tools.X', function* () {
    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Agent, {
      contextId: 'tool2-fav',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'go' })

    // elicit
    let events = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'elicit_request'),
    )
    const e1 = firstRequest(events, 'elicit_request')!
    yield* session.send({
      type: 'respondElicit',
      requestId: e1.requestId,
      result: { status: 'accepted', value: { value: 'blue' } },
    })

    // sample
    events = yield* collectUntil(
      session,
      (e) => e.some((x) => x.type === 'sample_request'),
      events[events.length - 1]!.lsn + 1,
    )
    const s1 = firstRequest(events, 'sample_request')!
    yield* session.send({
      type: 'respondSample',
      requestId: s1.requestId,
      result: { content: 'Blue is the color of the sky on a clear day.' },
    })

    // result
    events = yield* collectUntil(
      session,
      (e) => e.some((x) => x.type === 'result'),
      events[events.length - 1]!.lsn + 1,
    )
    const result = events.find((e) => e.type === 'result') as
      | { type: 'result'; value: { result: { color: string; summary: string }; exchange: { messages: unknown[] } } }
      | undefined
    expect(result?.value.result.color).toBe('blue')
    expect(result?.value.result.summary).toContain('Blue')
    expect(result?.value.exchange.messages.length).toBeGreaterThanOrEqual(2)

    // notify events on the stream
    const buf = yield* store.getOrCreate('tool2-fav')
    const { tokens } = yield* buf.read(0)
    const allEvents = tokens.filter((e) => !(e as { command?: unknown }).command) as AgentEvent[]
    const progress = allEvents.filter((e) => e.type === 'progress') as Array<
      { type: 'progress'; message: string }
    >
    expect(progress.map((p) => p.message)).toContain('Done')
  })

  it('declined elicit → handled by the tool impl', function* () {
    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(Agent, {
      contextId: 'tool2-decline',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'go' })

    const events1 = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'elicit_request'),
    )
    const e1 = firstRequest(events1, 'elicit_request')!
    yield* session.send({
      type: 'respondElicit',
      requestId: e1.requestId,
      result: { status: 'declined', reason: 'nope' },
    })

    const events2 = yield* collectUntil(
      session,
      (e) => e.some((x) => x.type === 'result'),
      events1[events1.length - 1]!.lsn + 1,
    )
    const result = events2.find((e) => e.type === 'result') as
      | { type: 'result'; value: { result: { color: string; summary: string }; exchange: { messages: unknown[] } } }
      | undefined
    expect(result?.value.result.color).toBe('unknown')
    expect(result?.value.result.summary).toContain('declined')
  })
})
