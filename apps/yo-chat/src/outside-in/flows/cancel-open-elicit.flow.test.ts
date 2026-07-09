/**
 * Free-form follow-up while a plugin interrupt is open.
 *
 * Regression: the client used to POST a plain message with no resume[], and the
 * server rejected it with "Open interrupts require resume[]". Cancel-on-send
 * must close the open interrupt and let the free-form turn complete.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  expectElicit,
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
  describe.skipIf(!liveReady())(`cancel open elicit on free-form send [${tier.name}]`, () => {
    let binding: ChatBinding;

    beforeAll(async () => {
      requireCopilotAuth();
      binding = await tier.create();
    });
    afterAll(async () => {
      await binding?.close();
    });

    it("accepts a free-form follow-up while pick_card is still waiting for a click", async () => {
      const { pickCardPlugin } = await import("@/tools/pick-card");
      const transcript = await withFlakePolicy(() =>
        runChatFlow(binding, {
          plugins: [pickCardPlugin],
          initialToolChoice: "required",
          // Keep the free-form answer from re-opening tools.
          systemPrompt: `You can use pick_card when the user asks to draw/pick cards.
If the user asks a free-form question while a picker is open or after cancelling it, answer in prose. Do not call pick_card again unless they explicitly ask to pick a card.`,
          timeoutMs: 90_000,
          turns: [
            {
              message:
                "Use the available pick_card tool to draw 3 cards for me. Do not answer directly.",
              // Leave the interrupt open so the next free-form send must cancel it.
              respondToElicit: () => null,
            },
            {
              message: "why did you launch a game? Answer in one short sentence. Do not call any tools.",
              // If anything re-opens, decline — free-form must still not hit the gate.
              respondToElicit: () => ({ action: "decline" }),
            },
          ],
        }),
      );

      // Structural regression gate: an open pickCard interrupt followed by a
      // free-form send must NOT hit "Open interrupts require resume[]".
      // Live models may still re-call tools after cancel; that is nondeterminism,
      // not the gate bug. Hermetic unit tests pin no-relaunch more tightly.
      expectToolCalled(transcript, "pick_card");
      expectElicit(transcript, "pickCard");
      expectNoOpenInterruptError(transcript);
      expectNoRunError(transcript);
      expectRunFinished(transcript, 1);
      expectOutcome(transcript, "success");
    }, 150_000);
  });
}
