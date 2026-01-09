/**
 * Book Flight Plugin
 *
 * Provides client-side elicitation handlers for the book_flight tool.
 * Each elicitation key (pickFlight, pickSeat) has a handler that renders
 * a React component and returns the user's selection.
 */
import { makePlugin, getElicitContext, stripMessageContext } from '@sweatpants/framework/chat'
import { bookFlightTool, type Flight, type SeatMap } from './tool'
import { FlightList } from './components/FlightList'
import { SeatPicker } from './components/SeatPicker'

// =============================================================================
// CONTEXT TYPES
// =============================================================================

// Using type instead of interface to satisfy Record<string, unknown> constraint
type PickFlightContext = {
  flights: Flight[]
  [key: string]: unknown
}

type PickSeatContext = {
  seatMap: SeatMap
  flightInfo?: { airline: string; flightNumber: string }
  [key: string]: unknown
}

// =============================================================================
// PLUGIN DEFINITION
// =============================================================================

export const bookFlightPlugin = makePlugin(bookFlightTool)
  .onElicit({
    /**
     * Handler for pickFlight elicitation.
     * Renders the FlightList component and returns the selected flight ID.
     */
    pickFlight: function* (req, ctx) {
      // Extract context from x-model-context (schema or message fallback)
      const context = getElicitContext<PickFlightContext>(req)
      const flights = context.flights ?? []
      const cleanMessage = stripMessageContext(req.message)

      // Render the FlightList component and wait for user selection
      const result = yield* ctx.render(FlightList, {
        flights,
        message: cleanMessage,
      })

      // Return the selection as an accept response
      return { action: 'accept', content: result }
    },

    /**
     * Handler for pickSeat elicitation.
     * Renders the SeatPicker component and returns the selected seat.
     */
    pickSeat: function* (req, ctx) {
      // Extract context from x-model-context (schema or message fallback)
      const context = getElicitContext<PickSeatContext>(req)
      const seatMap = context.seatMap ?? { rows: 10, seatsPerRow: ['A', 'B', 'C', 'D', 'E', 'F'], taken: [] }
      const flightInfo = context.flightInfo
      const cleanMessage = stripMessageContext(req.message)

      // Build props, only including flightInfo if it exists
      const seatPickerProps = flightInfo
        ? { seatMap, message: cleanMessage, flightInfo }
        : { seatMap, message: cleanMessage }

      // Render the SeatPicker component and wait for user selection
      const result = yield* ctx.render(SeatPicker, seatPickerProps)

      // Return the selection as an accept response
      return { action: 'accept', content: result }
    },
  })
  .build()
