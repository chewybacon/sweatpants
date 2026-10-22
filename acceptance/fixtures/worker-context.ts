import { isMainThread, threadId } from "node:worker_threads";
import { createTool } from "@sweatpants/agent-sdk";
import { z } from "zod";

export const workerContext = createTool("worker_context")
  .description("Observe the authored worker context across typed exchanges")
  .parameters(z.object({}))
  .elicits({
    first: { response: z.object({ value: z.string() }) },
    second: { response: z.object({ value: z.string() }) },
  })
  .samples({ note: { description: "A named private sample" } })
  .execute(function* (_, ctx) {
    const first = yield* ctx.elicit("first", { message: "First choice" });
    if (first.action !== "accept") {
      return { selected: false, reason: first.action };
    }
    const second = yield* ctx.elicit("second", { message: "Second choice" });
    if (second.action !== "accept") {
      return { selected: false, reason: second.action };
    }
    const before = ctx.messages.length;
    const sample = yield* ctx.sample("note", { prompt: "PRIVATE_CONTEXT_NOTE" });
    return {
      selected: true,
      first: first.content.value,
      second: second.content.value,
      note: sample.text,
      before,
      after: ctx.messages.length,
      isMainThread,
      threadId,
    };
  });
