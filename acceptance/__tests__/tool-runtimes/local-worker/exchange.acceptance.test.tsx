import { call } from "effection";
import { expect, it } from "vitest";
import { resolve } from "node:path";
import { createChatApp } from "@sweatpants/agent-host/server";
import { local } from "@sweatpants/tool-runtime-local";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import { setupInMemoryDurableStreams } from "@sweatpants/durable-chat-runtime/response-streams";
import { withTestScenario, type TestApplicationFactoryContext } from "@sweatpants/test-rig";
import { bookTrip } from "../../../fixtures/book-trip.ts";
import { tripPlugin } from "../../../fixtures/trip-chat.tsx";
import { executionLocation } from "../../../fixtures/execution-location.ts";
import { useUI } from "../../../support/ui.tsx";

function createApplication(context: TestApplicationFactoryContext) {
  const app = createChatApp({
    name: "worker-placement",
    secret: "worker-placement-test-secret-at-least-32-bytes",
    storage: { kind: "memory" },
    tools: [executionLocation, bookTrip],
    execution: local({
      worker: resolve("__tests__/tool-runtimes/local-worker/fixtures/tool-worker.mjs"),
    }),
    basePath: "/assistant/chat",
    model: {
      model: context.model.model,
      driver: createPiAiModelProvider().driver,
      streamOptions: context.model.streamOptions,
    },
    setup: {
      application: function* () {
        yield* setupInMemoryDurableStreams<string>();
      },
    },
  });
  return { handle: app.handler, close: () => app.close() };
}

it("exchanges typed elicitations, nested sampling and results with a real worker", async () => {
  await withTestScenario({ binding: "http", createApplication }, function* (rig) {
    // Arrange: author the same UI plugin against worker placement.
    using ui = yield* useUI(rig, { plugins: [tripPlugin] });

    // Act: invoke a placement probe and the interactive booking tool.
    const send = yield* ui.waitForEnabledButton("Book trip");
    send.click();
    const request = yield* rig.model.request();
    yield* request.respond.toolCalls([
      { id: "location", name: "execution_location", arguments: {} },
      { id: "booking", name: "book_trip", arguments: { destination: "Oslo" } },
    ]);

    // Act: send both typed plugin responses back across the worker boundary.
    const flight = yield* ui.waitForEnabledButton("FL-2");
    flight.click();

    const seat = yield* ui.waitForEnabledButton("2B");
    seat.click();

    // Assert: the worker's nested sample reaches the actual provider parser.
    const nested = yield* rig.model.request();
    expect(JSON.stringify(nested.body.input)).toContain("PRIVATE_TRAVEL_TIP for Oslo");

    // Act: send the nested sample response back to the worker.
    yield* nested.respond.text("Take the train");

    // Assert: execution happened off-thread and all exchanges produced the result.
    const result = yield* rig.model.request();
    expect(result.body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call_output",
          call_id: "location",
          output: JSON.stringify({ onMainThread: false }),
        }),
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

    // Act: finish the model response.
    yield* result.respond.text("Booked through the worker");

    // Assert: the client completes without leaking a worker failure.
    yield* ui.waitForText("Booked through the worker");
    yield* ui.waitForElement("ready status", () => ui.queryByText("ready", { selector: "output" }));
    expect(ui.client.getSnapshot().error).toBeNull();
    expect(rig.model.requests()).toHaveLength(3);

    // Act: submit a successor after the worker invocation has completed.
    const sendAgain = yield* ui.waitForEnabledButton("Book trip");
    expect(ui.client.getSnapshot().authority?.state).toBe("idle");
    sendAgain.click();
    const next = yield* rig.model.request();
    yield* next.respond.text("Worker successor completed");

    // Assert: worker completion leaves the conversation usable.
    yield* ui.waitForText("Worker successor completed");
    yield* ui.waitForEnabledButton("Book trip");
    expect(ui.client.getSnapshot().authority?.state).toBe("idle");
  });
});

// These cases retain the worker cancellation and reconnect guarantees while
// general authoring behavior uses the in-process runtime.
it("cancels a parked worker invocation before submitting its successor", async () => {
  await withTestScenario({ binding: "http", createApplication }, function* (rig) {
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

it("restores a worker elicitation in a fresh client and completes a successor", async () => {
  await withTestScenario({ binding: "http", createApplication }, function* (rig) {
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
