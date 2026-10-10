import { createDurableTool } from "@sweatpants/agent-sdk";
import { sha256 } from "@sweatpants/foundation";
import { z } from "zod";

export const ask = createDurableTool("ask")
  .description("Ask the user for a text reply. Parks until the user accepts, declines, or cancels.")
  .identity({ version: "0.0.1", digest: sha256("yo-tisyn.ask@0.0.1:typed-reply") })
  .parameters(z.object({ message: z.string().max(4096) }))
  .output(
    z.union([
      z.object({ action: z.literal("accept"), content: z.object({ reply: z.string() }) }),
      z.object({ action: z.literal("decline") }),
      z.object({ action: z.literal("cancel") }),
    ]),
  )
  .elicits({
    reply: {
      response: z.object({ reply: z.string().max(4096) }),
      context: z.object({ prompt: z.string() }),
    },
  })
  .execute(function* ({ message }, context) {
    const response = yield* context.elicit("reply", { message, context: { prompt: message } });
    return response.action === "accept"
      ? { action: "accept" as const, content: response.content }
      : { action: response.action };
  });
