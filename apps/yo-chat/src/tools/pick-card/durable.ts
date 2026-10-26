import { z } from "zod";
import {
  PickCardParametersSchema,
  PickCardResponseSchema,
  PickCardContextSchema,
  DrawInputSchema,
  DrawOutputSchema,
} from "../schemas/pick-card.ts";
import { CrankError } from "@sweatpants/durable-execution";
import { createDurableTool, defineEffect } from "@sweatpants/agent-sdk";
import { sha256 } from "@sweatpants/foundation";

/** Host-side card draw contract with Zod-authored Standard Schema validators. */
export const drawPickCards = defineEffect({
  name: "pick-card.draw",
  version: "1",
  input: DrawInputSchema,
  output: DrawOutputSchema,
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

/**
 * Retained crank-native execution of the shared pick_card declaration.
 * Its program identity, retry policy and catalog remain route-specific.
 */
export const pickCard = createDurableTool("pick_card")
  .description("Draw random cards and let the user pick one")
  .identity({
    version: "2.0.0",
    digest: sha256("yo-chat.pick-card@2.0.0:unified-contract-content-elicit-v1"),
  })
  .parameters(PickCardParametersSchema)
  .output(z.string())
  .elicits({ pickCard: { response: PickCardResponseSchema, context: PickCardContextSchema } })
  .effects({ [drawPickCards.name]: drawPickCards })
  .execute(function* (input, context) {
    const { cards } = yield* context.effect(drawPickCards, { count: input.count });
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
      throw new CrankError("schema_validation_failed", "Selected card was not offered");
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
