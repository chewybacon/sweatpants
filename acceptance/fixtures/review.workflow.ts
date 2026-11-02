import { ensure, type Operation } from "effection";
import { z } from "zod";
import { createDurableTool } from "@sweatpants/agent-sdk/legacy";
import type { ProgramElicitResult } from "@sweatpants/durable-execution";

type Input = { title: string };
type Reply = ProgramElicitResult<{ approved: boolean }>;
interface Context {
  elicit(key: "approval" | "cleanup", request: { message: string }): Operation<Reply>;
}

function* review(input: Input, ctx: Context): Operation<string> {
  "use workflow";
  yield* ensure(function* () {
    yield* ctx.elicit("cleanup", { message: "Release reservation?" });
  });
  const answer = yield* ctx.elicit("approval", { message: input.title });
  if (answer.action === "accept") {
    if (answer.content.approved) {
      return "approved";
    }
  }
  return "declined";
}

export const reviewTool = createDurableTool("review", { version: "1" })
  .description("Review a draft and release its reservation")
  .parameters(z.object({ title: z.string() }))
  .output(z.string())
  .elicits({
    approval: { response: z.object({ approved: z.boolean() }) },
    cleanup: { response: z.object({ approved: z.boolean() }) },
  })
  .execute(review);
