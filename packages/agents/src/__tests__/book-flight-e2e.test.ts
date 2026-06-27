/**
 * Book Flight E2E — the unified tool model proof.
 *
 * A `createMCPTool` handoff tool (before/client/after with elicit + sample +
 * notify) is registered directly on an agent and called from the agent's
 * `ctx.tools.bookFlight(...)` via the unified callable runtime shape. The
 * handoff lifecycle runs as a coroutine; the client phase's `ctx.elicit` /
 * `ctx.sample` calls flow through the stream as `elicit_request` /
 * `sample_request` events and are fulfilled by `session.send` — proving the
 * unified model end-to-end (design DD3, REQ-014/015).
 */
import { describe, it, expect } from '@effectionx/vitest'
import { z } from 'zod'
import { createMCPTool } from '@sweatpants/framework/chat/mcp-tools'
import { createAgent } from '../create-agent.ts'
import { createAgentSession } from '../session.ts'
import { createInMemoryAgentStreamStore } from '../stream.ts'
import { collectUntil } from './helpers.ts'
import type { AgentEvent } from '../events.ts'

// --- The tool (from the framework's book-flight example, inlined minimal) ---

const flightSchema = z.object({
  id: z.string(),
  airline: z.string(),
  departure: z.string(),
  arrival: z.string(),
  price: z.number(),
})
type Flight = z.infer<typeof flightSchema>

function searchFlights(_dest: string, _date: string): Flight[] {
  return [
    { id: 'FL001', airline: 'SkyHigh', departure: '08:00', arrival: '11:00', price: 299 },
    { id: 'FL002', airline: 'CloudAir', departure: '12:30', arrival: '15:30', price: 349 },
    { id: 'FL003', airline: 'JetStream', departure: '18:00', arrival: '21:00', price: 249 },
  ]
}

function createBooking(flightId: string, seatPreference: string) {
  return {
    confirmationNumber: `BK${Date.now().toString(36).toUpperCase()}`,
    flightId,
    seatPreference,
    status: 'confirmed' as const,
  }
}

const bookFlightMCP = createMCPTool('book_flight')
  .description('Search for flights and book one with user confirmation')
  .parameters(
    z.object({
      destination: z.string(),
      date: z.string(),
    }),
  )
  .requires({ elicitation: true, sampling: true })
  .handoff({
    *before(params) {
      const flights = searchFlights(params.destination, params.date)
      return { flights, destination: params.destination, date: params.date }
    },
    *client(handoff, ctx) {
      yield* ctx.notify('Found available flights', 0.2)

      const flightOptions = handoff.flights
        .map((f: Flight) => `${f.id}: ${f.airline} - ${f.departure} to ${f.arrival} ($${f.price})`)
        .join('\n')

      const selection = yield* ctx.elicit({
        message: `Available flights to ${handoff.destination} on ${handoff.date}:\n\n${flightOptions}\n\nSelect a flight and seat preference:`,
        schema: z.object({
          flightId: z.string(),
          seatPreference: z.enum(['window', 'aisle', 'middle']),
        }),
      })

      if (selection.action !== 'accept') {
        return {
          cancelled: true as const,
          reason:
            selection.action === 'decline'
              ? 'user_declined_selection'
              : 'user_cancelled',
        }
      }

      yield* ctx.notify('Processing selection...', 0.5)

      const selectedFlight = handoff.flights.find(
        (f: Flight) => f.id === selection.content.flightId,
      )
      if (!selectedFlight) {
        return { cancelled: true as const, reason: 'invalid_flight_id' }
      }

      const summary = yield* ctx.sample({
        prompt: `Summarize: ${selectedFlight.airline} ${selectedFlight.id}, $${selectedFlight.price}, ${selection.content.seatPreference} seat`,
        maxTokens: 150,
      })

      yield* ctx.notify('Please confirm booking', 0.8)

      const confirmation = yield* ctx.elicit({
        message: `${summary}\n\nConfirm this booking?`,
        schema: z.object({ confirmed: z.boolean() }),
      })

      if (confirmation.action !== 'accept' || !confirmation.content.confirmed) {
        return { cancelled: true as const, reason: 'not_confirmed' }
      }

      yield* ctx.notify('Creating booking...', 0.9)

      return {
        cancelled: false as const,
        flightId: selection.content.flightId,
        seatPreference: selection.content.seatPreference,
        summary,
      }
    },
    *after(_handoff, client) {
      if (client.cancelled) {
        return { success: false, reason: client.reason, message: `Booking cancelled: ${client.reason}` }
      }
      const booking = createBooking(client.flightId, client.seatPreference)
      return {
        success: true,
        booking,
        summary: client.summary,
        message: `Successfully booked flight ${client.flightId}. Confirmation: ${booking.confirmationNumber}`,
      }
    },
  })

// --- The agent (tool used directly through unified runtime) ---

const TravelAgent = createAgent({
  name: 'travel',
  description: 'Travel planner',
  systemPrompt: 'You plan trips.',
  tools: { book_flight: bookFlightMCP },
  entry: function* (_goal: string, ctx) {
    const result = yield* ctx.tools.book_flight({
      destination: 'NYC',
      date: '2024-06-15',
    })
    return result
  },
  model: { provider: 'mock', id: 'm1' },
  maxIterations: 1,
})

// --- Helpers for fulfilling stream requests in order ---

function findRequests(events: AgentEvent[], type: 'elicit_request' | 'sample_request') {
  return events.filter((e) => e.type === type) as Array<
    { type: 'elicit_request'; requestId: string; key: string; message: string } |
    { type: 'sample_request'; requestId: string }
  >
}

describe('Book Flight E2E (unified tool model)', () => {
  it('happy path: complete booking when user confirms', function* () {
    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(TravelAgent, {
      contextId: 'book-flight-happy',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'plan a trip' })

    // Drive the handoff lifecycle by fulfilling stream requests in order.
    // 1st elicit: flight selection
    let events = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'elicit_request'),
    )
    let elic = findRequests(events, 'elicit_request')[0]!
    yield* session.send({
      type: 'respondElicit',
      requestId: elic.requestId,
      result: { status: 'accepted', value: { flightId: 'FL001', seatPreference: 'window' } },
    })

    // sample: summary
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

    // 2nd elicit: confirmation (from the new window, there's 1 elicit_request)
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

    // Result
    events = yield* collectUntil(
      session,
      (e) => e.some((x) => x.type === 'result'),
      events[events.length - 1]!.lsn + 1,
    )
    const result = events.find((e) => e.type === 'result') as
      | {
          type: 'result'
          value: {
            result: {
              success: boolean
              booking?: { flightId: string; seatPreference: string; confirmationNumber: string }
              message: string
            }
            exchange: { messages: unknown[] }
          }
        }
      | undefined

    expect(result?.value.result.success).toBe(true)
    expect(result?.value.result.booking?.flightId).toBe('FL001')
    expect(result?.value.result.booking?.seatPreference).toBe('window')
    expect(result?.value.result.booking?.confirmationNumber).toBeDefined()
    expect(result?.value.result.message).toContain('Successfully booked')
    expect(result?.value.exchange.messages.length).toBeGreaterThanOrEqual(2)

    // Collect ALL progress events from the whole stream by reading the buffer.
    const buf = yield* store.getOrCreate('book-flight-happy')
    const { tokens: allLogs } = yield* buf.read(0)
    const allEvents = allLogs.filter((e) => !(e as { command?: unknown }).command) as AgentEvent[]
    const progress = allEvents.filter((e) => e.type === 'progress') as Array<
      { type: 'progress'; message: string }
    >
    const messages = progress.map((p) => p.message)
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

    const events1 = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'elicit_request'),
    )
    const elic = findRequests(events1, 'elicit_request')[0]!
    yield* session.send({
      type: 'respondElicit',
      requestId: elic.requestId,
      result: { status: 'declined', reason: 'user declined' },
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

  it('invalid flight id → cancelled with reason', function* () {
    const store = createInMemoryAgentStreamStore()
    const session = yield* createAgentSession(TravelAgent, {
      contextId: 'book-flight-invalid',
      store,
    })
    yield* session.send({ type: 'sendMessage', message: 'plan a trip' })

    const events1 = yield* collectUntil(session, (e) =>
      e.some((x) => x.type === 'elicit_request'),
    )
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
