import { createTool } from "@sweatpants/agent-sdk";
import { z } from "zod";

export const invocations: string[] = [];
export const immediateTool = createTool("immediate")
  .description("Return a value, fail, or violate the output schema")
  .parameters(
    z.object({
      value: z.string(),
      behavior: z.enum(["complete", "throw", "invalid_output"]).default("complete"),
    }),
  )
  .output(z.object({ value: z.string() }))
  .execute(function* ({ value, behavior }) {
    invocations.push(value);
    if (behavior === "throw") {
      throw new Error(`planned tool failure: ${value}`);
    }
    if (behavior === "invalid_output") {
      return "invalid output" as never;
    }
    return { value };
  });
