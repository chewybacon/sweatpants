/**
 * Example: Book Flight MCP Tool
 *
 * Demonstrates a complex multi-turn MCP tool with:
 * - Server-side setup (searching flights)
 * - User elicitation (picking flight, confirming)
 * - LLM sampling (summarizing booking)
 * - Progress notifications
 *
 * This is a reference implementation showing the full power of the
 * generator-based MCP tool authoring pattern.
 */
import { z } from 'zod'
import { createMCPTool } from '../builder'

// =============================================================================
// SCHEMAS
// =============================================================================

const flightSchema = z.object({
  id: z.string(),
  airline: z.string(),
  departure: z.string(),
  arrival: z.string(),
  price: z.number(),
})

type Flight = z.infer<typeof flightSchema>

// =============================================================================
// MOCK DATA (in real implementation, this would be API calls)
// =============================================================================

function searchFlights(_destination: string, _date: string): Flight[] {
  // Simulate flight search
  return [
    { id: 'FL001', airline: 'SkyHigh', departure: '08:00', arrival: '11:00', price: 299 },
    { id: 'FL002', airline: 'CloudAir', departure: '12:30', arrival: '15:30', price: 349 },
    { id: 'FL003', airline: 'JetStream', departure: '18:00', arrival: '21:00', price: 249 },
  ]
}

function createBooking(flightId: string, seatPreference: string) {
  // Simulate booking creation
  return {
    confirmationNumber: `BK${Date.now().toString(36).toUpperCase()}`,
    flightId,
    seatPreference,
    status: 'confirmed' as const,
  }
}

// =============================================================================
// THE TOOL
// =============================================================================

/**
 * Book Flight Tool
 *
 * A multi-turn tool that:
 * 1. Searches for flights (before phase)
 * 2. Asks user to pick a flight (elicit)
 * 3. Gets LLM to summarize the choice (sample)
 * 4. Asks user to confirm (elicit)
 * 5. Creates booking (after phase)
 */
export const bookFlightTool = createMCPTool('book_flight')
  .description('Search for flights and book one with user confirmation')
  .parameters(z.object({
    destination: z.string().describe('Destination city or airport code'),
    date: z.string().describe('Travel date (YYYY-MM-DD)'),
  }))
  .requires({ elicitation: true, sampling: true })
  .handoff({
    /**
     * Phase 1: Search for flights
     *
     * This runs once on the server before any client interaction.
     * The returned data is cached and passed to both client and after phases.
     */
    *before(params, _ctx) {
      // In a real implementation, this might:
      // - Save session to database
      // - Call external flight search API
      // - Perform authorization checks

      const flights = searchFlights(params.destination, params.date)

      return {
        flights,
        destination: params.destination,
        date: params.date,
        searchedAt: new Date().toISOString(),
      }
    },

    /**
     * Client phase: Multi-turn interaction with user
     *
     * This is where the magic happens. Each yield* is a suspension point
     * that sends a request to the MCP client and waits for a response.
     */
    *client(handoff, ctx) {
      // Notify user we're starting
      yield* ctx.notify('Found available flights', 0.2)

      // Format flights for display
      const flightOptions = handoff.flights.map(f =>
        `${f.id}: ${f.airline} - ${f.departure} to ${f.arrival} ($${f.price})`
      ).join('\n')

      // First elicitation: Pick a flight
      const selection = yield* ctx.elicit({
        message: `Available flights to ${handoff.destination} on ${handoff.date}:\n\n${flightOptions}\n\nSelect a flight and seat preference:`,
        schema: z.object({
          flightId: z.string().describe('Flight ID (e.g., FL001)'),
          seatPreference: z.enum(['window', 'aisle', 'middle']).describe('Seat preference'),
        }),
      })

      // Handle user declining
      if (selection.action === 'decline') {
        yield* ctx.log('info', 'User declined flight selection')
        return {
          cancelled: true as const,
          reason: 'user_declined_selection',
        }
      }

      // Handle user cancelling (dismissing dialog)
      if (selection.action === 'cancel') {
        yield* ctx.log('info', 'User cancelled flight selection')
        return {
          cancelled: true as const,
          reason: 'user_cancelled',
        }
      }

      yield* ctx.notify('Processing selection...', 0.5)

      // Find the selected flight
      const selectedFlight = handoff.flights.find(f => f.id === selection.content.flightId)
      if (!selectedFlight) {
        return {
          cancelled: true as const,
          reason: 'invalid_flight_id',
        }
      }

      // Use sampling to generate a summary
      const summary = yield* ctx.sample({
        prompt: `Summarize this flight booking in a friendly, concise way:
          - Flight: ${selectedFlight.airline} ${selectedFlight.id}
          - Route: Departing ${selectedFlight.departure}, arriving ${selectedFlight.arrival}
          - Price: $${selectedFlight.price}
          - Seat preference: ${selection.content.seatPreference}
          - Date: ${handoff.date}
          - Destination: ${handoff.destination}`,
        maxTokens: 150,
      })

      yield* ctx.notify('Please confirm booking', 0.8)

      // Second elicitation: Confirm booking
      const confirmation = yield* ctx.elicit({
        message: `${summary}\n\nConfirm this booking?`,
        schema: z.object({
          confirmed: z.boolean().describe('Confirm the booking'),
        }),
      })

      if (confirmation.action !== 'accept' || !confirmation.content.confirmed) {
        yield* ctx.log('info', 'User did not confirm booking')
        return {
          cancelled: true as const,
          reason: 'not_confirmed',
        }
      }

      yield* ctx.notify('Creating booking...', 0.9)

      // Return successful selection for after() phase
      return {
        cancelled: false as const,
        flightId: selection.content.flightId,
        seatPreference: selection.content.seatPreference,
        summary,
      }
    },

    /**
     * Phase 2: Finalize booking
     *
     * This runs once after client interaction completes.
     * Receives the cached handoff data and client result.
     */
    *after(_handoff, client, _ctx, _params) {
      // Handle cancelled bookings
      if (client.cancelled) {
        return {
          success: false,
          reason: client.reason,
          message: `Booking cancelled: ${client.reason}`,
        }
      }

      // Create the actual booking
      const booking = createBooking(client.flightId, client.seatPreference)

      // In a real implementation, this might:
      // - Save booking to database
      // - Send confirmation email
      // - Update session status

      return {
        success: true,
        booking,
        summary: client.summary,
        message: `Successfully booked flight ${client.flightId}. Confirmation: ${booking.confirmationNumber}`,
      }
    },
  })

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type BookFlightParams = z.infer<typeof bookFlightTool.parameters>
// Note: For the result type, we infer from the after() return type
export type BookFlightResult = typeof bookFlightTool extends { handoffConfig: { after: (...args: any[]) => Generator<any, infer R> } } ? R : never
