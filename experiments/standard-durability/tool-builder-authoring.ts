import { z } from "zod";
import { createTool } from "../../packages/agent-sdk/src/tool/create.ts";
import { createDurableTool } from "../../packages/agent-sdk/src/index.ts";

/** Existing ephemeral builder: execution is owned by the current native runtime scope. */
export const greeting = createTool("greeting")
  .description("Generate a greeting for the current request")
  .parameters(z.object({ name: z.string() }))
  .samples()
  .execute(function* ({ name }, ctx) {
    const response = yield* ctx.sample({ prompt: `Greet ${name}`, maxTokens: 100 });
    return { greeting: response.text };
  });

/** Primitive-backed durable builder: host execution accepts and replays yielded requests. */
export const approvedGreeting = createDurableTool("approved_greeting", { version: "1" })
  .description("Ask for approval, then generate a recoverable greeting")
  .parameters(z.object({ name: z.string() }))
  .samples()
  .elicits({
    approval: {
      context: z.object({ name: z.string() }),
      response: z.object({ approved: z.boolean() }),
    },
  })
  .execute(function* ({ name }, ctx) {
    const answer = yield* ctx.elicit("approval", {
      message: `Generate a greeting for ${name}?`,
      context: { name },
    });
    if (answer.action !== "accept" || !answer.content.approved) {
      return { status: "declined" as const };
    }
    const response = yield* ctx.sample({ prompt: `Greet ${name}`, maxTokens: 100 });
    return { status: "generated" as const, greeting: response.text };
  });
