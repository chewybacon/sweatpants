import { describe, it, expect } from '@effectionx/vitest'
import { z } from 'zod'
import { createTool } from '@sweatpants/core'
import { createAgent } from '../create-agent.ts'
import { createAgentSession } from '../session.ts'
import { createInMemoryAgentStreamStore } from '../stream.ts'
import { collectUntil } from './helpers.ts'
import type { AgentEvent } from '../events.ts'

const freshDeck = () => {
  const suits = ['hearts', 'diamonds', 'clubs', 'spades'] as const
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const
  const deck: { suit: string; rank: string }[] = []
  for (const s of suits) for (const r of ranks) deck.push({ suit: s, rank: r })
  return deck
}
let deck = freshDeck()

const drawCard = createTool('draw_card')
  .description('Draw a card from the deck')
  .parameters(z.object({ count: z.number().min(1).max(5).optional() }))
  .execute(function* ({ count = 1 }) {
    if (deck.length < count) deck = freshDeck()
    const drawn = deck.splice(0, count)
    return { cards: drawn, remainingInDeck: deck.length }
  })

const pickItem = createTool('pick_item')
  .description('Let the user pick an item, then summarize with the LLM')
  .parameters(z.object({ category: z.string() }))
  .elicits({
    'select-item': {
      context: z.object({ options: z.array(z.string()), prompt: z.string() }),
      response: z.object({ selected: z.string() }),
    },
  })
  .samples({ summarize: { output: z.object({ summary: z.string() }) } })
  .execute(function* (params, ctx) {
    const options = [`${params.category}-A`, `${params.category}-B`, `${params.category}-C`]
    const selection = yield* ctx.elicit('select-item', {
      message: `Pick a ${params.category}:`,
      context: { options, prompt: `Pick a ${params.category}:` },
    })
    if (selection.action !== 'accept') {
      return { picked: 'none', summary: 'declined', message: 'No selection.' }
    }
    const summary = yield* ctx.sample('summarize', {
      prompt: `Summarize the choice of ${selection.content.selected} in one sentence.`,
      exchanges: [selection.exchange],
    })
    const summaryText = summary.parsed?.summary ?? summary.content ?? ''
    return { picked: selection.content.selected, summary: summaryText, message: `You picked ${selection.content.selected}.` }
  })

const DrawAgent = createAgent({
  name: 'dealer',
  description: 'deals cards',
  systemPrompt: 'you deal cards',
  tools: { draw_card: drawCard },
  entry: function* (_g: string, ctx) {
    return yield* ctx.tools.draw_card({ count: 2 })
  },
  model: { provider: 'mock', id: 'm1' },
  maxIterations: 1,
})

const PickerAgent = createAgent({
  name: 'picker',
  description: 'picks items',
  systemPrompt: 'you pick items',
  tools: { pick_item: pickItem },
  entry: function* (_g: string, ctx) {
    return yield* ctx.tools.pick_item({ category: 'color' })
  },
  model: { provider: 'mock', id: 'm1' },
  maxIterations: 1,
})

function firstRequest(events: AgentEvent[], type: 'elicit_request' | 'sample_request') {
  return events.find((e) => e.type === type) as
    | { type: 'elicit_request'; requestId: string; key: string }
    | { type: 'sample_request'; requestId: string }
    | undefined
}

describe('canonical core tool E2E', () => {
  it('server-only tool: draw_card returns cards', function* () {
    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(DrawAgent, { contextId: 'iso-draw', store })
    yield* session.send({ type: 'sendMessage', message: 'deal' })
    const events = yield* collectUntil(session, (e) => e.some((x) => x.type === 'result'))
    const result = events.find((e) => e.type === 'result') as
      | { type: 'result'; value: { result: { cards: { suit: string; rank: string }[]; remainingInDeck: number }; exchange: { messages: unknown[] } } }
      | undefined
    expect(result?.value.result.cards).toHaveLength(2)
    expect(result?.value.result.remainingInDeck).toBe(50)
    expect(result?.value.exchange.messages).toHaveLength(2)
  })

  it('declared elicit + named sample flow through the stream', function* () {
    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(PickerAgent, { contextId: 'iso-picker', store })
    yield* session.send({ type: 'sendMessage', message: 'pick' })

    let events = yield* collectUntil(session, (e) => e.some((x) => x.type === 'elicit_request'))
    const e1 = firstRequest(events, 'elicit_request')!
    expect(e1.key).toBe('select-item')
    yield* session.send({
      type: 'respondElicit',
      requestId: e1.requestId,
      result: { status: 'accepted', value: { selected: 'color-B' } },
    })

    events = yield* collectUntil(
      session,
      (e) => e.some((x) => x.type === 'sample_request'),
      events[events.length - 1]!.lsn + 1,
    )
    const s1 = firstRequest(events, 'sample_request')!
    yield* session.send({
      type: 'respondSample',
      requestId: s1.requestId,
      result: { content: 'color-B is bold and bright.' },
    })

    events = yield* collectUntil(
      session,
      (e) => e.some((x) => x.type === 'result'),
      events[events.length - 1]!.lsn + 1,
    )
    const result = events.find((e) => e.type === 'result') as
      | { type: 'result'; value: { result: { picked: string; summary: string; message: string }; exchange: { messages: unknown[] } } }
      | undefined
    expect(result?.value.result.picked).toBe('color-B')
    expect(result?.value.result.summary).toContain('color-B')
    expect(result?.value.result.message).toContain('color-B')
  })
})
