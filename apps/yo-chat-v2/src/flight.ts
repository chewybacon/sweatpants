import { z } from "zod";
import { defineEffect } from "@sweatpan.ts/core";
import { defineTool } from "@sweatpan.ts/tools";

export const flightId = z.enum(["flight-1", "flight-2"]);
export const seatId = z.enum(["2A", "2B"]);
export const flightOption = z.object({
  id: flightId,
  airline: z.string(),
  departure: z.string(),
  arrival: z.string(),
});
const pickFlight = defineEffect({
  key: "yo-chat/demo-pick-flight-v1",
  context: z.object({ destination: z.string(), flights: z.array(flightOption) }),
  response: flightId,
});
const pickSeat = defineEffect({
  key: "yo-chat/demo-pick-seat-v1",
  context: z.object({ flight: z.string(), seats: z.array(z.string()) }),
  response: seatId,
});
export const flightResult = z.object({
  demo: z.literal(true),
  destination: z.string(),
  flight: flightOption,
  seat: seatId,
});
// Public demo declaration is browser-safe: it imports no provider, database or credentials.
export const chooseFlight = defineTool("yo-chat/demo-flight-v1")
  .parameters(z.object({ destination: z.string().min(1).max(100) }))
  .elicits({ pickFlight, pickSeat })
  .execute(function* ({ destination }, ctx) {
    const flights = [
      { id: "flight-1" as const, airline: "SkyHigh", departure: "09:00", arrival: "12:15" },
      { id: "flight-2" as const, airline: "CloudAir", departure: "14:30", arrival: "17:45" },
    ];
    const selected = yield* ctx.elicit("pickFlight", { destination, flights });
    if (!selected.ok) {
      throw new Error("Flight selection not completed");
    }
    const flight = flights.find((item) => item.id === selected.value)!;
    const seat = yield* ctx.elicit("pickSeat", {
      flight: `${flight.airline} to ${destination}`,
      seats: ["2A", "2B"],
    });
    if (!seat.ok) {
      throw new Error("Seat selection not completed");
    }
    return { demo: true as const, destination, flight, seat: seat.value };
  });
