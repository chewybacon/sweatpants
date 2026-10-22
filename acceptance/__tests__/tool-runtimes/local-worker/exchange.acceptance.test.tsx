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
    basePath: "/assistant",
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
  });
});
