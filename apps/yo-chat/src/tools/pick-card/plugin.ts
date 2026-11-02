import { makePlugin } from "@sweatpants/react-chat";

import { CardPicker } from "./components/CardPicker";
import { pickCard } from "./durable.ts";

export const pickCardPlugin = makePlugin(pickCard)
  .onElicit({
    pickCard: function* (input, ctx) {
      const { cards, prompt: contextPrompt } = input.context;
      const prompt = contextPrompt ?? input.message;
      const result = yield* ctx.render(CardPicker, { cards, prompt });
      return { action: "accept" as const, content: result };
    },
  })
  .build();
