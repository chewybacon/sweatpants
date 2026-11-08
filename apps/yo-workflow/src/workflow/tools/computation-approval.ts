import { createDurableTool } from "@sweatpants/agent-sdk/legacy";
import { sha256 } from "@sweatpants/foundation";
import { z } from "zod";

/** Invoked by developer fuel policy, never exposed as a model-authored capability. */
export const computationApproval = createDurableTool("computation_approval")
  .description("Ask permission to grant a workflow another bounded computation allowance.")
  .identity({ version: "0.0.1", digest: sha256("yo-workflow.computation-approval.v1") })
  .parameters(z.object({}).strict())
  .output(z.object({ action: z.enum(["accept", "decline", "cancel"]) }))
  .elicits({
    fuel: {
      response: z.object({}).strict(),
      context: z.object({ message: z.string() }),
    },
  })
  .execute(function* (_input, context) {
    const message = "This workflow needs more computation to finish";
    const answer = yield* context.elicit("fuel", { message, context: { message } });
    return { action: answer.action };
  });
