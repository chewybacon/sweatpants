import { isMainThread } from "node:worker_threads";
import { createTool } from "@sweatpants/agent-sdk";
import { z } from "zod";

/** Observe the thread actually executing the authored tool body. */
export const executionLocation = createTool("execution_location")
  .description("Report the execution placement")
  .parameters(z.object({}))
  .execute(function* () {
    return { onMainThread: isMainThread };
  });
