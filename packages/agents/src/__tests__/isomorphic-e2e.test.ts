/**
 * Isomorphic tool E2E — the unified tool model applied to `createIsomorphicTool`.
 *
 * Two cases exercised end-to-end through `createAgentSession`:
 *  1. A **server-only** tool (card-game `draw_card`) — `ctx.tools.draw_card(...)`
 *     runs `server(params, serverCtx)` and returns.
 *  2. A **handoff** tool with a browser `client()` phase using `waitFor` +
 *     `prompt` — the client phase's `waitFor`/`prompt` are shimmed onto
 *     `ToolCtx` (elicit/sample) and flow through the stream, fulfilled by
 *     `session.send` (design DD3/DD4).
 */
import { describe, it, expect } from '@effectionx/vitest'
import type { Operation } from 'effection'
import { z } from 'zod'
import { createIsomorphicTool } from '@sweatpants/framework/chat/isomorphic-tools'
import { createAgent } from '../create-agent.ts'
import { createAgentSession } from '../session.ts'
import { createInMemoryAgentStreamStore } from '../stream.ts'
import { collectUntil } from './helpers.ts'
import type { AgentEvent } from '../events.ts'

// --- Server-only tool (mirrors card-game draw_card, self-contained) ---------

const freshDeck = () => {
  const suits = ['hearts', 'diamonds', 'clubs', 'spades'] as const
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const
  const deck: { suit: string; rank: string }[] = []
  for (const s of suits) for (const r of ranks) deck.push({ suit: s, rank: r })
  return deck
}
let deck = freshDeck()

const drawCardIso = createIsomorphicTool('draw_card')
  .description('Draw a card from the deck')
  .parameters(z.object({ count: z.number().min(1).max(5).optional() }))
  .context('headless')
  .server(function* ({ count = 1 }) {
    if (deck.length < count) deck = freshDeck()
    const drawn = deck.splice(0, count)
    return { cards: drawn, remainingInDeck: deck.length }
  })
  .build()

const drawCard = drawCardIso 

// --- Handoff tool: browser client phase with waitFor + prompt ---------------

const pickerIso = createIsomorphicTool('pick_item')
  .description('Let the user pick an item, then summarize with the LLM')
  .parameters(z.object({ category: z.string() }))
  .context('browser')
  .handoff({
    *before(params) {
      const options = [
        `${params.category}-A`,
        `${params.category}-B`,
        `${params.category}-C`,
      ]
      return { options, category: params.category }
    },
    *client(handoff, ctx) {
      // The unified shim provides waitFor + prompt regardless of contextMode;
      // cast to access both (browser has waitFor, agent has prompt; the unified
      // runtime supplies both via the ToolCtx projection).
      const c = ctx as unknown as {
        waitFor: <TP, TR>(type: string, payload: TP) => Operation<TR>
        prompt: <T>(opts: { prompt: string; schema?: unknown }) => Operation<T>
      }
      // waitFor → elicit("select-item", { options })
      const selection = (yield* c.waitFor('select-item', {
        options: handoff.options,
        prompt: `Pick a ${handoff.category}:`,
      })) as { selected: string }
      // prompt → sample (LLM summarize)
      const summary = (yield* c.prompt({
        prompt: `Summarize the choice of ${selection.selected} in one sentence.`,
        schema: z.object({ summary: z.string() }),
      })) as string
      return { selected: selection.selected, summary }
    },
    *after(_handoff, client) {
      return { picked: client.selected, summary: client.summary, message: `You picked ${client.selected}.` }
    },
  })

const pickItem = pickerIso 

// --- Agents -----------------------------------------------------------------

const DrawAgent = createAgent({
  name: 'dealer',
  description: 'deals cards',
  systemPrompt: 'you deal cards',
  tools: { draw_card: drawCard  },
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
  tools: { pick_item: pickItem  },
  entry: function* (_g: string, ctx) {
    return yield* ctx.tools.pick_item({ category: 'color' })
  },
  model: { provider: 'mock', id: 'm1' },
  maxIterations: 1,
})

// --- helpers ----------------------------------------------------------------

function firstRequest(events: AgentEvent[], type: 'elicit_request' | 'sample_request') {
  return events.find((e) => e.type === type) as
    | { type: 'elicit_request'; requestId: string; key: string }
    | { type: 'sample_request'; requestId: string }
    | undefined
}

describe('Isomorphic tool E2E (unified tool model)', () => {
  it('server-only tool: draw_card returns cards', function* () {
    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(DrawAgent, {
      contextId: 'iso-draw',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'draw' })
    const events = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'result'),
    )
    const result = events.find((e) => e.type === 'result') as
      | {
          type: 'result'
          value: { result: { cards: { suit: string; rank: string }[]; remainingInDeck: number }; exchange: { messages: unknown[] } }
        }
      | undefined
    expect(result?.value.result.cards).toHaveLength(2)
    expect(result?.value.result.remainingInDeck).toBe(50)
    expect(result?.value.exchange.messages).toHaveLength(2)
    // A tool_call_start/result should bracket the invocation.
    expect(events.some((e) => e.type === 'tool_call_start')).toBe(true)
    expect(events.some((e) => e.type === 'tool_call_result')).toBe(true)
  })

  it('handoff tool: waitFor + prompt flow through the stream', function* () {
    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(PickerAgent, {
      contextId: 'iso-pick',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'pick' })

    // 1st request: waitFor("select-item", …) → elicit_request keyed "select-item"
    let events = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'elicit_request'),
    )
    const e1 = firstRequest(events, 'elicit_request') as
      | { type: 'elicit_request'; requestId: string; key: string }
      | undefined
    expect(e1?.key).toBe('select-item')
    yield* session.send({
      type: 'respondElicit',
      requestId: e1!.requestId,
      result: { status: 'accepted', value: { selected: 'color-B' } },
    })

    // 2nd request: prompt(…) → sample_request
    events = yield* collectUntil(
      session,
      (e) => e.some((x) => x.type === 'sample_request'),
      events[events.length - 1]!.lsn + 1,
    )
    const s1 = firstRequest(events, 'sample_request')!
    yield* session.send({
      type: 'respondSample',
      requestId: s1.requestId,
      result: { content: 'A bold choice of color-B.' },
    })

    // Result
    events = yield* collectUntil(
      session,
      (e) => e.some((x) => x.type === 'result'),
      events[events.length - 1]!.lsn + 1,
    )
    const result = events.find((e) => e.type === 'result') as
      | {
          type: 'result'
          value: { result: { picked: string; summary: string; message: string }; exchange: { messages: unknown[] } }
        }
      | undefined
    expect(result?.value.result.picked).toBe('color-B')
    expect(result?.value.result.summary).toContain('color-B')
    expect(result?.value.result.message).toContain('color-B')
  })
})
