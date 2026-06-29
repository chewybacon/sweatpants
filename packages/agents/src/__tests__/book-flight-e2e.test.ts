import { describe, it, expect } from '@effectionx/vitest'
import { bookFlightTool } from '../../../framework/src/lib/chat/mcp-tools/examples/book-flight.ts'
import { createAgent } from '../create-agent.ts'
import { createAgentSession } from '../session.ts'
import { createInMemoryAgentStreamStore } from '../stream.ts'
import { collectUntil } from './helpers.ts'
import type { AgentEvent } from '../events.ts'

const TravelAgent = createAgent({
  name: 'travel',
  description: 'Travel planner',
  systemPrompt: 'You plan trips.',
  tools: { book_flight: bookFlightTool },
  entry: function* (_goal: string, ctx) {
    return yield* ctx.tools.book_flight({
      destination: 'NYC',
      date: '2024-06-15',
    })
  },
  model: { provider: 'mock', id: 'm1' },
  maxIterations: 1,
})

function findRequests(events: AgentEvent[], type: 'elicit_request' | 'sample_request') {
  return events.filter((e) => e.type === type) as Array<
    { type: 'elicit_request'; requestId: string; key: string; message: string } |
    { type: 'sample_request'; requestId: string }
  >
}

describe('Book Flight E2E (canonical core tool model)', () => {
  it('happy path: complete booking when user confirms', function* () {
    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(TravelAgent, {
      contextId: 'book-flight-happy',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'plan a trip' })

    let events = yield* collectUntil(session, (e) => e.some((x) => x.type === 'elicit_request'))
    const elic = findRequests(events, 'elicit_request')[0]!
    yield* session.send({
      type: 'respondElicit',
      requestId: elic.requestId,
      result: { status: 'accepted', value: { flightId: 'FL001', seatPreference: 'window' } },
    })

    events = yield* collectUntil(
      session,
      (e) => e.some((x) => x.type === 'sample_request'),
      events[events.length - 1]!.lsn + 1,
    )
    const samp = findRequests(events, 'sample_request')[0]!
    yield* session.send({
      type: 'respondSample',
      requestId: samp.requestId,
      result: { content: 'Your SkyHigh flight FL001 departs at 08:00. Window seat.' },
    })

    events = yield* collectUntil(
      session,
      (e) => e.some((x) => x.type === 'elicit_request'),
      events[events.length - 1]!.lsn + 1,
    )
    const elic2 = findRequests(events, 'elicit_request')[0]!
    yield* session.send({
      type: 'respondElicit',
      requestId: elic2.requestId,
      result: { status: 'accepted', value: { confirmed: true } },
    })

    events = yield* collectUntil(
      session,
      (e) => e.some((x) => x.type === 'result'),
      events[events.length - 1]!.lsn + 1,
    )
    const result = events.find((e) => e.type === 'result') as
      | { type: 'result'; value: { result: { success: boolean; booking?: { flightId: string; seatPreference: string; confirmationNumber: string }; message: string }; exchange: { messages: unknown[] } } }
      | undefined

    expect(result?.value.result.success).toBe(true)
    expect(result?.value.result.booking?.flightId).toBe('FL001')
    expect(result?.value.result.booking?.seatPreference).toBe('window')
    expect(result?.value.result.booking?.confirmationNumber).toBeDefined()
    expect(result?.value.result.message).toContain('Successfully booked')
    expect(result?.value.exchange.messages.length).toBeGreaterThanOrEqual(2)

    const buf = yield* store.getOrCreate('book-flight-happy')
    const { tokens: allLogs } = yield* buf.read(0)
    const allEvents = allLogs.filter((e) => !(e as { command?: unknown }).command) as AgentEvent[]
    const messages = allEvents
      .filter((e) => e.type === 'progress')
      .map((p) => (p as { type: 'progress'; message: string }).message)
    expect(messages).toContain('Found available flights')
    expect(messages).toContain('Processing selection...')
    expect(messages).toContain('Please confirm booking')
    expect(messages).toContain('Creating booking...')
  })

  it('decline at flight selection → cancelled with reason', function* () {
    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(TravelAgent, {
      contextId: 'book-flight-decline',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'plan a trip' })

    const events1 = yield* collectUntil(session, (e) => e.some((x) => x.type === 'elicit_request'))
    const elic = findRequests(events1, 'elicit_request')[0]!
    yield* session.send({
      type: 'respondElicit',
      requestId: elic.requestId,
      result: { status: 'declined', reason: 'no thanks' },
    })

    const events2 = yield* collectUntil(
      session,
      (e) => e.some((x) => x.type === 'result'),
      events1[events1.length - 1]!.lsn + 1,
    )
    const result = events2.find((e) => e.type === 'result') as
      | { type: 'result'; value: { result: { success: boolean; reason: string }; exchange: { messages: unknown[] } } }
      | undefined
    expect(result?.value.result.success).toBe(false)
    expect(result?.value.result.reason).toBe('user_declined_selection')
  })

  it('invalid flight id → graceful cancellation', function* () {
    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(TravelAgent, {
      contextId: 'book-flight-invalid',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'plan a trip' })

    const events1 = yield* collectUntil(session, (e) => e.some((x) => x.type === 'elicit_request'))
    const elic = findRequests(events1, 'elicit_request')[0]!
    yield* session.send({
      type: 'respondElicit',
      requestId: elic.requestId,
      result: { status: 'accepted', value: { flightId: 'INVALID', seatPreference: 'window' } },
    })

    const events2 = yield* collectUntil(
      session,
      (e) => e.some((x) => x.type === 'result'),
      events1[events1.length - 1]!.lsn + 1,
    )
    const result = events2.find((e) => e.type === 'result') as
      | { type: 'result'; value: { result: { success: boolean; reason: string }; exchange: { messages: unknown[] } } }
      | undefined
    expect(result?.value.result.success).toBe(false)
    expect(result?.value.result.reason).toBe('invalid_flight_id')
  })
})
