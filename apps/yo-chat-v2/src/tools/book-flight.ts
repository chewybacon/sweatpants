import { z } from "zod";
import { defineEffect } from "@sweatpan.ts/core";
import { defineTool } from "@sweatpan.ts/tools";
import {
  route,
  flight,
  seatMap,
  flightInput,
  seatInput,
  flightChoice,
  seatChoice,
  offeredFlight,
  availableSeat,
} from "../flights/contracts.ts";

export const searchFlights = defineEffect({
  key: "yo-chat/flights/search/1",
  context: route,
  response: z.array(flight),
});
export const loadSeats = defineEffect({
  key: "yo-chat/flights/seats/1",
  context: flight,
  response: seatMap,
});
export const travelTip = defineEffect({
  key: "yo-chat/flights/tip/1",
  context: route,
  response: z.string(),
});
export const issueTicket = defineEffect({
  key: "yo-chat/flights/ticket/1",
  context: z.object({ flight, seat: z.string(), route }),
  response: z.string(),
});
export const pickFlight = defineEffect({
  key: "yo-chat/flights/pick/1",
  context: flightInput,
  response: flightChoice,
});
export const pickSeat = defineEffect({
  key: "yo-chat/flights/pick-seat/1",
  context: seatInput,
  response: seatChoice,
});

export const bookFlight = defineTool("yo-chat/flights/book/1")
  .parameters(route)
  .capabilities({ searchFlights, loadSeats, travelTip, issueTicket })
  .elicits({ pickFlight, pickSeat })
  .execute(function* (route, ctx) {
    const found = yield* ctx.capabilities.searchFlights(route);
    if (!found.ok) {
      throw new Error("Flight search unavailable");
    }
    const input = { route, flights: found.value };
    const choice = yield* ctx.elicit("pickFlight", input);
    const flight = choice.ok ? offeredFlight(input, choice.value) : undefined;
    if (!flight) {
      throw new Error("Selected flight was not offered");
    }
    const seats = yield* ctx.capabilities.loadSeats(flight);
    if (!seats.ok) {
      throw new Error("Seat map unavailable");
    }
    const seatContext = { flight, seatMap: seats.value };
    const selected = yield* ctx.elicit("pickSeat", seatContext);
    if (!selected.ok || !availableSeat(seatContext, selected.value)) {
      throw new Error("Selected seat is unavailable");
    }
    const seat = `${selected.value.row}${selected.value.seat}`;
    const tip = yield* ctx.capabilities.travelTip(route);
    if (!tip.ok) {
      throw new Error("Travel tip unavailable");
    }
    const ticket = yield* ctx.capabilities.issueTicket({ flight, seat, route });
    if (!ticket.ok) {
      throw new Error("Ticket service unavailable");
    }
    return { ticket: ticket.value, flight, seat, route, travelTip: tip.value };
  });

export function decodeFlightInput(effect: string, input: unknown) {
  if (effect === pickFlight.id) {
    return flightInput.parse(input);
  }
  if (effect === pickSeat.id) {
    return seatInput.parse(input);
  }
  throw new Error("Unknown flight question");
}
