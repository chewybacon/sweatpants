import {
  AskQuestionParametersSchema,
  AskQuestionContextSchema,
  AskQuestionResponseSchema,
} from "../schemas/ask-question.ts";
import { createDurableTool } from "@sweatpants/agent-sdk/primitive";

export const askQuestion = createDurableTool("ask_question", {
  version: "1",
})
  .description("Ask a question to the user")
  .parameters(AskQuestionParametersSchema)
  .effects({})
  .elicits({
    askQuestion: { context: AskQuestionContextSchema, response: AskQuestionResponseSchema },
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
