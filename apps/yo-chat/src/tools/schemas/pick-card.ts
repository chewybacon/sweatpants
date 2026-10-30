import { z } from "zod";
import { CardSchema } from "../pick-card/cards.ts";
export const PickCardParametersSchema = z.object({
  count: z.number().int().min(2).max(10).default(5).describe("Number of cards to draw"),
});
export const PickCardResponseSchema = z.object({
  picked: CardSchema,
});
export const PickCardContextSchema = z.object({
  cards: z.array(CardSchema),
  prompt: z.string(),
});

export const DrawInputSchema = z.object({ count: z.number().int().min(2).max(10) });

export const DrawOutputSchema = z.object({ cards: z.array(CardSchema).min(2).max(10) });
