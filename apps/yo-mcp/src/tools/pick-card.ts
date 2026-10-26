/**
 * Pick Card Tool
 *
 * Canonical core tool that demonstrates declared elicitation.
 */
import { z } from "zod";
import { createDurableTool } from "@sweatpants/agent-sdk/primitive";

const SUITS = ["hearts", "diamonds", "clubs", "spades"] as const;
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"] as const;

type Card = { rank: (typeof RANKS)[number]; suit: (typeof SUITS)[number] };

function drawCards(count: number): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = temp;
  }
  return deck.slice(0, count);
}

function formatCard(card: Card): string {
  return `${card.rank} of ${card.suit}`;
}

const CardSchema = z.object({
  rank: z.enum(RANKS),
  suit: z.enum(SUITS),
});

const pickCardSchema = z.object({
  cardNumber: z.number().min(1).describe("Card number (1-based)"),
});

export const pickCardTool = createDurableTool("pick_card", { version: "1" })
  .description("Draw random cards and let the user pick one")
  .parameters(
    z.object({
      count: z.number().min(2).max(10).default(5).describe("Number of cards to draw"),
    }),
  )
  .effects({
    draw: {
      version: "1",
      input: z.object({ count: z.number() }),
      output: z.object({ cards: z.array(CardSchema), secret: CardSchema }),
      retrySafety: { mode: "repeatable" },
    },
  })
  .elicits({
    pickCard: {
      response: pickCardSchema,
      context: z.object({ cards: z.array(CardSchema) }),
    },
  })
  .execute(function* (params, ctx) {
    const { cards, secret } = yield* ctx.effect("draw", { count: params.count });
    yield* ctx.log("info", `Drew ${cards.length} cards`);

    const cardOptions = cards.map((card, i) => `${i + 1}. ${formatCard(card)}`).join("\n");
    const result = yield* ctx.elicit("pickCard", {
      message: `I've drawn ${cards.length} cards. Pick one!\n\n${cardOptions}`,
      context: { cards },
    });

    if (result.action !== "accept") {
      return { success: false, message: "No card was picked." };
    }

    const picked = cards[result.content.cardNumber - 1];
    if (!picked) {
      return { success: false, message: "Invalid card selection." };
    }

    const isWinner = picked.rank === secret.rank && picked.suit === secret.suit;
    return {
      success: true,
      picked: formatCard(picked),
      secret: formatCard(secret),
      isWinner,
      message: isWinner
        ? `You picked the secret card! ${formatCard(picked)}`
        : `You picked ${formatCard(picked)}, but the secret was ${formatCard(secret)}.`,
    };
  });

export function* drawCardEffect(input: { count: number }) {
  const cards = drawCards(input.count);
  const secret = cards[Math.floor(Math.random() * cards.length)]!;
  return { cards, secret };
}
