import { createDurableTool } from "@sweatpants/agent-sdk";
import { z } from "zod";

/** A real crank-native tool whose plain-text elicitation is easy to drive from chat UIs. */
export const echoMessage = createDurableTool("echo_message", { version: "1.0.0" })
  .description("Ask the user for a plain-text message, then echo the accepted value")
  .parameters(z.object({}))
  .output(z.object({ echoed: z.string() }))
  .elicits({ echoText: z.string().min(1).max(1_000) })
  .effects({})
  .execute(function* (_input, context) {
    const response = yield* context.elicit("echoText", {
      message: "What message should I echo? Reply with plain text.",
    });
    if (response.action !== "accept") {
      return { echoed: "The echo was declined." };
    }
    return { echoed: response.content };
  });
