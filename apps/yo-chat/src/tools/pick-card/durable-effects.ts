import { effectRuntimeValidators } from "@sweatpants/core";
import {
  createDurableEffectRegistration,
  sha256,
  type DurableEffectRegistration,
} from "@sweatpants/session-contract";

import { createCardDeck } from "./cards";
import { drawPickCards } from "./durable";

/** Host-side deterministic draw handler keyed by the durable pull identity. */
export function createDrawPickCardsRegistration(): DurableEffectRegistration {
  return createDurableEffectRegistration(
    drawPickCards,
    { mode: "idempotent", mechanism: "pull_id_key" },
    function* ({ count }, context) {
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
