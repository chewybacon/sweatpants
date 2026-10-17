import { ensure } from "effection";
import type { Operation } from "effection";
import { defineCompiledWorkflow } from "./definition.ts";

type Input = { title: string; recipient: string; metadata: null };
type Reply = { content: { approved: boolean } };
interface Context {
  elicit(key: string, message: string): Operation<Reply>;
}

function* review_draft(ctx: Context, input: Input) {
  "use workflow";
  yield* ensure(function* () {
    yield* ctx.elicit("cleanup", "Release the draft reservation?");
  });
  const answer = yield* ctx.elicit("approval", input.title);
  if (answer.content.approved) {
    return "Draft approved";
  }
  return "Draft declined";
}

export const reviewDraft = defineCompiledWorkflow(review_draft);
