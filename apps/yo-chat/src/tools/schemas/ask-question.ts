import { z } from "zod";
export const AskQuestionParametersSchema = z.object({
  question: z.string().describe("Question to ask the user"),
});

export const AskQuestionContextSchema = z.object({ question: z.string() });

export const AskQuestionResponseSchema = z.object({ answer: z.string() });
