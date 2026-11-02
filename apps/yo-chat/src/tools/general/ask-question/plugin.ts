import { makePlugin } from "@sweatpants/react-chat";

import { QuestionPrompt } from "./components/QuestionPrompt";
import { askQuestion } from "./tool.ts";

export const askQuestionPlugin = makePlugin(askQuestion)
  .onElicit({
    askQuestion: function* (input, ctx) {
      const question = input.context.question ?? input.message;
      const result = yield* ctx.render(QuestionPrompt, { question });
      return { action: "accept" as const, content: result };
    },
  })
  .build();
