import { createDurableTool } from "@sweatpants/core";
import {
  CrankError,
  assertJson,
  defineDurableEffect,
  sha256,
  type DurableTool,
} from "@sweatpants/session-contract";
import { z } from "zod";

import { CardSchema, type Card } from "./cards";

export type DrawCardsInput = { count: number };
export type DrawCardsOutput = { cards: Card[] };

export const drawPickCards = defineDurableEffect<DrawCardsInput, DrawCardsOutput>({
  name: "pick-card.draw",
  version: "1",
  inputSchema: {
    type: "object",
    required: ["count"],
    properties: { count: { type: "integer", minimum: 2, maximum: 10 } },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["cards"],
    properties: {
      cards: {
        type: "array",
        minItems: 2,
        maxItems: 10,
        items: {
          type: "object",
          required: ["rank", "suit", "display"],
          properties: {
            rank: { type: "string" },
            suit: { type: "string" },
            display: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

const durablePickCardInput = z.object({
  count: z.number().int().min(2).max(10),
  toolCallId: z.string(),
});
const durablePickCardResponse = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), content: z.object({ picked: CardSchema }) }),
  z.object({ action: z.literal("decline") }),
  z.object({ action: z.literal("cancel") }),
]);
const durablePickCardContext = z.object({
  responseSchema: z.unknown(),
  context: z.object({
    callId: z.string(),
    toolName: z.literal("pick_card"),
    cards: z.array(CardSchema),
    prompt: z.string(),
  }),
});
const responseSchema = assertJson(z.toJSONSchema(durablePickCardResponse));

/** Location-neutral crank-native pick-card program. */
export const durablePickCard = createDurableTool("pick_card")
  .description("Draw deterministic durable cards and let the user pick one")
  .identity({
    version: "1.0.0",
    digest: sha256("yo-chat.pick-card@1.0.0:draw-effect-elicit-result-v1"),
  })
  .parameters(durablePickCardInput)
  .elicits({
    pickCard: {
      response: durablePickCardResponse,
      context: durablePickCardContext,
    },
  })
  .effects({ [drawPickCards.name]: drawPickCards })
  .execute(function* (input, context) {
    const count = input.count;
    const { cards } = yield* context.effect(drawPickCards, { count });
    const prompt = `Pick one of these ${cards.length} cards:`;
    const picked = yield* context.elicit<z.infer<typeof durablePickCardResponse>>(
      "pickCard",
      prompt,
      responseSchema,
      {
        responseSchema,
        context: {
          callId: input.toolCallId,
          toolName: "pick_card",
          cards,
          prompt,
        },
      },
    );
    if (picked.action !== "accept") {
      return "No card was selected.";
    }
    const card = cards.find(
      (candidate) =>
        candidate.rank === picked.content.picked.rank &&
        candidate.suit === picked.content.picked.suit &&
        candidate.display === picked.content.picked.display,
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

// SAFETY: runtime registries erase manifest type witnesses; attachment input is
// restored through the exact pinned input schema before program execution.
export const runtimeDurablePickCard = durablePickCard as unknown as DurableTool;
