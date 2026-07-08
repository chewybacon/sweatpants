/**
 * book_flight flow (design R7): multi-elicit (pickFlight → pickSeat) → `TKT-`
 * confirmation, driven headlessly over the fetch seam with the real model.
 *
 * Asserts on robust outcomes only: the tool was called, both elicit keys were
 * emitted, no RUN_ERROR, terminal success, and a `TKT-` confirmation token.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  expectConfirmationToken,
  expectElicit,
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
  describe.skipIf(!liveReady())(`book_flight flow [${tier.name}]`, () => {
    let binding: ChatBinding;

    beforeAll(async () => {
      requireCopilotAuth();
      binding = await tier.create();
    });
    afterAll(async () => {
      await binding?.close();
    });

    it("books a flight through pickFlight → pickSeat and returns a TKT- confirmation", async () => {
      const { bookFlightPlugin } = await import("@/tools/book-flight");
      const transcript = await withFlakePolicy(() =>
        runChatFlow(binding, {
          plugins: [bookFlightPlugin],
          initialToolChoice: "required",
          turns: [
            {
              message:
                "Use the available flight booking tool to book a flight from NYC to LAX. Do not answer directly.",
              respondToElicit: (elicit) => {
                if (elicit.key === "pickFlight") {
                  return { action: "accept", content: { flightId: "FL001" } };
                }
                if (elicit.key === "pickSeat") {
                  return { action: "accept", content: { row: 1, seat: "A" } };
                }
                return { action: "decline" };
              },
            },
          ],
        }),
      );

      expectToolCalled(transcript, "book_flight");
      expectElicit(transcript, "pickFlight");
      expectElicit(transcript, "pickSeat");
      expectNoRunError(transcript);
      expectRunFinished(transcript);
      expectOutcome(transcript, "success");
      expectConfirmationToken(transcript);
    }, 120_000);
  });
}
