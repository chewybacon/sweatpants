import { createDurableTool } from "@sweatpants/agent-sdk/primitive";
import { z } from "zod";

/** Generator replay is pure; the counted external operation is accepted once. */
export const mcpSingleChoice = createDurableTool("choose_number", { version: "1" })
  .description("Choose one numbered option")
  .parameters(z.object({ count: z.number().int().min(2).max(10) }))
  .effects({
    count: { version: "1", input: z.null(), output: z.null(), retrySafety: { mode: "unsafe" } },
  })
  .elicits({
    choose: {
      response: z.object({ number: z.number().min(1) }),
      context: z.object({ options: z.array(z.number()) }),
    },
  })
  .execute(function* ({ count }, context) {
    yield* context.effect("count", null);
    const response = yield* context.elicit("choose", {
      message: "Choose a number",
      context: { options: Array.from({ length: count }, (_, index) => index + 1) },
    });
    return response.action === "accept"
      ? { action: response.action, selected: response.content.number }
      : { action: response.action, selected: null };
  });
