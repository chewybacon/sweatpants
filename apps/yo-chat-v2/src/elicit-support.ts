import { z } from "zod";
import type { ElicitSupport, ElicitSelection } from "@sweatpan.ts/tools";

// Application wire decoding; handler coverage does not prove schema compatibility.
export const supportSchema = z.object({
  tool: z.string(),
  elicits: z.array(z.string()),
}) satisfies z.ZodType<ElicitSupport>;
export const selectionSchema = z.object({
  tool: z.string(),
  routes: z.record(z.string(), z.enum(["client", "server"])),
}) satisfies z.ZodType<ElicitSelection>;
