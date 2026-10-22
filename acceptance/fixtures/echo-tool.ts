import { createTool } from "@sweatpants/agent-sdk";
import { z } from "zod";

export const echoTool = createTool("echo")
  .description("Echo a message")
  .parameters(z.object({ message: z.string() }))
  .execute(function* (params) {
    return { echoed: params.message };
  });
export const strictEcho = createTool("strict_echo")
  .description("Strict echo")
  .parameters(z.object({ message: z.string() }))
  .execute(function* (params) {
    return { echoed: params.message };
  });
export const exitWorker = createTool("exit_worker")
  .description("Terminate the current tool worker for failure testing")
  .parameters(z.object({}))
  .execute(function* () {
    process.exit(70);
  });
