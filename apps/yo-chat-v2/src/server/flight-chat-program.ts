import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { createChatToolBinding, defineChatProgram } from "@sweatpan.ts/chat-host";
import { createRecovery } from "@sweatpan.ts/durable";
import type { ChatHistoryMessage } from "@sweatpan.ts/chat";
import {
  bookFlight,
  searchFlights,
  loadSeats,
  travelTip,
  issueTicket,
  pickFlight,
  pickSeat,
  decodeFlightInput,
} from "../tools/book-flight.ts";
import {
  booking,
  flightChoice,
  flightInput,
  seatChoice,
  seatInput,
  offeredFlight,
  availableSeat,
} from "../flights/contracts.ts";
import { mockFlightSearch, mockSeatMap, generateTicketNumber } from "./flight-services.ts";
import type { ChatDemo } from "./chat-demo.ts";

const input = z.object({
  prompt: z.string(),
  history: z.custom<readonly ChatHistoryMessage[]>(Array.isArray),
});
export const flightChatProgram = defineChatProgram({
  id: "yo-chat/flight-conversation/1",
  history(value) {
    const { prompt, history } = input.parse(value);
    return [...history, { role: "user", content: prompt }];
  },
  toolResult(value) {
    return { content: JSON.stringify(booking.parse(value)), isError: false };
  },
  result(completed) {
    return completed;
  },
});

/** Demo service policy. All installs target the tool's actual scoped effect instance. */
export function defineFlightDemo(
  services = { search: mockFlightSearch, seats: mockSeatMap, ticket: generateTicketNumber },
): ChatDemo {
  return {
    namespace: "flight:",
    viewEvent: "flight-chat-view",
    program: flightChatProgram,
    systemMessage: {
      role: "system",
      content:
        "You are a friendly flight booking assistant in a simulated demo. Use book_flight to search and let the user choose their own flight and seat. Ask for missing departure or destination. After booking, acknowledge the flight, seat, simulated ticket and travel tip. Remember earlier bookings. Keep replies concise. No real tickets or payments are involved.",
    },
    tools: [bookFlight],
    bind(runtime, journal, sampling) {
      return flightChatProgram.bind(runtime, {
        journal,
        sampling,
        matches: isDeepStrictEqual,
        recovery: (options) => createRecovery(runtime.composition, options),
        tools: [
          createChatToolBinding(runtime, bookFlight, {
            definition: {
              name: "book_flight",
              description:
                "Search simulated flights and let the user select a flight and an available seat before issuing a demo ticket.",
              parameters: z
                .record(z.string(), z.json())
                .parse(z.toJSONSchema(bookFlight.context, { io: "input" })),
            },
            matches: isDeepStrictEqual,
            recovery: (options) => createRecovery(runtime.composition, options),
            *configure({ effects }) {
              yield* effects.install(searchFlights, function* ({ from, destination }) {
                return { ok: true, value: services.search(from, destination) };
              });
              yield* effects.install(loadSeats, function* () {
                return { ok: true, value: services.seats() };
              });
              yield* effects.install(issueTicket, function* () {
                return { ok: true, value: services.ticket() };
              });
              yield* effects.install(travelTip, function* ({ destination }) {
                const result = yield* sampling.sample({
                  round: 0,
                  tools: [],
                  history: [
                    {
                      role: "user",
                      content: `Give one brief travel tip for arriving in ${destination}.`,
                    },
                  ],
                });
                if (!result.ok) {
                  throw new Error("Travel tip sampling failed");
                }
                const text = result.value.response.message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("");
                return { ok: true, value: text };
              });
            },
          }),
        ],
      });
    },
    decodeInput: decodeFlightInput,
    validateAnswer(effect, input, value) {
      if (
        effect === pickFlight.id &&
        offeredFlight(flightInput.parse(input), flightChoice.parse(value))
      ) {
        return;
      }
      if (
        effect === pickSeat.id &&
        availableSeat(seatInput.parse(input), seatChoice.parse(value))
      ) {
        return;
      }
      throw new Error("Selection was not offered or is unavailable");
    },
    formatResult(value) {
      const result = booking.parse(value);
      return `${result.flight.airline} ${result.flight.flightNumber} · Seat ${result.seat} · ${result.ticket}. ${result.travelTip}`;
    },
  };
}
export const flightDemo = defineFlightDemo();
