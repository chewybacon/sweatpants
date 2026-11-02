import { createDurableTool } from "@sweatpants/agent-sdk/legacy";
import { ensure } from "effection";
import { z } from "zod";
export const holds = createDurableTool("captured-holds", { version: "1" })
  .description("Acquire holds and release them when the scope closes")
  .parameters(z.strictObject({ count: z.number().int().min(0) }))
  .output(z.number())
  .elicits({
    acquire: { response: z.strictObject({ id: z.string() }) },
    release: { response: z.string() },
  })
  .execute(function* (input, ctx) {
    "use workflow";
    let remaining = input.count;
    while (remaining > 0) {
      const hold = yield* ctx.elicit("acquire", { message: "Reserve a hold" });
      if (hold.action !== "accept") {
        throw "Hold declined";
      }
      yield* ensure(function* () {
        yield* ctx.elicit("release", { message: hold.content.id });
      });
      remaining = remaining - 1;
    }
    return remaining;
  });
