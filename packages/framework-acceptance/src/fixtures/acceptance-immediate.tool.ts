import { z } from "zod";
import { createTool } from "@sweatpants/core";

export const ACCEPTANCE_IMMEDIATE_TOOL_NAME = "acceptance_immediate";
export const IMMEDIATE_RESULT_MARKER = "IMMEDIATE_RESULT_V1";

export const acceptanceImmediateTool = createTool(ACCEPTANCE_IMMEDIATE_TOOL_NAME)
  .description("Deterministic immediate/failure acceptance fixture")
  .parameters(
    z.object({
      value: z.string(),
      behavior: z.enum(["complete", "throw", "invalid_output"]).default("complete"),
    }),
  )
  .output(
    z.object({
      marker: z.literal(IMMEDIATE_RESULT_MARKER),
      value: z.string(),
    }),
  )
  .execute(function* ({ value, behavior }) {
    if (behavior === "throw") {
      throw new Error(`planned tool failure: ${value}`);
    }
    if (behavior === "invalid_output") {
      return "invalid output" as never;
    }
    return { marker: IMMEDIATE_RESULT_MARKER, value };
  });
