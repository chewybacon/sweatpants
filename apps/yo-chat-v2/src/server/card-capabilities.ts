import { randomInt } from "node:crypto";
import type { ToolSession } from "@sweatpan.ts/tools";
import { drawCards } from "../tools/pick-card.ts";

/** Install the card deck in the invoking host scope. */
export function* installCardDeck<Y>({
  effects,
}: Pick<ToolSession<unknown, unknown, unknown, Y>, "effects">) {
  yield* effects.install(drawCards, function* (count) {
    const deck = ["spades", "hearts", "diamonds", "clubs"].flatMap((suit, index) =>
      ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"].map((rank) => ({
        rank,
        suit,
        display: `${rank}${["♠", "♥", "♦", "♣"][index]}`,
      })),
    );
    for (let i = deck.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    return { ok: true, value: deck.slice(0, count) };
  });
}
