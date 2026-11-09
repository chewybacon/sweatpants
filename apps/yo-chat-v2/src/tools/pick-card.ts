import { z } from "zod";
import { defineEffect } from "@sweatpan.ts/core";
import { defineTool } from "@sweatpan.ts/tools";
import { playingCard, selectionInput } from "../cards/contracts.ts";

export const drawCards = defineEffect({
  key: "yo-chat/cards/draw/1",
  context: z.number().int().min(1).max(10),
  response: z.array(playingCard),
});
export const chooseCard = defineEffect({
  key: "yo-chat/cards/choose/1",
  context: selectionInput,
  response: playingCard,
});
export const pickCard = defineTool("yo-chat/cards/pick/2")
  .parameters(z.object({ count: z.number().int().min(1).max(10).default(3) }))
  .capabilities({ draw: drawCards })
  .elicits({ chooseCard })
  .execute(function* ({ count }, ctx) {
    const draw = yield* ctx.capabilities.draw(count);
    if (!draw.ok) {
      throw new Error("Could not draw cards");
    }
    const picked = yield* ctx.elicit("chooseCard", {
      prompt: `Pick one of these ${draw.value.length} cards:`,
      cards: draw.value,
    });
    if (!picked.ok) {
      throw new Error("No card was selected");
    }
    const card = draw.value.find(
      (card) =>
        card.rank === picked.value.rank &&
        card.suit === picked.value.suit &&
        card.display === picked.value.display,
    );
    if (!card) {
      throw new Error("Selected card was not offered");
    }
    return { card };
  });
