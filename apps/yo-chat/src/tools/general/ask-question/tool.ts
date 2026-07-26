import { createTool } from "@sweatpants/core";
import { z } from "zod";

export const askQuestion = createTool("ask_question")
  .description("Ask a question to the user")
  .parameters(
    z.object({
      question: z.string().describe("Question to ask the user"),
    }),
  )
  .elicits({
    askQuestion: {
      context: z.object({ question: z.string() }),
      response: z.object({ answer: z.string() }),
    },
  })
  .execute(function* (params, ctx) {
    const result = yield* ctx.elicit("askQuestion", {
      message: params.question,
      context: { question: params.question },
    });

    if (result.action !== "accept") {
      return { question: params.question, answer: null, cancelled: true };
    }

    return { question: params.question, answer: result.content.answer };
  });
