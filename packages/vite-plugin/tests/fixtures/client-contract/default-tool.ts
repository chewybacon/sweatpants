import { createTool } from "@sweatpants/agent-sdk";
import { z } from "zod";
import { ordinaryServerExecute } from "./server-only.ts";

export default createTool("default")
  .description("DEFAULT_CONTRACT_MARKER")
  .parameters(z.object({ value: z.string() }))
  .elicits({ choose: { response: z.object({ value: z.string() }) } })
  .execute(ordinaryServerExecute);
