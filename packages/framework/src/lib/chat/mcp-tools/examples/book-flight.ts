/**
 * Example: Book Flight Core Tool exposed through MCP adapters.
 *
 * Tool authoring is canonical in `@sweatpants/agent-sdk`; MCP-specific code should
 * project this `ToolDefinition` at the adapter boundary instead of using a
 * separate MCP builder.
 */
import { createTool } from "@sweatpants/agent-sdk";
import { z } from "zod";

const flightSchema = z.object({
  id: z.string(),
  airline: z.string(),
  departure: z.string(),
  arrival: z.string(),
  price: z.number(),
});

type Flight = z.infer<typeof flightSchema>;

function searchFlights(_destination: string, _date: string): Flight[] {
  return [
    { id: "FL001", airline: "SkyHigh", departure: "08:00", arrival: "11:00", price: 299 },
    { id: "FL002", airline: "CloudAir", departure: "12:30", arrival: "15:30", price: 349 },
    { id: "FL003", airline: "JetStream", departure: "18:00", arrival: "21:00", price: 249 },
  ];
}

function createBooking(flightId: string, seatPreference: string) {
  return {
    confirmationNumber: `BK${Date.now().toString(36).toUpperCase()}`,
    flightId,
    seatPreference,
    status: "confirmed" as const,
  };
}

const selectionResponse = z.object({
  flightId: z.string().describe("Flight ID (e.g., FL001)"),
  seatPreference: z.enum(["window", "aisle", "middle"]).describe("Seat preference"),
});

const confirmationResponse = z.object({
  confirmed: z.boolean().describe("Confirm the booking"),
});

export const bookFlightTool = createTool("book_flight")
  .description("Search for flights and book one with user confirmation")
  .parameters(
    z.object({
      destination: z.string().describe("Destination city or airport code"),
      date: z.string().describe("Travel date (YYYY-MM-DD)"),
    }),
  )
  .output(
    z.object({
      success: z.boolean(),
      booking: z
        .object({
          confirmationNumber: z.string(),
          flightId: z.string(),
          seatPreference: z.string(),
          status: z.literal("confirmed"),
        })
        .optional(),
      reason: z.string().optional(),
      summary: z.string().optional(),
      message: z.string(),
    }),
  )
  .elicits({
    selectFlight: {
      description: "Ask the user to pick a flight and seat preference",
      context: z.object({
        destination: z.string(),
        date: z.string(),
        flights: z.array(flightSchema),
      }),
      response: selectionResponse,
    },
    confirmBooking: {
      description: "Ask the user to confirm the selected booking",
      context: z.object({
        flight: flightSchema,
        seatPreference: z.string(),
        summary: z.string(),
      }),
      response: confirmationResponse,
    },
  })
  .samples({
    summarizeBooking: {
      description: "Summarize the selected booking for confirmation",
    },
  })
  .annotate("mcp", { title: "Book flight", destructiveHint: true })
  .execute(function* (params, ctx) {
    yield* ctx.notify("Searching flights...", 0.1);
    const flights = searchFlights(params.destination, params.date);
    yield* ctx.notify("Found available flights", 0.2);

    const flightOptions = flights
      .map(
        (flight) =>
          `${flight.id}: ${flight.airline} - ${flight.departure} to ${flight.arrival} ($${flight.price})`,
      )
      .join("\n");

    const selection = yield* ctx.elicit("selectFlight", {
      message: `Available flights to ${params.destination} on ${params.date}:\n\n${flightOptions}\n\nSelect a flight and seat preference:`,
      context: { destination: params.destination, date: params.date, flights },
    });

    if (selection.action !== "accept") {
      if (selection.action === "decline") {
        yield* ctx.log("info", "User declined flight selection");
      }
      return {
        success: false,
        reason: selection.action === "decline" ? "user_declined_selection" : "user_cancelled",
        message: `Booking cancelled: ${selection.action}`,
      };
    }

    yield* ctx.notify("Processing selection...", 0.5);

    const selectedFlight = flights.find((flight) => flight.id === selection.content.flightId);
    if (!selectedFlight) {
      return {
        success: false,
        reason: "invalid_flight_id",
        message: "Booking cancelled: selected flight was not found",
      };
    }

    const summary = yield* ctx.sample("summarizeBooking", {
      prompt: `Summarize this booking: ${selectedFlight.airline} ${selectedFlight.id}, ${selectedFlight.departure}-${selectedFlight.arrival}, $${selectedFlight.price}, seat ${selection.content.seatPreference}.`,
      exchanges: [selection.exchange],
    });
    const summaryText = summary.text ?? summary.content ?? "Flight selected.";

    yield* ctx.notify("Please confirm booking", 0.8);

    const confirmation = yield* ctx.elicit("confirmBooking", {
      message: `${summaryText}\n\nConfirm this booking?`,
      context: {
        flight: selectedFlight,
        seatPreference: selection.content.seatPreference,
        summary: summaryText,
      },
    });

    if (confirmation.action !== "accept" || !confirmation.content.confirmed) {
      return {
        success: false,
        reason: confirmation.action === "accept" ? "not_confirmed" : confirmation.action,
        summary: summaryText,
        message: "Booking was not confirmed",
      };
    }

    yield* ctx.notify("Creating booking...", 0.9);

    const booking = createBooking(selection.content.flightId, selection.content.seatPreference);
    return {
      success: true,
      booking,
      summary: summaryText,
      message: `Successfully booked flight ${selection.content.flightId}. Confirmation: ${booking.confirmationNumber}`,
    };
  });
