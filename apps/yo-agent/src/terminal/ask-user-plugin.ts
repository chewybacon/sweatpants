import { askUser } from "../tools/ask-user.ts";
import { makeTerminalPlugin } from "./plugin.ts";

export const askUserPlugin = makeTerminalPlugin(askUser)
  .onElicit({
    answer: function* (input, terminal) {
      const result = yield* terminal.promptText({
        message: input.context.question,
      });
      return result.action === "accept"
        ? { action: "accept" as const, content: { answer: result.value } }
        : result;
    },
  })
  .build();
