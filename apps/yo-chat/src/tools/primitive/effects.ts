import { sleep } from "effection";
import { success } from "@sweatpants/foundation/computation";
import { assertJson } from "@sweatpants/foundation";
import type { PrimitiveChatOptions } from "@sweatpants/agent-host/primitive";
import type { Flight, SeatMap } from "../book-flight/tool";
import { createCardDeck } from "../pick-card/cards";
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

export const localEffects: PrimitiveChatOptions["effects"] = {
  "pick_card.draw": function* (input) {
    const deck = createCardDeck();
    const cards = [];
    const count = (input as { count: number }).count;
    while (cards.length < count) {
      cards.push(deck.splice(Math.floor(Math.random() * deck.length), 1)[0]!);
    }
    return success(assertJson({ cards }));
  },
  "book_flight.search": function* (input) {
    yield* sleep(900);
    const query = input as { from: string; destination: string };
    return success(assertJson(mockFlightSearch(query.from, query.destination)));
  },
  "book_flight.seats": function* () {
    yield* sleep(900);
    return success(assertJson(mockSeatMap()));
  },
  "book_flight.ticket": function* () {
    return success(generateTicketNumber());
  },
  "play_ttt.coin": function* () {
    return success({ side: Math.random() < 0.5 ? "heads" : "tails" });
  },
  "tictactoe.random": function* () {
    return success(Math.random());
  },
};
