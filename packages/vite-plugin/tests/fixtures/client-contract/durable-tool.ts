import { createDurableTool } from "@sweatpants/agent-sdk/legacy";
import { z } from "zod";
import { durableServerEffect, durableServerExecute } from "./server-only.ts";

export const durableTool = createDurableTool("durable", { version: "1.0.0" })
  .description("DURABLE_CONTRACT_MARKER")
  .parameters(z.object({ value: z.string() }))
  .elicits({ choose: { response: z.object({ value: z.string() }) } })
  .effects({ run: durableServerEffect })
  .execute(durableServerExecute);
