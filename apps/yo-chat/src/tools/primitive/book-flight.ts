import { createDurableTool } from "@sweatpants/agent-sdk";
import { z } from "zod";
import {
  BookFlightParametersSchema,
  PickFlightResponseSchema,
  PickFlightContextSchema,
  PickSeatResponseSchema,
  PickSeatContextSchema,
  FlightSchema,
  SeatMapSchema,
} from "../schemas/book-flight.ts";

const flightElicits = {
  pickFlight: { response: PickFlightResponseSchema, context: PickFlightContextSchema },
  pickSeat: { response: PickSeatResponseSchema, context: PickSeatContextSchema },
};
const flightEffects = {
  search: {
    version: "1",
    input: z.object({ from: z.string(), destination: z.string() }),
    output: z.array(FlightSchema),
    retrySafety: { mode: "repeatable" as const },
  },
  seats: {
    version: "1",
    input: z.object({}),
    output: SeatMapSchema,
    retrySafety: { mode: "repeatable" as const },
  },
  ticket: {
    version: "1",
    input: z.object({}),
    output: z.string(),
    retrySafety: { mode: "repeatable" as const },
  },
};

export const bookFlightTool = createDurableTool("book_flight", {
  version: "1",
})
  .description("Book a flight for the user with interactive flight and seat selection")
  .parameters(BookFlightParametersSchema)
  .effects(flightEffects)
  .elicits(flightElicits)
  .samples()
  .execute(function* (params, ctx) {
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
  });
