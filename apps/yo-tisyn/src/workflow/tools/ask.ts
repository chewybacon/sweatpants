import { completeElicitExchange, createDurableTool } from "@sweatpants/agent-sdk";
import { sha256 } from "@sweatpants/foundation";
import { z } from "zod";
import { exchangeSchema, projectExchange } from "../exchanges.ts";

export const replyLimit = 4096;
const replySchema = z.object({
  reply: z.string().min(1).max(replyLimit).regex(/\S/, "Write a reply before sending"),
});

export const askPresentationSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  detail: z.string().max(2048).optional(),
  placeholder: z.string().max(200).optional(),
  suggestions: z.array(z.string().min(1).max(200)).max(6).optional(),
});
export type AskPresentation = z.infer<typeof askPresentationSchema>;
export const askParameters = askPresentationSchema.extend({ message: z.string().min(1).max(4096) });

export const ask = createDurableTool("ask")
  .description(
    "Ask one conversational question. message is the question; optional title labels the activity, detail gives user-visible context, placeholder hints at a reply, and up to six suggestions offer editable drafts (not automatic answers). Never include hidden state in presentation fields. Free-form corrections and questions remain available. Parks until the user accepts, declines, or cancels. Accepted replies include exchange.messages for sampling history. Preserve the literal reply; it may answer, correct earlier information, or ask a question.",
  )
  .identity({ version: "0.0.1", digest: sha256("yo-tisyn.ask@0.0.1:conversational-card-v3") })
  .parameters(askParameters)
  .output(
    z.union([
      z.object({ action: z.literal("accept"), content: replySchema, exchange: exchangeSchema }),
      z.object({ action: z.literal("decline") }),
      z.object({ action: z.literal("cancel") }),
    ]),
  )
  .elicits({
    reply: {
      response: replySchema,
      context: askPresentationSchema.extend({ prompt: z.string() }),
    },
  })
  .execute(function* ({ message, ...presentation }, context) {
    const elicitContext = { prompt: message, ...presentation };
    const exchangeId = yield* context.record(
      { key: "ask.exchange-id", retrySafety: { mode: "repeatable" } },
      function* (attempt) {
        return attempt.pullId;
      },
    );
    const response = yield* context.elicit("reply", { message, context: elicitContext });
    const completed = yield* completeElicitExchange({
      key: "reply",
      message,
      context: elicitContext,
      exchangeId,
      responseSchema: replySchema,
      completion: response,
    });
    return completed.action === "accept"
      ? {
          action: "accept" as const,
          content: completed.content,
          exchange: projectExchange(completed.exchange),
        }
      : { action: completed.action };
  });
