import { z } from "zod";

export const playingCard = z.object({ rank: z.string(), suit: z.string(), display: z.string() });
export const selectionInput = z.object({ prompt: z.string(), cards: z.array(playingCard) });
export const cardResult = z.object({ card: playingCard });
export type PlayingCard = z.infer<typeof playingCard>;
