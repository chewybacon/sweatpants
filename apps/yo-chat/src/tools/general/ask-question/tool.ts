import { createTool } from "@sweatpants/agent-sdk";
import { askQuestion as portableAskQuestion } from "../../primitive/ask-question.ts";
import { AskQuestionContextSchema } from "../../schemas/ask-question.ts";

/** Ordinary placement of the same authored tool used by the local journal. */
export const askQuestion = createTool(portableAskQuestion.name)
  .description(portableAskQuestion.description)
  .parameters(portableAskQuestion.parameters)
  .elicits(portableAskQuestion.elicits)
  .execute(function* (input, ctx) {
    return yield* portableAskQuestion.invokeWith(input, "ask_question", function* (request) {
      if (request.kind === "elicit" && request.key === "askQuestion") {
        const result = yield* ctx.elicit("askQuestion", {
          message: request.message,
          context: AskQuestionContextSchema.parse(request.context),
        });
        return result.action === "accept"
          ? { action: result.action, content: result.content }
          : { action: result.action };
      }
      throw new Error(`Unsupported question capability: ${request.kind}`);
    });
  });
