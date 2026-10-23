import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import { call, spawn } from "effection";
import { createChatApp } from "@sweatpants/agent-host/server";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import { setupInMemoryDurableStreams } from "@sweatpants/durable-chat-runtime/response-streams";
import { withTestScenario, type TestApplicationFactoryContext } from "@sweatpants/test-rig";
import { bookTrip } from "../../fixtures/book-trip.ts";
import { confirmedTrip } from "../../fixtures/confirmed-trip.ts";
import { tripPlugin, confirmedTripPlugin } from "../../fixtures/trip-chat.tsx";
import { useUI } from "../../support/ui.tsx";
import { createControlledScheduler } from "../../support/controlled-scheduler.ts";
import { testToolRuntime } from "../../support/test-tool-runtime.ts";

function createApplication(context: TestApplicationFactoryContext) {
  const application = createChatApp({
    name: "react-plugin-example",
    secret: "react-plugin-example-secret-at-least-32-bytes",
    storage: { kind: "memory" },
    tools: [bookTrip, confirmedTrip],
    basePath: "/assistant/chat",
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
  return {
    handle: application.handler,
    close: () => application.close(),
    inspect: () => application.inspect(),
  };
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
      const flightRender = flight.closest("[data-render-id]");
      const flightRenderId = flightRender?.getAttribute("data-render-id");
      expect(flightRenderId).toBeTruthy();
      flight.click();

      // Act: choose a seat in the next rendered interaction.
      const seat = yield* ui.waitForEnabledButton("2B");

      // Assert: completing one render keeps its identity while the next choice is pending.
      expect(flightRender?.getAttribute("data-render-id")).toBe(flightRenderId);
      expect(flightRender?.getAttribute("data-render-state")).toBe("completed");
      expect(flight.disabled).toBe(true);
      expect(JSON.stringify(ui.client.getSnapshot().messages)).toContain('"state":"pending"');

      // Act: complete the seat choice.
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

      // Assert: the tool is complete, but sending stays disabled until the model finishes.
      expect(ui.getByRole<HTMLButtonElement>("button", { name: "Book trip" }).disabled).toBe(true);
      expect(["submitted", "streaming"]).toContain(ui.client.getSnapshot().status);

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
      expect(ui.client.getSnapshot().authority?.state).toBe("idle");
      expect(JSON.stringify(ui.client.getSnapshot().messages)).not.toContain('"state":"pending"');
      expect(JSON.stringify(ui.client.getSnapshot().messages)).toContain('"state":"completed"');

      // Act: submit a successor after the elicited tool turn has completed.
      const sendAgain = yield* ui.waitForEnabledButton("Book trip");
      sendAgain.click();
      const successor = yield* rig.model.request();
      // The outer history retains one causal call/result pair and the original arguments.
      expect(successor.body.input).toEqual([
        expect.objectContaining({
          role: "user",
          content: [expect.objectContaining({ text: "Book Oslo" })],
        }),
        expect.objectContaining({
          type: "function_call",
          call_id: "booking",
          name: "book_trip",
          arguments: JSON.stringify({ destination: "Oslo" }),
        }),
        expect.objectContaining({ type: "function_call_output", call_id: "booking" }),
        expect.objectContaining({
          role: "assistant",
          content: [expect.objectContaining({ text: "Your trip is booked" })],
        }),
        expect.objectContaining({
          role: "user",
          content: [expect.objectContaining({ text: "Book Oslo" })],
        }),
      ]);
      const outerText = (successor.body.input as Array<{ role?: string }>).filter(
        (item) => item.role === "user" || item.role === "assistant",
      );
      expect(JSON.stringify(outerText)).not.toContain("PRIVATE_TRAVEL_TIP");
      expect(JSON.stringify(outerText)).not.toContain("Take the train");
      yield* successor.respond.text("Next booking started");

      // Assert: the same client accepts and completes the successor.
      yield* ui.waitForText("Next booking started");
      yield* ui.waitForEnabledButton("Book trip");
      expect(ui.client.getSnapshot().authority?.state).toBe("idle");
    });
  });

  it("projects streamed text through the hook and preserves it on the next turn", async () => {
    let application: ReturnType<typeof createApplication>;
    await withTestScenario(
      {
        ...rigOptions,
        createApplication(context) {
          application = createApplication(context);
          return application;
        },
      },
      function* (rig) {
        // Arrange: compose the UI with the authored plugin.
        using ui = yield* useUI(rig, { threadId: "streaming", plugins: [tripPlugin] });
        const firstMark = rig.agui.mark();

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

        // Assert: streamed identity and one durable text emission survive the next snapshot.
        const firstAssistant = ui.client
          .getSnapshot()
          .messages.find(
            (message) =>
              message.role === "assistant" && JSON.stringify(message).includes("Hello Oslo"),
          );
        expect(firstAssistant?.id).toBeTruthy();
        const firstEvents = rig.agui.events(firstMark);
        expect(firstEvents[0]?.type).toBe(EventType.RUN_STARTED);
        expect(firstEvents.map((event) => event.type)).not.toContain(EventType.MESSAGES_SNAPSHOT);
        expect(firstEvents.map((event) => event.type)).not.toContain(EventType.STATE_SNAPSHOT);
        expect(
          firstEvents
            .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
            .map((event) => event.delta),
        ).toEqual(["Hello", " Oslo"]);
        const storage = yield* call(() => application.inspect());
        const journal = yield* storage.programDriverJournalStore.withJournal(
          "streaming",
          (opened) => opened.readJournal("streaming"),
        );
        expect(JSON.stringify(journal)).not.toContain('"eventType":"model_token"');
        expect(
          journal.filter(
            (record) =>
              record.payload.type === "DurableEmission" &&
              record.payload.descriptor.eventType === "assistant_text",
          ),
        ).toHaveLength(1);

        // Act: send another request through the same client.
        const secondMark = rig.agui.mark();
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
        const retained = ui.client
          .getSnapshot()
          .messages.filter(
            (message) =>
              message.role === "assistant" && JSON.stringify(message).includes("Hello Oslo"),
          );
        expect(retained).toHaveLength(1);
        expect(retained[0].id).toBe(firstAssistant?.id);
        const secondTypes = rig.agui.events(secondMark).map((event) => event.type);
        expect(secondTypes[0]).toBe(EventType.RUN_STARTED);
        expect(secondTypes).not.toContain(EventType.MESSAGES_SNAPSHOT);
        expect(secondTypes).not.toContain(EventType.STATE_SNAPSHOT);
      },
    );
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

  it("cancels a parked choice before submitting an interrupting successor", async () => {
    await withTestScenario(rigOptions, function* (rig) {
      // Arrange: author an interrupt queue policy on the public client.
      using ui = yield* useUI(rig, { plugins: [tripPlugin], queue: "interrupt" });

      // Act: park the tool at its first rendered choice.
      const send = yield* ui.waitForEnabledButton("Book trip");
      send.click();
      const request = yield* rig.model.request();
      yield* request.respond.toolCalls([
        { id: "parked-booking", name: "book_trip", arguments: { destination: "Oslo" } },
      ]);
      const flight = yield* ui.waitForEnabledButton("FL-1");
      const cancellationStart = rig.agui.mark();

      // Act: submit a replacement through the hook while the choice is pending.
      ui.getByRole("button", { name: "Replace booking" }).click();

      // Assert: authoritative cancellation precedes submission of the replacement.
      const cancelled = yield* rig.agui.event("RUN_ERROR", { after: cancellationStart });
      expect(cancelled).toMatchObject({ code: "PROGRAM_CANCELLED" });
      expect(JSON.stringify(rig.agui.events(cancellationStart))).not.toContain("Replace booking");
      const replacement = yield* rig.model.request();
      expect(JSON.stringify(replacement.body.input)).toContain("Replace booking");

      // Act: complete the replacement.
      yield* replacement.respond.text("Replacement booking started");

      // Assert: no old choice remains actionable and no nested sample was started.
      yield* ui.waitForText("Replacement booking started");
      yield* ui.waitForEnabledButton("Book trip");
      expect(flight.isConnected && !flight.disabled).toBe(false);
      expect(rig.model.requests()).toHaveLength(2);
      expect(ui.client.getSnapshot().authority?.state).toBe("idle");
    });
  });

  it("restores a pending choice in a fresh client and completes a successor", async () => {
    await withTestScenario(rigOptions, function* (rig) {
      // Arrange: use an explicit conversation identity across separate clients.
      const options = { plugins: [tripPlugin], threadId: "restored-booking" };
      const aguiStart = rig.agui.mark();
      using first = yield* useUI(rig, options);

      // Act: park the tool at the flight choice.
      const send = yield* first.waitForEnabledButton("Book trip");
      send.click();
      const request = yield* rig.model.request();
      yield* request.respond.toolCalls([
        { id: "restored-call", name: "book_trip", arguments: { destination: "Oslo" } },
      ]);
      const oldFlight = yield* first.waitForEnabledButton("FL-1");
      const renderId = oldFlight.closest("[data-render-id]")?.getAttribute("data-render-id");
      expect(renderId).toBeTruthy();

      // Act: unmount the view, close its client, and reconnect a new client.
      first[Symbol.dispose]();
      yield* call(() => first.client.close());
      using resumed = yield* useUI(rig, options);
      yield* call(() => resumed.client.reconnect());
      const flight = yield* resumed.waitForEnabledButton("FL-2");

      // Assert: the pending render retains its identity; the old DOM is detached.
      expect(resumed.client).not.toBe(first.client);
      expect(oldFlight.isConnected).toBe(false);
      expect(flight.closest("[data-render-id]")?.getAttribute("data-render-id")).toBe(renderId);

      // Act: finish the restored choice and the next interaction.
      flight.click();
      const seat = yield* resumed.waitForEnabledButton("2B");
      seat.click();
      const nested = yield* rig.model.request();
      yield* nested.respond.text("Restored travel tip");
      const final = yield* rig.model.request();

      // Assert: the restored responses reach the tool and the final model request.
      expect(JSON.stringify(final.body.input)).toContain("FL-2");
      expect(JSON.stringify(final.body.input)).toContain("Restored travel tip");
      expect(resumed.getByRole<HTMLButtonElement>("button", { name: "Book trip" }).disabled).toBe(
        true,
      );

      // Act: complete the restored turn and send a successor.
      const finalRun = rig.agui.mark();
      yield* final.respond.text("Restored booking complete");
      yield* resumed.waitForText("Restored booking complete");
      const sendAgain = yield* resumed.waitForEnabledButton("Book trip");
      expect(JSON.stringify(resumed.client.getSnapshot().messages)).not.toContain(
        '"state":"pending"',
      );
      yield* rig.agui.event("RUN_FINISHED", { after: finalRun });
      rig.agui.assertConformant({ after: aguiStart });
      sendAgain.click();
      const next = yield* rig.model.request();
      expect(JSON.stringify(next.body.input)).toContain("Book Oslo");
      yield* next.respond.text("Post-restore booking started");

      // Assert: the fresh client remains usable after recovery.
      yield* resumed.waitForText("Post-restore booking started");
      yield* resumed.waitForEnabledButton("Book trip");
      expect(resumed.client.getSnapshot().error).toBeNull();
      expect(resumed.client.getSnapshot().authority?.state).toBe("idle");
      expect(rig.model.requests()).toHaveLength(4);
    });
  });

  it("authors two local renders for one elicitation and validates the final response", async () => {
    await withTestScenario(rigOptions, function* (rig) {
      // Arrange: author a plugin with two UI steps and a Markdown pipeline.
      const aguiStart = rig.agui.mark();
      using ui = yield* useUI(rig, { plugins: [confirmedTripPlugin], pipeline: "markdown" });

      // Act: ask the model to invoke the tool with a single typed elicitation.
      const send = yield* ui.waitForEnabledButton("Book trip");
      send.click();
      const request = yield* rig.model.request();
      expect(JSON.stringify(request.body.tools)).toContain("confirm_trip");
      yield* request.respond.toolCalls([
        { id: "confirmation", name: "confirm_trip", arguments: { route: "NYC-LAX" } },
      ]);

      // Assert: the first render receives the tool's context and message.
      const flight = yield* ui.waitForEnabledButton("FL-1");
      expect(ui.getByRole("region", { name: "Choose a flight for NYC-LAX" })).toBeTruthy();
      expect(ui.getByRole("button", { name: "FL-2" })).toBeTruthy();
      const flightRender = flight.closest("[data-render-id]");
      const flightId = flightRender?.getAttribute("data-render-id");
      const elicitId = flightRender?.getAttribute("data-elicit-id");
      expect(flightId).toBeTruthy();
      expect(elicitId).toBeTruthy();

      // Act: complete the first local step without answering the server elicitation.
      flight.click();
      const confirm = yield* ui.waitForEnabledButton("Confirm");
      const confirmationRender = confirm.closest("[data-render-id]");
      const confirmationId = confirmationRender?.getAttribute("data-render-id");

      // Assert: the first render completes in place while the same elicitation stays pending.
      expect(flightRender?.getAttribute("data-render-id")).toBe(flightId);
      expect(flightRender?.getAttribute("data-render-state")).toBe("completed");
      expect(confirmationId).toBeTruthy();
      expect(confirmationId).not.toBe(flightId);
      expect(confirmationRender?.getAttribute("data-elicit-id")).toBe(elicitId);
      expect(ui.getByRole("region", { name: "Confirm FL-1" })).toBeTruthy();
      expect(JSON.stringify(ui.client.getSnapshot().messages)).toContain('"state":"pending"');
      expect(rig.model.requests()).toHaveLength(1);
      expect(() => JSON.stringify(ui.client.getServerSnapshot())).not.toThrow();
      expect(JSON.stringify(ui.client.getServerSnapshot())).not.toContain('"type":"render"');

      // Act: submit the plugin's final response through the second render.
      confirm.click();
      const final = yield* rig.model.request();

      // Assert: response-schema transformation runs before the tool result reaches the model.
      const input = final.body.input;
      if (!Array.isArray(input)) {
        throw new Error("Expected provider wire input messages");
      }
      const result = input.find(
        (message: Record<string, unknown>) =>
          message["type"] === "function_call_output" && message["call_id"] === "confirmation",
      );
      expect(result).toMatchObject({ call_id: "confirmation", output: expect.any(String) });
      expect(JSON.parse(String(result?.["output"]))).toEqual({
        confirmed: true,
        marker: "CONFIRMED_TRIP",
        normalized: true,
        route: "NYC-LAX",
        selected: "FL-1",
      });
      expect(confirmationRender?.getAttribute("data-render-id")).toBe(confirmationId);
      expect(confirmationRender?.getAttribute("data-render-state")).toBe("completed");
      expect(ui.getByRole<HTMLButtonElement>("button", { name: "Book trip" }).disabled).toBe(true);
      expect(["submitted", "streaming"]).toContain(ui.client.getSnapshot().status);
      const finalRun = rig.agui.mark();

      // Act: finish the outer response using Markdown.
      yield* final.respond.text("**Confirmed booking**");
      const answer = yield* ui.waitForText("Confirmed booking");
      yield* ui.waitForEnabledButton("Book trip");

      // Assert: the public hook renders Markdown and settles all local steps.
      expect(answer.tagName).toBe("STRONG");
      expect(ui.client.getSnapshot().error).toBeNull();
      expect(ui.client.getSnapshot().status).toBe("ready");
      expect(JSON.stringify(ui.client.getSnapshot().messages)).not.toContain('"state":"pending"');
      expect(JSON.stringify(ui.client.getSnapshot().messages)).toContain('"state":"completed"');
      yield* rig.agui.event("RUN_FINISHED", { after: finalRun });
      rig.agui.assertConformant({ after: aguiStart });
      const snapshots = rig.agui
        .events(aguiStart)
        .filter((event) => event.type === EventType.MESSAGES_SNAPSHOT);
      expect(
        snapshots.every((event) => event.messages.every((message) => message.role !== "system")),
      ).toBe(true);
      expect(rig.model.requests()).toHaveLength(2);
    });
  });

  it("buffers protocol deltas until the authored scheduler releases one client pull", async () => {
    await withTestScenario(rigOptions, function* (rig) {
      // Arrange: install a controllable scheduler through public client configuration.
      const scheduler = createControlledScheduler();
      using ui = yield* useUI(rig, {
        plugins: [],
        scheduler: scheduler.driver,
        pipeline: "markdown",
      });

      // Act: start a stream and release three provider deltas without a client tick.
      const send = yield* ui.waitForEnabledButton("Book trip");
      send.click();
      const request = yield* rig.model.request();
      const stream = yield* request.respond.textStream(["BUFFERED_", "TOKEN_", "BATCH"]);
      for (const delta of ["BUFFERED_", "TOKEN_", "BATCH"]) {
        const after = rig.agui.mark();
        yield* stream.releaseNext();
        const event = yield* rig.agui.event("TEXT_MESSAGE_CONTENT", { after });
        expect(event).toMatchObject({ delta });
      }

      // Assert: the protocol delivered every delta, but the client has not projected them.
      yield* scheduler.reached(1);
      expect(scheduler.pullCount).toBe(1);
      expect(scheduler.releasedTickCount).toBe(0);
      expect(ui.queryByText("BUFFERED_TOKEN_BATCH")).toBeNull();
      expect(JSON.stringify(ui.client.getSnapshot().messages)).not.toContain(
        "BUFFERED_TOKEN_BATCH",
      );

      // Act: permit exactly one client pull.
      yield* scheduler.release();

      // Assert: one tick projects all three deltas together.
      yield* ui.waitForText("BUFFERED_TOKEN_BATCH");
      expect(scheduler.releasedTickCount).toBe(1);

      // Act: finish the stream and release the terminal client tick.
      const terminal = rig.agui.mark();
      yield* stream.finish();
      yield* rig.agui.event("RUN_FINISHED", { after: terminal });
      yield* scheduler.reached(2);
      yield* scheduler.release();

      // Assert: the hook reaches ready with the complete text still visible.
      yield* ui.waitForEnabledButton("Book trip");
      expect(ui.client.getSnapshot().status).toBe("ready");
      expect(ui.getByText("BUFFERED_TOKEN_BATCH")).toBeTruthy();
      expect(rig.model.requests()).toHaveLength(1);
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
