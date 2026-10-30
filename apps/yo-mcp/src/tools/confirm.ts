/**
 * Confirm Tool
 *
 * A tool that demonstrates a simple confirmation flow with elicitation.
 */
import { z } from "zod";
import { createDurableTool } from "@sweatpants/agent-sdk";

const confirmSchema = z.object({
  confirmed: z.boolean().describe("Whether to proceed"),
  reason: z.string().optional().describe("Optional reason for your choice"),
});

export const confirmTool = createDurableTool("confirm", { version: "1" })
  .description("Ask the user to confirm an action")
  .parameters(
    z.object({
      action: z.string().describe("Description of the action to confirm"),
      dangerous: z.boolean().default(false).describe("Whether this is a dangerous action"),
    }),
  )
  .effects({})
  .elicits({
    confirmation: { response: confirmSchema },
  })
  .execute(function* (params, ctx) {
    const prefix = params.dangerous ? "WARNING: " : "";
    const message = `${prefix}${params.action}\n\nDo you want to proceed?`;

    yield* ctx.log("info", `Requesting confirmation for: ${params.action}`);

    const result = yield* ctx.elicit("confirmation", { message });

    if (result.action === "decline") {
      return {
        confirmed: false,
        action: params.action,
        message: "User declined the confirmation dialog.",
      };
    }

    if (result.action === "cancel") {
      return {
        confirmed: false,
        action: params.action,
        message: "User cancelled the confirmation dialog.",
      };
    }

    return {
      confirmed: result.content.confirmed,
      action: params.action,
      // CONDITIONAL-SPREAD: omit an unanswered optional reason at the JSON boundary.
      ...(result.content.reason === undefined ? {} : { reason: result.content.reason }),
      message: result.content.confirmed
        ? `User confirmed: ${params.action}`
        : `User rejected: ${params.action}${result.content.reason ? ` (Reason: ${result.content.reason})` : ""}`,
    };
  });
