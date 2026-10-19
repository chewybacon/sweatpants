import { ensure, type Operation } from "effection";
import { z } from "zod";
import { createDurableTool } from "@sweatpants/agent-sdk";
import type { ProgramElicitResult } from "@sweatpants/durable-execution";

type Input = { title: string; recipient: string; metadata: null };
type Reply = ProgramElicitResult<{ approved: boolean }>;
interface Context {
  elicit(key: "approval" | "cleanup", request: { message: string }): Operation<Reply>;
}

function* review_draft(input: Input, ctx: Context): Operation<"Draft approved" | "Draft declined"> {
  "use workflow";
  yield* ensure(function* () {
    yield* ctx.elicit("cleanup", { message: "Release the draft reservation?" });
  });
  const answer = yield* ctx.elicit("approval", { message: input.title });
  if (answer.action === "accept") {
    if (answer.content.approved) {
      return "Draft approved";
    }
  }
  return "Draft declined";
}

export const reviewDraft = createDurableTool("review_draft", { version: "1" })
  .description("Review a draft and release its reservation during cleanup")
  .parameters(z.object({ title: z.string(), recipient: z.string(), metadata: z.null() }))
  .output(z.enum(["Draft approved", "Draft declined"]))
  .elicits({
    approval: { response: z.object({ approved: z.boolean() }) },
    cleanup: { response: z.object({ approved: z.boolean() }) },
  })
  .execute(review_draft);
