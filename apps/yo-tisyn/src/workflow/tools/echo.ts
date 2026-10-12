import { createDurableTool } from "@sweatpants/agent-sdk";
import { sha256 } from "@sweatpants/foundation";
import { z } from "zod";

export const echo = createDurableTool("echo")
  .description("Record the supplied message and return it unchanged.")
  .identity({ version: "0.0.1", digest: sha256("yo-tisyn.echo@0.0.1:record-message") })
  .parameters(z.object({ message: z.string().max(4096) }))
  .output(z.object({ message: z.string() }))
  .execute(function* (input, context) {
    return yield* context.record(
      { key: "echo", retrySafety: { mode: "repeatable" } },
      function* () {
        return { message: input.message };
      },
    );
  });
