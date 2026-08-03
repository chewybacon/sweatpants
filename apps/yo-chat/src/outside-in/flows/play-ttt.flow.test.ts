/**
 * play_ttt flow (design R7): the agentic tic-tac-toe tool that combines
 * worker-side model **sampling** (`ctx.sampleTools` / `ctx.sampleSchema` pick the
 * model's move and strategy) with `pickMove` elicits for the human's move —
 * driven headlessly over the fetch seam with the real model.
 *
 * This is the only flow that exercises the worker sampling round-trip. It plays
 * the game to a real terminal tool result and final board (instead of stopping
 * at the first interrupt) so the outside-in tier stays equivalent to the old
 * browser outcome coverage while remaining headless and fail-fast.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import { playTttPlugin } from "@/tools/play-ttt";
import {
  expectElicit,
  expectNoOpenInterruptError,
  expectNoRunError,
  expectNoToolRelaunchAfter,
  expectOutcome,
  expectRunFinished,
  expectTerminalTicTacToeResult,
  expectToolCallCount,
  expectToolCalled,
} from "../lib/assertions.ts";
import { requireCopilotAuth } from "../lib/auth.ts";
import type { ElicitState } from "@sweatpants/chat-core";
import type { ChatBinding } from "../lib/chat-fetch.ts";
import { runChatFlow } from "../lib/driver.ts";
import { AssertionFailure, withFlakePolicy } from "../lib/flake.ts";
import { liveReady, selectedTiers } from "./tiers.ts";

function elicitContext(elicit: ElicitState): Record<string, unknown> {
  if (elicit.context && typeof elicit.context === "object" && !Array.isArray(elicit.context)) {
    return elicit.context;
  }
  return {};
}

function chooseDeterministicMove(elicit: ElicitState) {
  const context = elicitContext(elicit) as { board?: unknown; gameOver?: unknown };
  if (context.gameOver === true) {
    return { action: "accept" as const, content: { position: -1 } };
  }
  if (!Array.isArray(context.board)) {
    throw new AssertionFailure("pickMove elicit missing board context");
  }
  const position = context.board.findIndex((cell) => cell === null);
  if (position < 0) {
    throw new AssertionFailure("pickMove elicit has no legal empty cell");
  }
  return { action: "accept" as const, content: { position } };
}

for (const tier of selectedTiers()) {
  describe.skipIf(!liveReady())(`play_ttt flow [${tier.name}]`, () => {
    let binding: ChatBinding;

    beforeAll(async () => {
      requireCopilotAuth();
      binding = await tier.create();
    });
    afterAll(async () => {
      await binding?.close();
    });

    it("plays through the worker sampling loop to a terminal board", async () => {
      const transcript = await withFlakePolicy(() =>
        runChatFlow(binding, {
          plugins: [playTttPlugin],
          initialToolChoice: "required",
          turns: [
            {
              message:
                "Play exactly one game of tic-tac-toe with me using the play_ttt tool. Make your moves and let me make mine. Do not answer directly.",
              respondToElicit: (elicit) =>
                elicit.key === "pickMove" ? chooseDeterministicMove(elicit) : { action: "decline" },
            },
          ],
        }),
      );

      expectToolCalled(transcript, "play_ttt");
      // A pickMove elicit can only be emitted after the worker sampled the
      // model's move, so this proves the worker sampling round-trip ran; the
      // terminal result proves the full elicit→resume loop completed.
      expectElicit(transcript, "pickMove");
      expectTerminalTicTacToeResult(transcript, "play_ttt");
      expectNoRunError(transcript);
      expectNoOpenInterruptError(transcript);
      expectRunFinished(transcript);
      expectOutcome(transcript, "success");
    });

    it("answers a free-form follow-up after the game without re-launching play_ttt", async () => {
      const transcript = await withFlakePolicy(() =>
        runChatFlow(binding, {
          plugins: [playTttPlugin],
          initialToolChoice: "required",
          systemPrompt: `You are the Agentic Tic-Tac-Toe demo controller.
When the user wants to play, call play_ttt once.
After a game completes, answer follow-up questions from conversation history.
Do NOT call play_ttt again unless the user explicitly asks to play another game.`,
          turns: [
            {
              message:
                "Play exactly one game of tic-tac-toe with me using the play_ttt tool. Make your moves and let me make mine. Do not answer directly.",
              respondToElicit: (elicit) =>
                elicit.key === "pickMove" ? chooseDeterministicMove(elicit) : { action: "decline" },
            },
            {
              message: "who won?",
            },
          ],
        }),
      );

      expectToolCallCount(transcript, "play_ttt", 1);
      expectTerminalTicTacToeResult(transcript, "play_ttt");
      // Follow-up must not re-open a tool call / fresh interrupt board.
      expectNoToolRelaunchAfter(transcript, "play_ttt", 1);
      expectNoOpenInterruptError(transcript);
      expectNoRunError(transcript);
      expectRunFinished(transcript, 2);
      expectOutcome(transcript, "success");
    });
  });
}
