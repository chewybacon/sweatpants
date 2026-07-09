/**
 * Multi-turn tool-calling flow (design R7): a tool is invoked across two turns,
 * verifying the tool-call history is carried forward so the model can call the
 * tool again on the second turn. Driven headlessly over the fetch seam with the
 * real model; the tool executes inside the worker thread.
 *
 * Uses `calculator` (a non-eliciting local tool) with two independent,
 * hard-to-precompute expressions so the assertion is purely structural: both
 * turns complete (two RUN_FINISHED), the calculator tool is invoked, no
 * RUN_ERROR, terminal success. We avoid over-constraining exact call counts to
 * respect real-model nondeterminism (design R10).
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  expectNoOpenInterruptError,
  expectNoRunError,
  expectOutcome,
  expectRunFinished,
  expectToolCalled,
} from "../lib/assertions.ts";
import { requireCopilotAuth } from "../lib/auth.ts";
import type { ChatBinding } from "../lib/chat-fetch.ts";
import { runChatFlow } from "../lib/driver.ts";
import { withFlakePolicy } from "../lib/flake.ts";
import { liveReady, selectedTiers } from "./tiers.ts";

for (const tier of selectedTiers()) {
  describe.skipIf(!liveReady())(`multi-turn tool calling flow [${tier.name}]`, () => {
    let binding: ChatBinding;

    beforeAll(async () => {
      requireCopilotAuth();
      binding = await tier.create();
    });
    afterAll(async () => {
      await binding?.close();
    });

    it("calls the calculator tool on two consecutive turns", async () => {
      const { calculator } = await import("@/tools/calculator");
      const transcript = await withFlakePolicy(() =>
        runChatFlow(binding, {
          tools: [calculator],
          turns: [
            {
              message:
                "Use the calculator tool to compute 8374 * 923. Always use the tool; do not answer directly.",
            },
            {
              message:
                "Now use the calculator tool to compute 918273 - 44556. Always use the tool; do not answer directly.",
            },
          ],
        }),
      );

      expectToolCalled(transcript, "calculator");
      expectNoRunError(transcript);
      expectNoOpenInterruptError(transcript);
      expectOutcome(transcript, "success");

      // Both turns must have completed (one RUN_FINISHED each) — this is the
      // robust multi-turn signal, independent of exact per-turn tool counts.
      expectRunFinished(transcript, 2);
    }, 120_000);
  });
}
