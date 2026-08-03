/**
 * Book Flight Plugin
 *
 * Provides client-side elicitation handlers for the book_flight tool.
 * Each elicitation key (pickFlight, pickSeat) has a handler that renders
 * a React component and returns the user's selection.
 */
import { makePlugin } from "@sweatpants/react-chat";
import { bookFlightTool } from "./tool";
import { FlightList } from "./components/FlightList";
import { SeatPicker } from "./components/SeatPicker";

// =============================================================================
// PLUGIN DEFINITION
// =============================================================================

export const bookFlightPlugin = makePlugin(bookFlightTool)
  .onElicit({
    /**
     * Handler for pickFlight elicitation.
     * Renders the FlightList component and returns the selected flight ID.
     */
    pickFlight: function* (input, ctx) {
      const { flights } = input.context;
      const cleanMessage = input.message;

      // Render the FlightList component and wait for user selection
      const result = yield* ctx.render(FlightList, {
        flights,
        message: cleanMessage,
      });

      // Return the selection as an accept response
      return { action: "accept", content: result };
    },

    /**
     * Handler for pickSeat elicitation.
     * Renders the SeatPicker component and returns the selected seat.
     */
    pickSeat: function* (input, ctx) {
      const { seatMap, flightInfo } = input.context;
      const cleanMessage = input.message;

      // Build props, only including flightInfo if it exists
      const seatPickerProps = flightInfo
        ? { seatMap, message: cleanMessage, flightInfo }
        : { seatMap, message: cleanMessage };

      // Render the SeatPicker component and wait for user selection
      const result = yield* ctx.render(SeatPicker, seatPickerProps);

      // Return the selection as an accept response
      return { action: "accept", content: result };
    },
  })
  .build();
