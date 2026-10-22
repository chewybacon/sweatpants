import { describe, expect, it } from "vitest";
import { spawn } from "effection";
import { createChatApp } from "@sweatpants/agent-host/server";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import { setupInMemoryDurableStreams } from "@sweatpants/durable-chat-runtime/response-streams";
import { withTestScenario, type TestApplicationFactoryContext } from "@sweatpants/test-rig";
import { bookTrip } from "../../fixtures/book-trip.ts";
import { tripPlugin } from "../../fixtures/trip-chat.tsx";
import { useUI } from "../../support/ui.tsx";
import { testToolRuntime } from "../../support/test-tool-runtime.ts";

function createApplication(context: TestApplicationFactoryContext) {
  const application = createChatApp({
    name: "react-plugin-example",
    secret: "react-plugin-example-secret-at-least-32-bytes",
    storage: { kind: "memory" },
    tools: [bookTrip],
    basePath: "/assistant",
    model: {
      model: context.model.model,
      driver: createPiAiModelProvider().driver,
      streamOptions: context.model.streamOptions,
    },
    execution: testToolRuntime(),
    setup: {
      application: function* () {
        yield* setupInMemoryDurableStreams<string>();
      },
    },
  });
  return { handle: application.handler, close: () => application.close() };
}

// The rig hosts the real HTTP application and the external model simulator.
// Its generator API lets us consume each request after the UI action that
// caused it. The UI helper owns only composition and cleanup.
const rigOptions = { binding: "http" as const, createApplication };

// Authoring contracts exercise React -> real HTTP handler -> in-process tool
// execution -> model parser. Runtime placement has its own focused suites.
describe("application composition with authored React plugins over HTTP", () => {
  it("authors a client, hook and plugin that render two choices and complete a booking", async () => {
    await withTestScenario(rigOptions, function* (rig) {
      // Arrange: compose the UI with the authored plugin.
      using ui = yield* useUI(rig, { plugins: [tripPlugin] });

      // Act: send the user request through the chat UI.
      const bookTripButton = yield* ui.waitForEnabledButton("Book trip");
      bookTripButton.click();

      // Act: have the model invoke the authored booking tool.
      const modelRequest = yield* rig.model.request();
      yield* modelRequest.respond.toolCalls([
        { id: "booking", name: "book_trip", arguments: { destination: "Oslo" } },
      ]);

      // Act: choose a flight in the rendered plugin.
      const flight = yield* ui.waitForEnabledButton("FL-2");
      flight.click();

      // Act: choose a seat in the next rendered interaction.
      const seat = yield* ui.waitForEnabledButton("2B");
      seat.click();

      // Assert: the tool requests a travel tip for the chosen destination.
      const travelTipRequest = yield* rig.model.request();
      expect(JSON.stringify(travelTipRequest.body.input)).toContain("PRIVATE_TRAVEL_TIP for Oslo");

      // Act: answer the tool's nested model request.
      yield* travelTipRequest.respond.text("Take the train");

      // Assert: the completed tool result reaches the model on the actual wire.
      const toolResultRequest = yield* rig.model.request();
      expect(toolResultRequest.body.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "function_call_output",
            call_id: "booking",
            output: JSON.stringify({
              booked: true,
              destination: "Oslo",
              flight: "FL-2",
              seat: "2B",
              tip: "Take the train",
            }),
          }),
        ]),
      );

      // Act: let the model finish the booking response.
      yield* toolResultRequest.respond.text("Your trip is booked");

      // Assert: the UI completes successfully without leaking local render nodes.
      yield* ui.waitForText("Your trip is booked");
      const ready = yield* ui.waitForElement("chat status is ready", () =>
        ui.queryByText("ready", { selector: "output" }),
      );
      expect(ready.textContent).toBe("ready");
      expect(ui.client.getSnapshot().error).toBeNull();
      expect(JSON.stringify(ui.client.getServerSnapshot())).not.toContain('"type":"render"');
      expect(rig.model.requests()).toHaveLength(3);
    });
  });

  it("projects streamed text through the hook and preserves it on the next turn", async () => {
    await withTestScenario(rigOptions, function* (rig) {
      // Arrange: compose the UI with the authored plugin.
      using ui = yield* useUI(rig, { plugins: [tripPlugin] });

      // Act: send the user request through the chat UI.
      const bookTripButton = yield* ui.waitForEnabledButton("Book trip");
      bookTripButton.click();

      // Arrange: hold a two-part provider response for controlled release.
      const modelRequest = yield* rig.model.request();
      const stream = yield* modelRequest.respond.textStream(["Hello", " Oslo"]);

      // Act: release the first delta.
      yield* stream.releaseNext();

      // Assert: the first delta is visible before the response finishes.
      yield* ui.waitForText("Hello");

      // Act: release the second delta.
      yield* stream.releaseNext();

      // Assert: the hook projects the combined streamed text.
      yield* ui.waitForText("Hello Oslo");

      // Act: finish the provider response.
      yield* stream.finish();

      // Assert: the chat returns to ready.
      yield* ui.waitForElement("chat status is ready", () =>
        ui.queryByText("ready", { selector: "output" }),
      );

      // Act: send another request through the same client.
      const sendAgainButton = yield* ui.waitForEnabledButton("Book trip");
      sendAgainButton.click();

      // Assert: the next request carries all three wire messages in order.
      // Content boundaries stay intact; provider-generated IDs are incidental.
      const followUp = yield* rig.model.request();
      expect(followUp.body.input).toEqual([
        expect.objectContaining({
          role: "user",
          content: [expect.objectContaining({ type: "input_text", text: "Book Oslo" })],
        }),
        expect.objectContaining({
          role: "assistant",
          content: [expect.objectContaining({ type: "output_text", text: "Hello Oslo" })],
        }),
        expect.objectContaining({
          role: "user",
          content: [expect.objectContaining({ type: "input_text", text: "Book Oslo" })],
        }),
      ]);

      // Act: complete the follow-up response.
      yield* followUp.respond.text("Second answer");

      // Assert: both answers remain visible after the follow-up settles.
      yield* ui.waitForText("Second answer");
      yield* ui.waitForElement("chat status is ready", () =>
        ui.queryByText("ready", { selector: "output" }),
      );
      expect(ui.getByText("Hello Oslo").textContent).toBe("Hello Oslo");
    });
  });

  it("stops the real provider request through the public hook and can send again", async () => {
    await withTestScenario(rigOptions, function* (rig) {
      // Arrange: compose the UI with the authored plugin.
      using ui = yield* useUI(rig, { plugins: [tripPlugin] });

      // Act: send the user request through the chat UI.
      const bookTripButton = yield* ui.waitForEnabledButton("Book trip");
      bookTripButton.click();

      // Arrange: observe cancellation of the in-flight provider request.
      const modelRequest = yield* rig.model.request();
      const aborted = yield* spawn(() => modelRequest.respond.awaitAbort());

      // Act: stop the request through the public hook's UI control.
      ui.getByRole("button", { name: "Stop" }).click();

      // Assert: the provider is aborted and the chat becomes ready.
      yield* aborted;
      yield* ui.waitForElement("chat status is ready", () =>
        ui.queryByText("ready", { selector: "output" }),
      );

      // Act: send another request through the same client.
      const sendAgainButton = yield* ui.waitForEnabledButton("Book trip");
      sendAgainButton.click();
      const next = yield* rig.model.request();
      yield* next.respond.text("Continued after stop");

      // Assert: the same client can complete another request after stopping.
      yield* ui.waitForText("Continued after stop");
      yield* ui.waitForElement("chat status is ready", () =>
        ui.queryByText("ready", { selector: "output" }),
      );
      expect(ui.client.getSnapshot().error).toBeNull();
    });
  });

  it("renders a provider failure through hook state and recovers in the same client", async () => {
    await withTestScenario(rigOptions, function* (rig) {
      // Arrange: compose the UI with the authored plugin.
      using ui = yield* useUI(rig, { plugins: [tripPlugin] });

      // Act: send the user request through the chat UI.
      const bookTripButton = yield* ui.waitForEnabledButton("Book trip");
      bookTripButton.click();

      // Act: reject the provider request.
      const modelRequest = yield* rig.model.request();
      yield* modelRequest.respond.error({
        status: 503,
        code: "unavailable",
        message: "Planned provider outage",
      });

      // Assert: the public error is visible and provider internals are sanitized.
      const alert = yield* ui.waitForElement("visible chat error", () => ui.queryByRole("alert"));
      expect(alert.textContent).toBe("[model_runtime_failed] Model runtime failed");
      expect(ui.client.getSnapshot().error).toMatchObject({ code: "model_runtime_failed" });
      expect(ui.client.getSnapshot().status).toBe("error");

      // Act: send another request through the same client.
      const sendAgainButton = yield* ui.waitForEnabledButton("Book trip");
      sendAgainButton.click();
      const next = yield* rig.model.request();
      yield* next.respond.text("Service recovered");

      // Assert: recovery completes and clears the previous error banner.
      yield* ui.waitForText("Service recovered");
      yield* ui.waitForElement("chat status is ready", () =>
        ui.queryByText("ready", { selector: "output" }),
      );
      expect(ui.client.getSnapshot().error).toBeNull();
      expect(ui.queryByRole("alert")).toBeNull();
    });
  });

  for (const action of ["decline", "cancel"] as const) {
    it(`authors a plugin whose ${action} response reaches the real tool`, async () => {
      await withTestScenario(rigOptions, function* (rig) {
        // Arrange: compose the UI with the authored plugin.
        using ui = yield* useUI(rig, { plugins: [tripPlugin] });

        // Act: send the user request through the chat UI.
        const bookTripButton = yield* ui.waitForEnabledButton("Book trip");
        bookTripButton.click();

        // Act: have the model invoke the authored booking tool.
        const modelRequest = yield* rig.model.request();
        yield* modelRequest.respond.toolCalls([
          { id: "booking", name: "book_trip", arguments: { destination: "Oslo" } },
        ]);

        // Act: decline or cancel the rendered flight choice.
        const choice = yield* ui.waitForEnabledButton(
          action === "decline" ? "Decline" : "Cancel choice",
        );
        choice.click();

        // Assert: the real tool returns the authored decline/cancel outcome.
        const toolResultRequest = yield* rig.model.request();
        expect(toolResultRequest.body.input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "function_call_output",
              call_id: "booking",
              output: JSON.stringify({ booked: false, reason: action }),
            }),
          ]),
        );

        // Act: finish the model response without continuing the booking.
        yield* toolResultRequest.respond.text("No booking made");

        // Assert: the UI settles with no nested travel-tip request.
        yield* ui.waitForText("No booking made");
        yield* ui.waitForElement("chat status is ready", () =>
          ui.queryByText("ready", { selector: "output" }),
        );
        expect(rig.model.requests()).toHaveLength(2);
      });
    });
  }
});
