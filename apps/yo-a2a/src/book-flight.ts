import { createDurableTool, defineEffect, effectRuntimeValidators } from "@sweatpants/core";
import { createDurableEffectRegistration } from "@sweatpants/framework/server";
import { z } from "zod";

/**
 * Journal-native book_flight: the degenerate multi-elicit workflow.
 * Two effects (search, reserve) interleaved with two elicitations
 * (pick flight, pick seat). Process death between the elicitations is
 * the seam this tool exists to certify (validation-matrix G2).
 */

const FlightSchema = z.object({
  id: z.string(),
  airline: z.string(),
  flightNumber: z.string(),
  departure: z.string(),
  arrival: z.string(),
  price: z.number(),
});

const SeatMapSchema = z.object({
  rows: z.number().int().min(1).max(20),
  seatsPerRow: z.array(z.string()).min(1),
  taken: z.array(z.string()),
});

const searchFlights = defineEffect({
  name: "yo-a2a.flights.search",
  version: "1",
  input: z.object({ from: z.string().min(1), destination: z.string().min(1) }),
  output: z.object({ flights: z.array(FlightSchema).min(1) }),
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

const reserveSeat = defineEffect({
  name: "yo-a2a.flights.reserve",
  version: "1",
  input: z.object({ flightId: z.string(), seat: z.string() }),
  output: z.object({ ticketNumber: z.string() }),
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

export const bookFlight = createDurableTool("book_flight", { version: "1.0.0" })
  .description("Search flights, durably wait for a flight choice, then a seat choice, then reserve")
  .parameters(
    z.object({
      from: z.string().min(1).describe("Departure city or airport code"),
      destination: z.string().min(1).describe("Destination city or airport code"),
    }),
  )
  .output(
    z.object({
      booked: z.boolean(),
      message: z.string(),
      ticketNumber: z.string(),
    }),
  )
  .elicits({
    pickFlight: {
      response: z.string().min(1).max(16).describe("The 1-based flight number, for example: 1"),
      context: z.object({ flights: z.array(FlightSchema) }),
    },
    pickSeat: {
      response: z
        .string()
        .regex(/^\d{1,2}[A-F]$/)
        .describe("The seat, for example: 3C"),
      context: z.object({ seatMap: SeatMapSchema, flight: FlightSchema }),
    },
  })
  .effects({ [searchFlights.name]: searchFlights, [reserveSeat.name]: reserveSeat })
  .execute(function* (input, context) {
    const { flights } = yield* context.effect(searchFlights, {
      from: input.from,
      destination: input.destination,
    });
    const choices = flights
      .map(
        (flight, index) =>
          `${index + 1}. ${flight.airline} ${flight.flightNumber} ` +
          `${flight.departure}-${flight.arrival} $${flight.price}`,
      )
      .join("\n");
    const flightChoice = yield* context.elicit("pickFlight", {
      message: `I found ${flights.length} flights from ${input.from} to ${input.destination}. Pick one:\n\n${choices}`,
      context: { flights },
    });
    if (flightChoice.action !== "accept") {
      return {
        booked: false,
        ticketNumber: "",
        message: "Flight booking was declined before selection.",
      };
    }
    const flight = flights[Number.parseInt(flightChoice.content.trim(), 10) - 1];
    if (!flight) {
      throw new Error("The selected flight number was not one of the offered flights");
    }
    const seatMap = staticSeatMap();
    const seatChoice = yield* context.elicit("pickSeat", {
      message:
        `Selected ${flight.airline} ${flight.flightNumber}. ` +
        `Pick a seat (rows 1-${seatMap.rows}, letters A-F; taken: ${seatMap.taken.join(", ")}):`,
      context: { seatMap, flight },
    });
    if (seatChoice.action !== "accept") {
      return {
        booked: false,
        ticketNumber: "",
        message: "Flight booking was declined before seat selection.",
      };
    }
    const seat = seatChoice.content.trim().toUpperCase();
    if (seatMap.taken.includes(seat)) {
      return { booked: false, ticketNumber: "", message: `Seat ${seat} is already taken.` };
    }
    const { ticketNumber } = yield* context.effect(reserveSeat, { flightId: flight.id, seat });
    return {
      booked: true,
      ticketNumber,
      message: `Booked ${flight.airline} ${flight.flightNumber}, seat ${seat}. Ticket ${ticketNumber}.`,
    };
  });

function staticSeatMap() {
  return {
    rows: 10,
    seatsPerRow: ["A", "B", "C", "D", "E", "F"],
    taken: ["1A", "1B", "2C", "4A", "5F", "7B"],
  };
}

/** Deterministic deployment bindings; effect outputs are pinned by pull_id_key idempotency. */
const searchValidators = effectRuntimeValidators(searchFlights)!;
export const searchFlightsRegistration = createDurableEffectRegistration(
  searchFlights,
  { mode: "idempotent", mechanism: "pull_id_key" },
  function* (input) {
    return {
      status: "ok",
      value: {
        flights: [
          {
            id: "FL001",
            airline: "SkyHigh",
            flightNumber: "SH 142",
            departure: "08:00",
            arrival: "11:30",
            price: 299,
          },
          {
            id: "FL002",
            airline: "CloudAir",
            flightNumber: "CA 287",
            departure: "12:45",
            arrival: "16:00",
            price: 349,
          },
          {
            id: "FL003",
            airline: `JetStream ${input.from}-${input.destination}`,
            flightNumber: "JS 901",
            departure: "18:30",
            arrival: "22:00",
            price: 249,
          },
        ],
      },
    };
  },
  { input: searchValidators.input, output: searchValidators.output },
);

const reserveValidators = effectRuntimeValidators(reserveSeat)!;
export const reserveSeatRegistration = createDurableEffectRegistration(
  reserveSeat,
  { mode: "idempotent", mechanism: "pull_id_key" },
  function* (input) {
    return {
      status: "ok",
      value: { ticketNumber: `TK-${input.flightId}-${input.seat}` },
    };
  },
  { input: reserveValidators.input, output: reserveValidators.output },
);
