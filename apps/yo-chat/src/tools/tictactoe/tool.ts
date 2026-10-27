import { createTool } from "@sweatpants/agent-sdk";
import { tictactoeTool as portableTictactoe } from "../primitive/tictactoe.ts";
import { PickMoveContextSchema } from "../schemas/tictactoe.ts";
export type { TicTacToeResult } from "../primitive/tictactoe.ts";

/** Ordinary placement shares the portable game, including its progress reporting. */
export const tictactoeTool = createTool(portableTictactoe.name)
  .description(portableTictactoe.description)
  .parameters(portableTictactoe.parameters)
  .elicits(portableTictactoe.elicits)
  .samples()
  .execute(function* (input, ctx) {
    return yield* portableTictactoe.invokeWith(input, "tictactoe", function* (request) {
      switch (request.kind) {
        case "effect":
          if (request.key !== "random") {
            throw new Error(`Unknown game effect: ${request.key}`);
          }
          return Math.random();
        case "elicit": {
          if (request.key !== "pickMove") {
            throw new Error(`Unknown game elicitation: ${request.key}`);
          }
          const result = yield* ctx.elicit("pickMove", {
            message: request.message,
            context: PickMoveContextSchema.parse(request.context),
          });
          return result.action === "accept"
            ? { action: result.action, content: result.content }
            : { action: result.action };
        }
        case "nested-sample":
          return yield* ctx.sample({ prompt: request.prompt, maxTokens: request.maxTokens });
        case "progress":
          yield* ctx.notify(request.message, request.progress);
          return;
        case "log":
          yield* ctx.log(request.level, request.message);
          return;
      }
    });
  });
