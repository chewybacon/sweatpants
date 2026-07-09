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
  expectConfirmationTokenCount,
  expectElicit,
  expectElicitCount,
  expectNoOpenInterruptError,
  expectNoRunError,
  expectOutcome,
  expectRunFinished,
  expectToolCallCount,
  expectToolCalled,
} from "../lib/assertions.ts";
import { requireCopilotAuth } from "../lib/auth.ts";
import type { ChatBinding } from "../lib/chat-fetch.ts";
import { runChatFlow } from "../lib/driver.ts";
import { withFlakePolicy } from "../lib/flake.ts";
import { liveReady, selectedTiers } from "./tiers.ts";

function bookFlightResponder(elicit: { key: string }) {
  if (elicit.key === "pickFlight") {
    return { action: "accept" as const, content: { flightId: "FL001" } };
  }
  if (elicit.key === "pickSeat") {
    return { action: "accept" as const, content: { row: 1, seat: "A" } };
  }
  return { action: "decline" as const };
}

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
              respondToElicit: bookFlightResponder,
            },
          ],
        }),
      );

      expectToolCalled(transcript, "book_flight");
      expectElicit(transcript, "pickFlight");
      expectElicit(transcript, "pickSeat");
      expectNoRunError(transcript);
      expectNoOpenInterruptError(transcript);
      expectRunFinished(transcript);
      expectOutcome(transcript, "success");
      expectConfirmationToken(transcript);
    }, 120_000);

    it("infers the return route from outbound history without restating cities", async () => {
      const { bookFlightPlugin } = await import("@/tools/book-flight");
      const transcript = await withFlakePolicy(() =>
        runChatFlow(binding, {
          plugins: [bookFlightPlugin],
          initialToolChoice: "required",
          systemPrompt: `You are a flight booking assistant.
When the user wants to book a flight, call book_flight.
After a booking completes, answer follow-ups from conversation history.
If the user says "book the return flight" without restating cities, reverse the previous route and call book_flight again.`,
          turns: [
            {
              message:
                "Use the available flight booking tool to book an outbound flight from Los Angeles to New York. Do not answer directly.",
              respondToElicit: bookFlightResponder,
            },
            {
              // Do not restate cities — history must carry the route.
              message: "ok, book the return flight",
              respondToElicit: bookFlightResponder,
            },
          ],
        }),
      );

      // Outbound + return = two tool calls and two confirmation tokens.
      expectToolCallCount(transcript, "book_flight", 2);
      expectElicitCount(transcript, "pickFlight", 2);
      expectElicitCount(transcript, "pickSeat", 2);
      expectConfirmationTokenCount(transcript, 2);
      expectNoRunError(transcript);
      expectNoOpenInterruptError(transcript);
      expectRunFinished(transcript, 2);
      expectOutcome(transcript, "success");
    }, 180_000);
  });
}
