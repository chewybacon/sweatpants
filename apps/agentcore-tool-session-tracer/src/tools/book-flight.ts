import { sleep } from 'effection'
import { z } from 'zod'
import { createMcpTool } from '../../../../packages/framework/src/lib/chat/mcp-tools/mcp-tool-builder.ts'

export interface Flight {
  id: string
  airline: string
  flightNumber: string
  departure: string
  arrival: string
  duration: string
  price: number
}

export interface SeatMap {
  rows: number
  seatsPerRow: string[]
  taken: string[]
}

function mockFlightSearch(_from: string, _destination: string): Flight[] {
  return [
    {
      id: 'FL001',
      airline: 'SkyHigh Airways',
      flightNumber: 'SH 142',
      departure: '08:00',
      arrival: '11:30',
      duration: '3h 30m',
      price: 299,
    },
    {
      id: 'FL002',
      airline: 'CloudAir',
      flightNumber: 'CA 287',
      departure: '12:45',
      arrival: '16:00',
      duration: '3h 15m',
      price: 349,
    },
    {
      id: 'FL003',
      airline: 'JetStream',
      flightNumber: 'JS 901',
      departure: '18:30',
      arrival: '22:00',
      duration: '3h 30m',
      price: 249,
    },
  ]
}

function mockSeatMap(): SeatMap {
  return {
    rows: 10,
    seatsPerRow: ['A', 'B', 'C', 'D', 'E', 'F'],
    taken: ['1A', '1B', '2C', '3D', '4A', '4B', '4C', '5F', '6A', '7B', '8C', '9D', '10E'],
  }
}

function generateTicketNumber(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let result = 'TKT-'
  for (let i = 0; i < 8; i += 1) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

const FlightSchema = z.object({
  id: z.string(),
  airline: z.string(),
  flightNumber: z.string(),
  departure: z.string(),
  arrival: z.string(),
  duration: z.string(),
  price: z.number(),
})

const SeatMapSchema = z.object({
  rows: z.number(),
  seatsPerRow: z.array(z.string()),
  taken: z.array(z.string()),
})

/**
 * AgentCore-hosted MCP tool that mirrors the yo-chat book-flight tool shape.
 *
 * Unlike the old tracer branch, this is a real finalized `createMcpTool()`
 * whose generator is executed by the framework bridge runtime inside
 * AgentCore. The data is still mock data, but the pause/resume mechanics are
 * the same as a generated Sweatpants MCP tool registry entry.
 */
export const bookFlightTool = createMcpTool('book_flight')
  .description('Book a flight for the user with interactive flight and seat selection')
  .parameters(
    z.object({
      from: z.string().describe('Departure city or airport code'),
      destination: z.string().describe('Destination city or airport code'),
    })
  )
  .elicits({
    pickFlight: {
      response: z.object({
        flightId: z.string().describe('Selected flight ID'),
      }),
      context: z.object({
        flights: z.array(FlightSchema),
      }),
    },
    pickSeat: {
      response: z.object({
        row: z.number().describe('Selected row number'),
        seat: z.string().describe('Selected seat letter (A-F)'),
      }),
      context: z.object({
        seatMap: SeatMapSchema,
        flightInfo: z.object({
          airline: z.string(),
          flightNumber: z.string(),
        }).optional(),
      }),
    },
  })
  .execute(function* (params, ctx) {
    yield* ctx.notify('Searching for flights...', 0.1)
    const flights = mockFlightSearch(params.from, params.destination)

    yield* ctx.notify('Found available flights', 0.2)
    yield* sleep(900)

    const flightResult = yield* ctx.elicit('pickFlight', {
      message: `Select a flight from ${params.from} to ${params.destination}`,
      flights,
    })

    if (flightResult.action === 'decline') {
      return {
        success: false,
        reason: 'user_declined_flight_selection',
        message: 'Flight booking cancelled - no flight selected.',
      }
    }
    if (flightResult.action === 'cancel') {
      return {
        success: false,
        reason: 'user_cancelled',
        message: 'Flight booking cancelled by user.',
      }
    }

    const selectedFlight = flights.find((flight) => flight.id === flightResult.content.flightId)
    if (!selectedFlight) {
      return {
        success: false,
        reason: 'invalid_flight_id',
        message: 'Invalid flight selection.',
      }
    }

    yield* ctx.notify('Flight selected, loading seat map...', 0.4)
    const seatMap = mockSeatMap()
    yield* sleep(900)

    const seatResult = yield* ctx.elicit('pickSeat', {
      message: `Select your seat on ${selectedFlight.airline} ${selectedFlight.flightNumber}`,
      seatMap,
      flightInfo: {
        airline: selectedFlight.airline,
        flightNumber: selectedFlight.flightNumber,
      },
    })

    if (seatResult.action === 'decline') {
      return {
        success: false,
        reason: 'user_declined_seat_selection',
        message: 'Flight booking cancelled - no seat selected.',
      }
    }
    if (seatResult.action === 'cancel') {
      return {
        success: false,
        reason: 'user_cancelled',
        message: 'Flight booking cancelled by user.',
      }
    }

    const seatCode = `${seatResult.content.row}${seatResult.content.seat}`
    yield* ctx.notify('Seat selected, finalizing booking...', 0.7)

    yield* ctx.notify('Getting travel tips...', 0.8)
    const tip = yield* ctx.sample({
      prompt: `Give a brief, helpful travel tip for someone arriving at ${params.destination} airport. Keep it to 1-2 sentences.`,
      maxTokens: 100,
    })

    yield* ctx.notify('Creating your booking...', 0.9)
    const ticketNumber = generateTicketNumber()

    yield* ctx.notify('Booking complete!', 1.0)

    return {
      success: true,
      ticketNumber,
      flight: {
        id: selectedFlight.id,
        airline: selectedFlight.airline,
        flightNumber: selectedFlight.flightNumber,
        departure: selectedFlight.departure,
        arrival: selectedFlight.arrival,
        duration: selectedFlight.duration,
      },
      seat: seatCode,
      price: selectedFlight.price,
      route: {
        from: params.from,
        to: params.destination,
      },
      travelTip: tip.text,
      message: `Successfully booked ${selectedFlight.airline} ${selectedFlight.flightNumber} from ${params.from} to ${params.destination}. Seat ${seatCode}. Ticket: ${ticketNumber}`,
    }
  })
