import type { Operation } from "effection";
import type { WorkflowContext } from "./contract.mjs";

export function authoringContract(ctx: WorkflowContext): Operation<string> {
  const reply: Operation<string> = ctx.elicit("approval", { message: "Review draft" });
  // @ts-expect-error Only declared aliases are available to the author.
  ctx.elicit("sample", { message: "No declaration" });
  // @ts-expect-error Caller input comes from the declared context schema.
  ctx.effect("cleanup", { message: 42 });
  // @ts-expect-error The declared response is string, not boolean.
  const wrong: Operation<boolean> = reply;
  void wrong;
  return reply;
}
