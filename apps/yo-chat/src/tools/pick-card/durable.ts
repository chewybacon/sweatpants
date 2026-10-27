import { PickCardContextSchema, DrawInputSchema, DrawOutputSchema } from "../schemas/pick-card.ts";
import { CrankError } from "@sweatpants/durable-execution";
import { pickCard as portablePickCard } from "../primitive/pick-card.ts";
import { defineEffect } from "@sweatpants/agent-sdk";
import { createDurableTool } from "@sweatpants/agent-sdk/legacy";
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
  .description(portablePickCard.description)
  .identity({
    version: "2.0.0",
    digest: sha256("yo-chat.pick-card@2.0.0:portable-tool-body-v2"),
  })
  .parameters(portablePickCard.parameters)
  .output(portablePickCard.output)
  .elicits(portablePickCard.elicits)
  .effects({ [drawPickCards.name]: drawPickCards })
  .execute(function* (input, context) {
    return yield* portablePickCard.invokeWith(input, "pick_card", function* (request) {
      if (request.kind === "effect" && request.key === "draw") {
        return yield* context.effect(drawPickCards, DrawInputSchema.parse(request.input));
      }
      if (request.kind === "elicit" && request.key === "pickCard") {
        const offered = PickCardContextSchema.parse(request.context);
        const result = yield* context.elicit("pickCard", {
          message: request.message,
          context: offered,
        });
        if (
          result.action === "accept" &&
          !offered.cards.some(
            (card) =>
              card.rank === result.content.picked.rank &&
              card.suit === result.content.picked.suit &&
              card.display === result.content.picked.display,
          )
        ) {
          throw new CrankError("schema_validation_failed", "Selected card was not offered");
        }
        return result;
      }
      throw new Error(`Unsupported retained card capability: ${request.kind}`);
    });
  });

export {
  PickCardParametersSchema,
  PickCardResponseSchema,
  PickCardContextSchema,
} from "../schemas/pick-card.ts";
