import { createDurableTool } from "@sweatpants/agent-sdk/primitive";
import { z } from "zod";
import { CardSchema } from "../pick-card/cards";
export const PickCardParametersSchema = z.object({
  count: z.number().int().min(2).max(10).default(5).describe("Number of cards to draw"),
});

/** Accepted CardPicker content schema (not the outer action envelope). */
export const PickCardResponseSchema = z.object({
  picked: CardSchema,
});

/** Canonical authored CardPicker context; correlation metadata stays private. */
export const PickCardContextSchema = z.object({
  cards: z.array(CardSchema),
  prompt: z.string(),
});

export const pickCard = createDurableTool("pick_card", { version: "2.0.0" })
  .description("Draw random cards and let the user pick one")
  .parameters(PickCardParametersSchema)
  .output(z.string())
  .effects({
    draw: {
      version: "1",
      input: z.object({ count: z.number().int().min(2).max(10) }),
      output: z.object({ cards: z.array(CardSchema).min(2).max(10) }),
      retrySafety: { mode: "repeatable" },
    },
  })
  .elicits({ pickCard: { response: PickCardResponseSchema, context: PickCardContextSchema } })
  .execute(function* (input, context) {
    const { cards } = yield* context.effect("draw", { count: input.count });
    const prompt = `Pick one of these ${cards.length} cards:`;
    const result = yield* context.elicit("pickCard", {
      message: prompt,
      context: { cards, prompt },
    });
    if (result.action !== "accept") {
      return "No card was selected.";
    }
    const card = cards.find(
      (candidate) =>
        candidate.rank === result.content.picked.rank &&
        candidate.suit === result.content.picked.suit &&
        candidate.display === result.content.picked.display,
    );
    if (!card) {
      throw new Error("Selected card was not offered");
    }
    return [
      `Card selection recorded: the user picked ${card.rank} of ${card.suit} (${card.display}).`,
      "Remember this selected card for later questions in the same conversation.",
      "Acknowledge the specific selected card to the user now.",
    ].join(" ");
  });
