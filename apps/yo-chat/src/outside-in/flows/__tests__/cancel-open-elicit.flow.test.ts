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
  expectToolCalled,
} from "../../lib/assertions.ts";
import { requireModelAuth } from "../../lib/auth.ts";
import type { ChatBinding } from "../../lib/chat-fetch.ts";
import { runChatFlow } from "../../lib/driver.ts";
import { withFlakePolicy } from "../../lib/flake.ts";
import { liveReady, selectedTiers } from "../tiers.ts";

for (const tier of selectedTiers()) {
  describe.skipIf(!liveReady())(`cancel open elicit on free-form send [${tier.name}]`, () => {
    let binding: ChatBinding;

    beforeAll(async () => {
      requireModelAuth();
      binding = await tier.create();
    });
    afterAll(async () => {
      await binding.close();
    });

    it("accepts a free-form follow-up while pick_card is still waiting for a click", async () => {
      const transcript = await withFlakePolicy(() =>
        runChatFlow(binding, {
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
              message:
                "why did you launch a game? Answer in one short sentence. Do not call any tools.",
              // Live models sometimes re-open pick_card after cancel even though
              // the gate bug is fixed. If that happens, leave the new interrupt
              // unanswered and assert only that we did not hit
              // "Open interrupts require resume[]".
              respondToElicit: () => null,
            },
          ],
        }),
      );

      // Structural regression gate: an open pickCard interrupt followed by a
      // free-form send must NOT hit "Open interrupts require resume[]".
      // Live models may still re-call tools after cancel; that is nondeterminism,
      // not the gate bug. Hermetic unit tests pin no-relaunch / terminal success
      // more tightly, so this live test only asserts the gate remains open.
      expectToolCalled(transcript, "pick_card");
      expectElicit(transcript, "pickCard");
      expectNoOpenInterruptError(transcript);
      expectNoRunError(transcript);
    });
  });
}
