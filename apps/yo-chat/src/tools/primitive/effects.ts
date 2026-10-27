import { sleep } from "effection";
import { success } from "@sweatpants/foundation/computation";
import { createToolEffects } from "@sweatpants/agent-sdk";
import { effection } from "@sweatpants/standard-durability-effection";
import { localJournalTools } from "./index.ts";
import { mockFlightSearch, mockSeatMap, generateTicketNumber } from "../book-flight/backend.ts";
import { createCardDeck } from "../pick-card/cards";
export const localEffects = createToolEffects(effection).handlers(localJournalTools)({
  "pick_card.draw": function* (input) {
    const deck = createCardDeck();
    const cards = [];
    const count = input.count;
    while (cards.length < count) {
      cards.push(deck.splice(Math.floor(Math.random() * deck.length), 1)[0]!);
    }
    return success({ cards });
  },
  "book_flight.search": function* (input) {
    yield* sleep(900);
    const query = input;
    return success(mockFlightSearch(query.from, query.destination));
  },
  "book_flight.seats": function* () {
    yield* sleep(900);
    return success(mockSeatMap());
  },
  "book_flight.ticket": function* () {
    return success(generateTicketNumber());
  },
  "play_ttt.coin": function* () {
    return success({ side: Math.random() < 0.5 ? ("heads" as const) : ("tails" as const) });
  },
  "tictactoe.random": function* () {
    return success(Math.random());
  },
});
