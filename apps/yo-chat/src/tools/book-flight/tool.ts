/**
 * Book Flight Tool (MCP Plugin Pattern)
 *
 * Demonstrates the new MCP plugin tool pattern with:
 * - Server-side tool execution
 * - Client-side elicitation handlers with React UI
 * - Multi-step user interaction (flight selection, seat selection)
 * - LLM sampling for travel tips
 */
import { z } from "zod";
import { createMcpTool } from "@sweatpants/framework/chat";
import { sleep, type Operation } from "effection";

// =============================================================================
// TYPES
// =============================================================================

export interface Flight {
  id: string;
  airline: string;
  flightNumber: string;
  departure: string;
  arrival: string;
  duration: string;
  price: number;
}

export interface SeatMap {
  rows: number;
  seatsPerRow: string[];
  taken: string[]; // e.g., ['1A', '2C', '5F']
}

// =============================================================================
// MOCK DATA
// =============================================================================

function mockFlightSearch(_from: string, _destination: string): Flight[] {
  // Simulate flight search - in production this would call an API
  return [
    {
      id: "FL001",
      airline: "SkyHigh Airways",
      flightNumber: "SH 142",
      departure: "08:00",
      arrival: "11:30",
      duration: "3h 30m",
      price: 299,
    },
    {
      id: "FL002",
      airline: "CloudAir",
      flightNumber: "CA 287",
      departure: "12:45",
      arrival: "16:00",
      duration: "3h 15m",
      price: 349,
    },
    {
      id: "FL003",
      airline: "JetStream",
      flightNumber: "JS 901",
      departure: "18:30",
      arrival: "22:00",
      duration: "3h 30m",
      price: 249,
    },
  ];
}

function mockSeatMap(): SeatMap {
  return {
    rows: 10,
    seatsPerRow: ["A", "B", "C", "D", "E", "F"],
    taken: ["1A", "1B", "2C", "3D", "4A", "4B", "4C", "5F", "6A", "7B", "8C", "9D", "10E"],
  };
}

function generateTicketNumber(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "TKT-";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const record = part as Record<string, unknown>;
      return typeof record["text"] === "string" ? record["text"] : "";
    })
    .filter(Boolean)
    .join(" ");
}

function inferRouteFromText(text: string): Partial<BookFlightParams> {
  const fromToMatch = /\bfrom\s+(.+?)\s+to\s+([^.!?]+)(?:[.!?]|$)/i.exec(text);
  if (fromToMatch?.[1] && fromToMatch[2]) {
    return {
      from: fromToMatch[1].trim(),
      destination: fromToMatch[2].trim(),
    };
  }

  const airportMatch = /\b([A-Z]{3})\s*(?:to|→|-)\s*([A-Z]{3})\b/.exec(text);
  if (airportMatch?.[1] && airportMatch[2]) {
    return {
      from: airportMatch[1],
      destination: airportMatch[2],
    };
  }

  return {};
}

function inferRouteFromContext(ctx: BookFlightContext): Partial<BookFlightParams> {
  const messages = ctx.parentMessages ?? ctx.messages ?? [];
  for (const message of [...messages].reverse()) {
    const text = contentToText(message.content);
    const route = inferRouteFromText(text);
    if (route.from || route.destination) {
      return route;
    }
  }
  return {};
}

function normalizeBookFlightParams(
  params: Partial<BookFlightParams>,
  ctx: BookFlightContext,
): BookFlightParams {
  const inferred = inferRouteFromContext(ctx);
  return {
    from: params.from?.trim() || inferred.from || "NYC",
    destination: params.destination?.trim() || inferred.destination || "LAX",
  };
}

// =============================================================================
// SCHEMAS
// =============================================================================

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

type BookFlightParams = {
  from: string;
  destination: string;
};

type BookFlightElicitResult<TContent> =
  | { action: "accept"; content: TContent }
  | { action: "decline" }
  | { action: "cancel" };

type BookFlightContext = {
  parentMessages?: readonly { content?: unknown }[];
  messages?: readonly { content?: unknown }[];
  notify(message: string, progress: number): Operation<void>;
  elicit(
    key: "pickFlight",
    request: { message: string; flights: Flight[] },
  ): Operation<BookFlightElicitResult<{ flightId: string }>>;
  elicit(
    key: "pickSeat",
    request: {
      message: string;
      seatMap: SeatMap;
      flightInfo: { airline: string; flightNumber: string };
    },
  ): Operation<BookFlightElicitResult<{ row: number; seat: string }>>;
  sample(request: { prompt: string; maxTokens: number }): Operation<{ text: string }>;
};

export const bookFlightTool = createMcpTool("book_flight")
  .description("Book a flight for the user with interactive flight and seat selection")
  .parameters(
    z.object({
      from: z.string().describe("Departure city or airport code"),
      destination: z.string().describe("Destination city or airport code"),
    }),
  )
  .elicits({
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
  })
  .execute(function* (rawParams: Partial<BookFlightParams> = {}, ctx: unknown) {
    const bookFlightCtx = ctx as BookFlightContext;
    const params = normalizeBookFlightParams(rawParams, bookFlightCtx);

    // 1. Search for flights
    yield* bookFlightCtx.notify("Searching for flights...", 0.1);
    const flights = mockFlightSearch(params.from, params.destination);

    // 2. Elicit: Pick a flight
    yield* bookFlightCtx.notify("Found available flights", 0.2);

    yield* sleep(900); // mock request

    const flightResult = yield* bookFlightCtx.elicit("pickFlight", {
      message: `Select a flight from ${params.from} to ${params.destination}`,
      flights,
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

    yield* bookFlightCtx.notify("Flight selected, loading seat map...", 0.4);

    // 3. Elicit: Pick a seat
    const seatMap = mockSeatMap();

    yield* sleep(900); // mock request

    const seatResult = yield* bookFlightCtx.elicit("pickSeat", {
      message: `Select your seat on ${selectedFlight.airline} ${selectedFlight.flightNumber}`,
      seatMap,
      flightInfo: {
        airline: selectedFlight.airline,
        flightNumber: selectedFlight.flightNumber,
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
    yield* bookFlightCtx.notify("Seat selected, finalizing booking...", 0.7);

    // 4. Sample: Get travel tip
    yield* bookFlightCtx.notify("Getting travel tips...", 0.8);
    const tip = yield* bookFlightCtx.sample({
      prompt: `Give a brief, helpful travel tip for someone arriving at ${params.destination} airport. Keep it to 1-2 sentences.`,
      maxTokens: 100,
    });

    // 5. Create booking
    yield* bookFlightCtx.notify("Creating your booking...", 0.9);
    const ticketNumber = generateTicketNumber();

    yield* bookFlightCtx.notify("Booking complete!", 1.0);

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
    };
  });

// Result type - union of success and failure cases
export type BookFlightResult =
  | {
      success: true;
      ticketNumber: string;
      flight: {
        id: string;
        airline: string;
        flightNumber: string;
        departure: string;
        arrival: string;
        duration: string;
      };
      seat: string;
      price: number;
      route: { from: string; to: string };
      travelTip: string;
      message: string;
    }
  | {
      success: false;
      reason: string;
      message: string;
    };
