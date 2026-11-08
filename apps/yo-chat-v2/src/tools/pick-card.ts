import { z } from "zod";
import { defineEffect } from "@sweatpan.ts/core";
import { defineTool } from "@sweatpan.ts/tools";

export const cardId = z.enum(["ace-of-spades", "queen-of-hearts", "seven-of-clubs"]);
export const cardQuestion = z.object({
  message: z.string(),
  cards: z.array(z.object({ id: cardId, label: z.string() })),
});
export const chooseCard = defineEffect({
  key: "yo-chat/pick-card-choice/1",
  context: cardQuestion,
  response: cardId,
});

export const pickCard = defineTool("yo-chat/pick-card/1")
  .parameters(z.object({}).strict())
  .elicits({ chooseCard })
  .execute(function* (_input, ctx) {
    const selected = yield* ctx.elicit("chooseCard", {
      message: "Pick a card",
      cards: [
        { id: "ace-of-spades", label: "Ace of spades" },
        { id: "queen-of-hearts", label: "Queen of hearts" },
        { id: "seven-of-clubs", label: "Seven of clubs" },
      ],
    });
    if (!selected.ok) {
      throw new Error("Card selection did not complete");
    }
    return { card: selected.value };
  });
