import { createTool } from "@sweatpants/core";
import { z } from "zod";

import { CARD_RANKS, CARD_SUITS, CARD_SUIT_SYMBOLS, CardSchema, type Card } from "./cards";

export { CardSchema, type Card } from "./cards";

function drawRandomCard(): Card {
  const rank = CARD_RANKS[Math.floor(Math.random() * CARD_RANKS.length)]!;
  const suit = CARD_SUITS[Math.floor(Math.random() * CARD_SUITS.length)]!;
  return {
    rank,
    suit,
    display: `${rank}${CARD_SUIT_SYMBOLS[suit]}`,
  };
}

function drawUniqueCards(count: number): Card[] {
  const cards = new Map<string, Card>();
  while (cards.size < count && cards.size < CARD_RANKS.length * CARD_SUITS.length) {
    const card = drawRandomCard();
    const key = `${card.rank}-${card.suit}`;
    if (!cards.has(key)) {
      cards.set(key, card);
    }
  }
  return [...cards.values()];
}

export const pickCard = createTool("pick_card")
  .description("Draw random cards and let the user pick one")
  .parameters(
    z.object({
      count: z.number().min(2).max(10).default(5).describe("Number of cards to draw"),
    }),
  )
  .elicits({
    pickCard: {
      context: z.object({
        cards: z.array(CardSchema),
        prompt: z.string(),
      }),
      response: z.object({
        picked: CardSchema,
      }),
    },
  })
  .execute(function* (params, ctx) {
    const cards = drawUniqueCards(params.count);
    const prompt = `Pick one of these ${cards.length} cards:`;
    const picked = yield* ctx.elicit("pickCard", {
      message: prompt,
      context: { cards, prompt },
    });

    if (picked.action !== "accept") {
      return "No card was selected.";
    }

    const card = picked.content.picked;
    return [
      `Card selection recorded: the user picked ${card.rank} of ${card.suit} (${card.display}).`,
      "Remember this selected card for later questions in the same conversation.",
      "Acknowledge the specific selected card to the user now.",
    ].join(" ");
  });
