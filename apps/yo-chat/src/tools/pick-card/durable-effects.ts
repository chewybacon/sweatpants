import { type DurableEffectRegistration } from "@sweatpants/session-contract";
import { effectRuntimeValidators } from "@sweatpants/core";
import { createDurableEffectRegistration } from "@sweatpants/durable-effects";
import { sha256, type Json } from "@sweatpants/foundation";

import { createCardDeck } from "./cards";
import { drawPickCards } from "./durable";

/** Host-side deterministic draw handler keyed by the durable pull identity. */
export function createDrawPickCardsRegistration(): DurableEffectRegistration {
  return createDurableEffectRegistration(
    drawPickCards,
    { mode: "idempotent", mechanism: "pull_id_key" },
    function* (input, context) {
      const count = drawCount(input);
      const ordered = createCardDeck().map((card) => ({
        card,
        order: sha256(`${context.pullId}:${drawPickCards.version}:${card.rank}:${card.suit}`),
      }));
      const cards = [];
      while (cards.length < count) {
        let winnerIndex = 0;
        for (let index = 1; index < ordered.length; index += 1) {
          if (ordered[index]!.order < ordered[winnerIndex]!.order) {
            winnerIndex = index;
          }
        }
        cards.push(ordered.splice(winnerIndex, 1)[0]!.card);
      }
      return { status: "ok", value: { cards } };
    },
    effectRuntimeValidators(drawPickCards),
  );
}

function drawCount(input: Json): number {
  const count =
    input && typeof input === "object" && !Array.isArray(input) ? input["count"] : undefined;
  if (!Number.isInteger(count) || Number(count) < 2 || Number(count) > 10) {
    throw new Error("pick-card.draw count is outside the validated contract");
  }
  return Number(count);
}
