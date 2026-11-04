import { z } from "zod";
import { defineEffect } from "@sweatpan.ts/core";
import { defineTool } from "@sweatpan.ts/tools";
import { defineChatProgram } from "@sweatpan.ts/chat-host";

// Application vocabulary, not new sampling or booking framework contracts.
export const searchFlights = defineEffect({
  key: "flight.search-v1",
  context: z.string(),
  response: z.array(z.object({ id: z.string(), airline: z.string() })),
});
const pickFlight = defineEffect({
  key: "flight.pick-v1",
  context: z.array(z.object({ id: z.string(), airline: z.string() })),
  response: z.enum(["flight-1", "flight-2"]),
});
const pickSeat = defineEffect({
  key: "flight.seat-v1",
  context: z.object({ flight: z.string(), seats: z.array(z.string()) }),
  response: z.enum(["2A", "2B"]),
});
const travelTipResult = z.object({
  text: z.string().min(1),
  model: z.object({ id: z.string(), api: z.string(), provider: z.string() }),
});
export const travelTip = defineEffect({
  key: "flight.travel-tip-v1",
  context: z.object({ destination: z.string() }),
  response: travelTipResult,
});
export const flightInput = z.object({ destination: z.string().min(1) });
export const flightResult = z.object({
  flight: z.enum(["flight-1", "flight-2"]),
  seat: z.enum(["2A", "2B"]),
  destination: z.string(),
  tip: travelTipResult,
});
const saveInput = z.object({
  flight: z.enum(["flight-1", "flight-2"]),
  seat: z.enum(["2A", "2B"]),
});
const confirmSave = defineEffect({
  key: "flight.confirm-save-v1",
  context: saveInput,
  response: z.literal("save"),
});
export const saveItineraryRecord = defineEffect({
  key: "flight.save-itinerary-v1",
  context: saveInput,
  response: z.object({ id: z.string() }),
});
export const itineraryResult = z.object({
  saved: z.literal(true),
  itinerary: z.object({ id: z.string() }),
});
export const chooseFlight = defineTool("flight-choice-v1")
  .parameters(flightInput)
  .capabilities({ searchFlights, travelTip })
  .elicits({ pickFlight, pickSeat })
  .execute(function* ({ destination }, ctx) {
    const flights = yield* ctx.capabilities.searchFlights(destination);
    if (!flights.ok) {
      throw new Error("Flight search unavailable");
    }
    const flight = yield* ctx.elicit("pickFlight", flights.value);
    if (!flight.ok || !flights.value.some((item) => item.id === flight.value)) {
      throw new Error("Flight selection unavailable");
    }
    const seat = yield* ctx.elicit("pickSeat", { flight: flight.value, seats: ["2A", "2B"] });
    if (!seat.ok) {
      throw new Error("Seat selection unavailable");
    }
    const tip = yield* ctx.capabilities.travelTip({ destination });
    if (!tip.ok) {
      throw new Error("Travel tip unavailable");
    }
    return { flight: flight.value, seat: seat.value, destination, tip: tip.value };
  });

export const saveItinerary = defineTool("save-itinerary-v1")
  .parameters(saveInput)
  .capabilities({ saveItineraryRecord })
  .elicits({ confirmSave })
  .execute(function* (input, ctx) {
    const confirmation = yield* ctx.elicit("confirmSave", input);
    if (!confirmation.ok) {
      throw new Error("Itinerary save declined");
    }
    const itinerary = yield* ctx.capabilities.saveItineraryRecord(input);
    if (!itinerary.ok) {
      throw new Error("Itinerary save unavailable");
    }
    return { saved: true as const, itinerary: itinerary.value };
  });

export const flightChat = defineChatProgram({
  id: "flight-choice-chat-v1",
  history(input) {
    return [{ role: "user", content: z.object({ prompt: z.string() }).parse(input).prompt }];
  },
  toolResult(value) {
    return {
      content: JSON.stringify(z.union([flightResult, itineraryResult]).parse(value)),
      isError: false,
    };
  },
  result(completed) {
    return completed;
  },
});
