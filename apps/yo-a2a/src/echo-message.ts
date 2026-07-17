import { createDurableTool, type AgentProgramBinding } from "@sweatpants/core";
import { sha256, type DurableTool } from "@sweatpants/session-contract";
import { z } from "zod";

/** A real crank-native tool whose plain-text elicitation is easy to drive from chat UIs. */
export const echoMessage = createDurableTool("echo_message")
  .description("Ask the user for a plain-text message, then echo the accepted value")
  .identity({ version: "1.0.0", digest: sha256("yo-a2a.echo-message@1.0.0") })
  .parameters(z.object({}))
  .output(z.object({ echoed: z.string() }))
  .elicits({ echoText: z.string().min(1).max(1_000) })
  .effects({})
  .execute(function* (_input, context) {
    const response = yield* context.elicit("echoText", {
      message: "What message should I echo? Reply with plain text.",
    });
    if (response.action !== "accept") {return { echoed: "The echo was declined." };}
    return { echoed: response.content };
  });

export const echoMessageBinding: AgentProgramBinding = Object.freeze({
  program: echoMessage as unknown as DurableTool,
  schemas: echoMessage.artifacts.catalog,
  resources: Object.freeze([]),
});
