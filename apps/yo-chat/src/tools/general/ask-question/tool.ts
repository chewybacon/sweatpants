import {
  AskQuestionParametersSchema,
  AskQuestionContextSchema,
  AskQuestionResponseSchema,
} from "../../schemas/ask-question.ts";
import { createTool } from "@sweatpants/agent-sdk";

export const askQuestion = createTool("ask_question")
  .description("Ask a question to the user")
  .parameters(AskQuestionParametersSchema)
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
