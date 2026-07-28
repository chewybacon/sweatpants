import { randomInt } from "node:crypto";
import { createDurableTool, defineEffect, effectRuntimeValidators } from "@sweatpants/core";
import { createDurableEffectRegistration } from "@sweatpants/framework/server";
import { z } from "zod";

const SUITS = ["hearts", "diamonds", "clubs", "spades"] as const;
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"] as const;
const CardSchema = z.object({
  rank: z.enum(RANKS),
  suit: z.enum(SUITS),
  display: z.string(),
});
type Card = z.infer<typeof CardSchema>;

const DrawCardsInputSchema = z.object({ count: z.number().int().min(2).max(10) });

const drawCards = defineEffect({
  name: "yo-a2a.cards.draw",
  version: "1",
  input: DrawCardsInputSchema,
  output: z.object({ cards: z.array(CardSchema).min(2).max(10) }),
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

export const pickCard = createDurableTool("pick_card", { version: "1.1.0" })
  .description("Draw cards, show the exact choices to the user, and durably wait for a selection")
  .parameters(
    z.object({
      count: z.number().int().min(2).max(10).describe("Number of cards to draw"),
    }),
  )
  .output(
    z.object({
      selected: CardSchema,
      message: z.string(),
    }),
  )
  .elicits({
    pickCard: {
      response: z.string().min(1).max(16).describe("The 1-based card number, for example: 1"),
      context: z.object({ cards: z.array(CardSchema).min(2).max(10) }),
    },
  })
  .effects({ [drawCards.name]: drawCards })
  .execute(function* (input, context) {
    const { cards } = yield* context.effect(drawCards, { count: input.count });
    const choices = cards.map((card, index) => `${index + 1}. ${card.display}`).join("\n");
    const response = yield* context.elicit("pickCard", {
      message: `I drew ${cards.length} cards. Pick one:\n\n${choices}`,
      context: { cards },
    });
    if (response.action !== "accept") {
      return {
        selected: cards[0]!,
        message: "The card selection was declined or cancelled.",
      };
    }
    const selectedIndex = Number.parseInt(response.content.trim().replace(/\.$/, ""), 10) - 1;
    const selected = cards[selectedIndex];
    if (!selected) {
      throw new Error("The selected card number was not one of the offered cards");
    }
    return { selected, message: `You selected ${selected.display}.` };
  });

const drawValidators = effectRuntimeValidators(drawCards)!;
export const drawCardsRegistration = createDurableEffectRegistration(
  drawCards,
  { mode: "idempotent", mechanism: "pull_id_key" },
  function* (value) {
    const input = DrawCardsInputSchema.parse(value);
    return { status: "ok", value: { cards: shuffledDeck().slice(0, input.count) } };
  },
  { input: drawValidators.input, output: drawValidators.output },
);

function shuffledDeck(): Card[] {
  const deck = SUITS.flatMap((suit) =>
    RANKS.map((rank) => ({ rank, suit, display: `${rank} of ${suit}` })),
  );
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const selected = randomInt(index + 1);
    [deck[index], deck[selected]] = [deck[selected]!, deck[index]!];
  }
  return deck;
}
