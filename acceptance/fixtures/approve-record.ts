import { z } from "zod";
import { defineJournalTool } from "@sweatpants/agent-sdk/primitive";

export const approveRecord = defineJournalTool({
  name: "approve_record",
  description: "Record a request, then ask whether to finish it",
  parameters: z.object({ topic: z.string() }),
  output: z.object({ receipt: z.string(), approved: z.boolean() }),
  effects: {
    record: {
      version: "1",
      input: z.object({ topic: z.string() }),
      output: z.object({ receipt: z.string() }),
      retrySafety: { mode: "unsafe" },
    },
  },
  elicits: {
    approve: {
      response: z.object({ approved: z.boolean() }),
      context: z.object({ receipt: z.string() }),
    },
  },
  *execute({ topic }, ctx) {
    const { receipt } = yield* ctx.effect("record", { topic });
    const answer = yield* ctx.elicit("approve", {
      message: "Recorded. Finish this request?",
      context: { receipt },
    });
    return { receipt, approved: answer.action === "accept" && answer.content.approved };
  },
});
