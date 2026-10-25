import { defineJournalTool } from "@sweatpants/agent-sdk/primitive";
import { z } from "zod";
const FlightSchema = z.object({
  id: z.string(),
  airline: z.string(),
  flightNumber: z.string(),
  departure: z.string(),
  arrival: z.string(),
  duration: z.string(),
  price: z.number(),
});

const SeatMapSchema = z.object({
  rows: z.number(),
  seatsPerRow: z.array(z.string()),
  taken: z.array(z.string()),
});

// =============================================================================
// TOOL DEFINITION
// =============================================================================

export const bookFlightTool = defineJournalTool({
  sampling: true,
  name: "book_flight",
  description: "Book a flight for the user with interactive flight and seat selection",
  parameters: z.object({
    from: z.string().describe("Departure city or airport code"),
    destination: z.string().describe("Destination city or airport code"),
  }),
  elicits: {
    pickFlight: {
      response: z.object({
        flightId: z.string().describe("Selected flight ID"),
      }),
      context: z.object({
        flights: z.array(FlightSchema),
      }),
    },
    pickSeat: {
      response: z.object({
        row: z.number().describe("Selected row number"),
        seat: z.string().describe("Selected seat letter (A-F)"),
      }),
      context: z.object({
        seatMap: SeatMapSchema,
        flightInfo: z
          .object({
            airline: z.string(),
            flightNumber: z.string(),
          })
          .optional(),
      }),
    },
  },
  effects: {
    search: {
      version: "1",
      input: z.object({ from: z.string(), destination: z.string() }),
      output: z.array(FlightSchema),
      retrySafety: { mode: "repeatable" },
    },
    seats: {
      version: "1",
      input: z.object({}),
      output: SeatMapSchema,
      retrySafety: { mode: "repeatable" },
    },
    ticket: {
      version: "1",
      input: z.object({}),
      output: z.string(),
      retrySafety: { mode: "repeatable" },
    },
  },
  execute: function* (params, ctx) {
    // 1. Search for flights
    yield* ctx.notify("Searching for flights...", 0.1);
    const flights = yield* ctx.effect("search", params);

    // 2. Elicit: Pick a flight
    yield* ctx.notify("Found available flights", 0.2);

    const flightResult = yield* ctx.elicit("pickFlight", {
      message: `Select a flight from ${params.from} to ${params.destination}`,
      context: { flights },
    });

    // Handle decline/cancel
    if (flightResult.action === "decline") {
      return {
        success: false,
        reason: "user_declined_flight_selection",
        message: "Flight booking cancelled - no flight selected.",
      };
    }
    if (flightResult.action === "cancel") {
      return {
        success: false,
        reason: "user_cancelled",
        message: "Flight booking cancelled by user.",
      };
    }

    // Find the selected flight
    const selectedFlight = flights.find((f) => f.id === flightResult.content.flightId);
    if (!selectedFlight) {
      return {
        success: false,
        reason: "invalid_flight_id",
        message: "Invalid flight selection.",
      };
    }

    yield* ctx.notify("Flight selected, loading seat map...", 0.4);

    // 3. Elicit: Pick a seat
    const seatMap = yield* ctx.effect("seats", {});

    const seatResult = yield* ctx.elicit("pickSeat", {
      message: `Select your seat on ${selectedFlight.airline} ${selectedFlight.flightNumber}`,
      context: {
        seatMap,
        flightInfo: {
          airline: selectedFlight.airline,
          flightNumber: selectedFlight.flightNumber,
        },
      },
    });

    // Handle decline/cancel
    if (seatResult.action === "decline") {
      return {
        success: false,
        reason: "user_declined_seat_selection",
        message: "Flight booking cancelled - no seat selected.",
      };
    }
    if (seatResult.action === "cancel") {
      return {
        success: false,
        reason: "user_cancelled",
        message: "Flight booking cancelled by user.",
      };
    }

    const seatCode = `${seatResult.content.row}${seatResult.content.seat}`;
    yield* ctx.notify("Seat selected, finalizing booking...", 0.7);

    // 4. Sample: Get travel tip
    yield* ctx.notify("Getting travel tips...", 0.8);
    const tip = yield* ctx.sample({
      prompt: `Give a brief, helpful travel tip for someone arriving at ${params.destination} airport. Keep it to 1-2 sentences.`,
      maxTokens: 100,
    });

    // 5. Create booking
    yield* ctx.notify("Creating your booking...", 0.9);
    const ticketNumber = yield* ctx.effect("ticket", {});

    yield* ctx.notify("Booking complete!", 1.0);

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
      travelTip: tip.text ?? "",
      message: `Successfully booked ${selectedFlight.airline} ${selectedFlight.flightNumber} from ${params.from} to ${params.destination}. Seat ${seatCode}. Ticket: ${ticketNumber}`,
    };
  },
});
