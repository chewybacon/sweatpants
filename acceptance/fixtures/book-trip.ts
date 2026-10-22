import { createTool } from "@sweatpants/agent-sdk";
import { z } from "zod";

// Inspired by yo-chat: two typed interactions, then a private nested sample.
export const bookTrip = createTool("book_trip")
  .description("Choose a flight and seat, then get a travel tip")
  .parameters(z.object({ destination: z.string() }))
  .elicits({
    flight: {
      response: z.object({ flight: z.string() }),
      context: z.object({ destination: z.string(), flights: z.array(z.string()) }),
    },
    seat: {
      response: z.object({ seat: z.string() }),
      context: z.object({ flight: z.string(), seats: z.array(z.string()) }),
    },
  })
  .samples()
  .execute(function* ({ destination }, ctx) {
    const flight = yield* ctx.elicit("flight", {
      message: "Choose your flight",
      context: { destination, flights: ["FL-1", "FL-2"] },
    });
    if (flight.action !== "accept") {
      return { booked: false, reason: flight.action };
    }
    const seat = yield* ctx.elicit("seat", {
      message: "Choose your seat",
      context: { flight: flight.content.flight, seats: ["1A", "2B"] },
    });
    if (seat.action !== "accept") {
      return { booked: false, reason: seat.action };
    }
    const tip = yield* ctx.sample({ prompt: `PRIVATE_TRAVEL_TIP for ${destination}` });
    return {
      booked: true,
      destination,
      flight: flight.content.flight,
      seat: seat.content.seat,
      tip: tip.text,
    };
  });
