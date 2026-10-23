import { createTool } from "@sweatpants/agent-sdk";
import { z } from "zod";

/** A minimal ordinary tool: one typed exchange and one observable body entry. */
export function createSingleChoice(onExecute: () => void = () => {}) {
  return createTool("choose_number")
    .description("Choose one numbered option")
    .parameters(z.object({ count: z.number().int().min(2).max(10) }))
    .elicits({
      choose: {
        response: z.object({ number: z.number().min(1) }),
        context: z.object({ options: z.array(z.number()) }),
      },
    })
    .execute(function* ({ count }, context) {
      onExecute();
      const response = yield* context.elicit("choose", {
        message: "Choose a number",
        context: { options: Array.from({ length: count }, (_, index) => index + 1) },
      });
      return response.action === "accept"
        ? { action: response.action, selected: response.content.number }
        : { action: response.action, selected: null };
    });
}
