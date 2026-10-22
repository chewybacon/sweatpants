import { makePlugin } from "@sweatpants/react-chat";
import { durableSelection } from "./durable-selection.ts";
import { ChoiceCard } from "./trip-chat.tsx";

export const selectionPlugin = makePlugin(durableSelection)
  .onElicit({
    choose: function* (input, ctx) {
      const result = yield* ctx.render(ChoiceCard, {
        choices: input.context.options,
        message: input.message,
      });
      return result.action === "accept"
        ? { action: "accept", content: { selected: result.content.value } }
        : result;
    },
  })
  .build();
