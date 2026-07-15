import { z } from "zod";

export const CARD_RANKS = Object.freeze([
  "A",
  "K",
  "Q",
  "J",
  "10",
  "9",
  "8",
  "7",
  "6",
  "5",
  "4",
  "3",
  "2",
]);
export const CARD_SUITS = Object.freeze(["Hearts", "Diamonds", "Clubs", "Spades"]);
export const CARD_SUIT_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  Hearts: "\u2665",
  Diamonds: "\u2666",
  Clubs: "\u2663",
  Spades: "\u2660",
});

export interface Card {
  [key: string]: string;
  rank: string;
  suit: string;
  display: string;
}

export const CardSchema = z.object({
  rank: z.string(),
  suit: z.string(),
  display: z.string(),
});

/** Pure canonical deck used by ordinary and durable card implementations. */
export function createCardDeck(): Card[] {
  return CARD_SUITS.flatMap((suit) =>
    CARD_RANKS.map((rank) => ({
      rank,
      suit,
      display: `${rank}${CARD_SUIT_SYMBOLS[suit]}`,
    })),
  );
}
