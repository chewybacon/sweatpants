import { createDurableTool } from "@sweatpants/agent-sdk/legacy";
import { sha256 } from "@sweatpants/foundation";
import { z } from "zod";
import { playTttTool as portablePlayTtt } from "../primitive/play-ttt.ts";
import {
  ModelCellSchema,
  PickMoveContextSchema,
  PlayTttResultSchema,
} from "../schemas/play-ttt.ts";

/** Retained transport capabilities for the single portable game body. */
export const playTttTool = createDurableTool("play_ttt")
  .description(`Play a complete game of tic-tac-toe against the user.

The program flips a recorded coin for symbols, alternates model and user moves, and returns the final board.`)
  .identity({
    version: "3.0.0",
    digest: sha256("yo-chat.play-ttt@3.0.0:portable-tool-body-v2"),
  })
  .parameters(portablePlayTtt.parameters)
  .elicits(portablePlayTtt.elicits)
  .samples()
  .execute(function* (input, context) {
    return yield* portablePlayTtt.invokeWith(input, "play_ttt", function* (request) {
      if (request.kind === "effect" && request.key === "coin") {
        return yield* context.record(
          { key: "play-ttt-symbol-coin-flip", retrySafety: { mode: "repeatable" } },
          function* () {
            return { side: Math.random() < 0.5 ? ("heads" as const) : ("tails" as const) };
          },
        );
      }
      if (request.kind === "nested-sample") {
        const sampled = yield* context.sampleSchema({
          prompt: request.prompt,
          schema: ModelCellSchema,
          retries: 2,
        });
        return { text: sampled.text, parsed: sampled.parsed };
      }
      if (request.kind === "elicit" && request.key === "pickMove") {
        return yield* context.elicit("pickMove", {
          message: request.message,
          context: PickMoveContextSchema.parse(request.context),
        });
      }
      throw new Error(`Unsupported retained game capability: ${request.kind}`);
    });
  });

export type PlayTttResult = z.infer<typeof PlayTttResultSchema>;
