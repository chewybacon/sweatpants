import { createTool } from "@sweatpants/agent-sdk";
import { z } from "zod";

export const askUser = createTool("ask_user")
  .description("Ask the terminal user a question and wait for their answer")
  .parameters(z.object({ question: z.string().describe("Question to ask the user") }))
  .elicits({
    answer: {
      context: z.object({ question: z.string() }),
      response: z.object({ answer: z.string() }),
    },
  })
  .execute(function* (params, context) {
    const result = yield* context.elicit("answer", {
      message: params.question,
      context: { question: params.question },
    });
    return result.action === "accept"
      ? { answer: result.content.answer, answered: true }
      : { answer: null, answered: false };
  });
