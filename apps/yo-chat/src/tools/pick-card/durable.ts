import { z } from "zod";
import {
  PickCardParametersSchema,
  PickCardResponseSchema,
  PickCardContextSchema,
  DrawInputSchema,
  DrawOutputSchema,
} from "../schemas/pick-card.ts";
import { createDurableTool } from "@sweatpants/agent-sdk";

export const pickCard = createDurableTool("pick_card", {
  version: "2.0.0",
})
  .description("Draw random cards and let the user pick one")
  .parameters(PickCardParametersSchema)
  .output(z.string())
  .effects({
    draw: {
      version: "2",
      input: DrawInputSchema,
      output: DrawOutputSchema,
      // A lost unaccepted draw must stop recovery rather than silently draw again.
      retrySafety: { mode: "unsafe" as const },
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

export {
  PickCardParametersSchema,
  PickCardResponseSchema,
  PickCardContextSchema,
} from "../schemas/pick-card.ts";
