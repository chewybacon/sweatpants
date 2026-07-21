import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookFlightPlugin } from "@/tools/book-flight";
import {
  expectConfirmationToken,
  expectElicit,
  expectFinalTextMatches,
  expectNoRunError,
  expectOutcome,
  expectToolCalled,
} from "../lib/assertions.ts";
import type { ChatBinding } from "../lib/chat-fetch.ts";
import {
  startInteractiveConversation,
  type InteractiveChatConversation,
} from "./interactive-chat-conversation.ts";
import {
  startOpenAiResponsesSimulator,
  type OpenAiResponsesSimulator,
} from "./openai-responses-simulator.ts";

const SPIKE_MODEL_ID = "sweatpants-openai-simulator-spike";

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

describe("interactive OpenAI simulator semantic barriers", () => {
  let simulator: OpenAiResponsesSimulator;
  let binding: ChatBinding;
  let conversation: InteractiveChatConversation;

  beforeAll(async () => {
    simulator = await startOpenAiResponsesSimulator();

    // Import Tier A only after configuring the app's real model-selection path.
    // The model provider still resolves and invokes pi-ai normally; only its
    // OpenAI base URL points at the Simulacrum HTTP server.
    process.env["DEFAULT_CHAT_MODEL_PROVIDER"] = "openai";
    process.env["DEFAULT_CHAT_MODEL_ID"] = SPIKE_MODEL_ID;
    process.env["OPENAI_BASE_URL"] = simulator.baseUrl;
    process.env["OPENAI_API_KEY"] = "sk-simulacrum-spike";

    const { createTierABinding } = await import("../lib/tier-a.ts");
    binding = createTierABinding();
    conversation = startInteractiveConversation(binding, {
      plugins: [bookFlightPlugin],
    });
  });

  afterAll(async () => {
    await conversation?.close();
    await binding?.close();
    await simulator?.close();
  });

  it("controls two turns while preserving model-visible conversation history", async () => {
    const bookingTurn = conversation.send(
      "Book a flight from NYC to LAX using the available tool.",
    );

    const initialModelCall = await simulator.nextRequest();
    expect(initialModelCall.pullId).toBeTruthy();
    expect(initialModelCall.request).toMatchObject({
      model: SPIKE_MODEL_ID,
      stream: true,
    });
    expect(records(initialModelCall.request.tools)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          name: "book_flight",
        }),
      ]),
    );
    await initialModelCall.respond({
      type: "tool_call",
      callId: "call_book_flight_spike",
      name: "book_flight",
      arguments: { from: "NYC", destination: "LAX" },
    });

    const pickFlight = await bookingTurn.nextElicit("pickFlight");
    await pickFlight.accept({ flightId: "FL001" });

    const pickSeat = await bookingTurn.nextElicit("pickSeat");
    await pickSeat.accept({ row: 1, seat: "A" });

    const nestedSample = await simulator.nextRequest();
    expect(nestedSample.pullId).toBeTruthy();
    expect(nestedSample.pullId).not.toBe(initialModelCall.pullId);
    expect(JSON.stringify(records(nestedSample.request.input))).toContain(
      "Give a brief, helpful travel tip",
    );
    expect(nestedSample.request).toMatchObject({ max_output_tokens: 100 });
    await nestedSample.respond({
      type: "text",
      text: "Use the airport train to avoid traffic into the city center.",
    });

    const bookingSummary = await simulator.nextRequest();
    const bookingSummaryInput = records(bookingSummary.request.input);
    expect(bookingSummaryInput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call",
          call_id: "call_book_flight_spike",
          name: "book_flight",
        }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_book_flight_spike",
        }),
      ]),
    );
    await bookingSummary.respond({
      type: "text",
      text: "Booking complete. Confirmation: TKT-SPIKE123",
    });

    const bookingTranscript = await bookingTurn.complete();
    expectToolCalled(bookingTranscript, "book_flight");
    expectElicit(bookingTranscript, "pickFlight");
    expectElicit(bookingTranscript, "pickSeat");
    expectConfirmationToken(bookingTranscript, /TKT-SPIKE123/);
    expectNoRunError(bookingTranscript);
    expectOutcome(bookingTranscript, "success");

    const historyTurn = conversation.send(
      "What route did I just book? Answer from our conversation and do not use a tool.",
    );
    const historyModelCall = await simulator.nextRequest();
    const historyInput = records(historyModelCall.request.input);
    const serializedHistory = JSON.stringify(historyInput);

    await historyModelCall.respond({
      type: "text",
      text: "You booked a flight from NYC to LAX.",
    });

    const historyTranscript = await historyTurn.complete();
    expect(serializedHistory).toContain("Book a flight from NYC to LAX");
    expect(serializedHistory).toContain("TKT-SPIKE123");
    expect(serializedHistory).toContain("What route did I just book?");
    expectFinalTextMatches(historyTranscript, /NYC to LAX/);
    expectNoRunError(historyTranscript);
    expectOutcome(historyTranscript, "success");

    expect(conversation.conversationId).toBeTruthy();
    expect(simulator.requests).toHaveLength(4);
    simulator.assertIdle();
  }, 30_000);
});
