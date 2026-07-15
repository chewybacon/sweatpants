import { createDurableTool, defineEffect } from "@sweatpants/core";
import { CrankError, sha256 } from "@sweatpants/session-contract";
import { z } from "zod";

import { CardSchema } from "./cards";

/** One public parameter schema shared by model inventory and durable execution. */
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

/** Host-side card draw contract with Zod-authored Standard Schema validators. */
export const drawPickCards = defineEffect({
  name: "pick-card.draw",
  version: "1",
  input: z.object({ count: z.number().int().min(2).max(10) }),
  output: z.object({ cards: z.array(CardSchema).min(2).max(10) }),
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

/**
 * The one `pick_card` contract and exact crank-native program definition.
 * Inventory, plugin UI, placement, and validator catalog all derive from this
 * object; no ordinary fallback exists.
 */
export const pickCard = createDurableTool("pick_card")
  .description("Draw random cards and let the user pick one")
  .identity({
    version: "2.0.0",
    digest: sha256("yo-chat.pick-card@2.0.0:unified-contract-content-elicit-v1"),
  })
  .parameters(PickCardParametersSchema)
  .output(z.string())
  .elicits({
    pickCard: {
      response: PickCardResponseSchema,
      context: PickCardContextSchema,
    },
  })
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

/** @deprecated Migration alias; both names reference the one durable contract. */
export const durablePickCard = pickCard;
