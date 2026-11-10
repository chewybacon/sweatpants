import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { createChatToolBinding, defineChatProgram } from "@sweatpan.ts/chat-host";
import { createRecovery, type OwnedJournal } from "@sweatpan.ts/durable";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { ChatSampling, ChatHistoryMessage, ChatLoopResult } from "@sweatpan.ts/chat";
import type { Runtime } from "@sweatpan.ts/runtime";
import { pickCard } from "../tools/pick-card.ts";

import { installCardDeck } from "./card-capabilities.ts";
import type { ChatDemo } from "./chat-demo.ts";
import { selectionInput, playingCard } from "../cards/contracts.ts";
import { cardResult } from "../cards/contracts.ts";

const input = z.object({
  prompt: z.string(),
  history: z.custom<readonly ChatHistoryMessage[]>(Array.isArray),
});
export const cardChatProgram = defineChatProgram({
  id: "yo-chat/card-conversation/2",
  history(value) {
    const { prompt, history } = input.parse(value);
    return [...history, { role: "user", content: prompt }];
  },
  toolResult(value) {
    const { card } = cardResult.parse(value);
    return {
      content: `The user picked ${card.rank} of ${card.suit} (${card.display}). Acknowledge this specific card and remember it for later questions.`,
      isError: false,
    };
  },
  result(completed) {
    return completed;
  },
});
export const systemMessage: ChatHistoryMessage = {
  role: "system",
  content:
    "You are a friendly card-game assistant. Use pick_card whenever the user wants to pick or draw cards; never choose on their behalf. After their choice, acknowledge the specific card. Remember earlier selections. Keep replies concise.",
};
export function bindCardChat<Y>(
  runtime: Runtime<Y>,
  journal: OwnedJournal<ChatLoopResult, CapabilityRequest, unknown, string, unknown, Y>,
  sampling: ChatSampling<Y>,
) {
  return cardChatProgram.bind(runtime, {
    journal,
    sampling,
    matches: isDeepStrictEqual,
    recovery: (options) => createRecovery(runtime.composition, options),
    tools: [
      createChatToolBinding(runtime, pickCard, {
        definition: {
          name: "pick_card",
          description:
            "Draw random playing cards and let the user choose one using an interactive picker.",
          parameters: z
            .record(z.string(), z.json())
            .parse(z.toJSONSchema(pickCard.context, { io: "input" })),
        },
        matches: isDeepStrictEqual,
        recovery: (options) => createRecovery(runtime.composition, options),
        configure: installCardDeck,
      }),
    ],
  });
}

/** Card-specific policy plugged into the shared app-local conversation assembly. */
export const cardDemo = {
  namespace: "",
  viewEvent: "card-chat-view",
  program: cardChatProgram,
  systemMessage,
  tools: [pickCard],
  bind: bindCardChat,
  decodeInput(_effect: string, value: unknown) {
    return selectionInput.parse(value);
  },
  validateAnswer(_effect: string, input: unknown, value: unknown) {
    const selected = playingCard.parse(value);
    if (!selectionInput.parse(input).cards.some((card) => isDeepStrictEqual(card, selected))) {
      throw new Error("Selected card was not offered");
    }
  },
  formatResult(value: unknown) {
    return cardResult.parse(value).card.display;
  },
} satisfies ChatDemo;
