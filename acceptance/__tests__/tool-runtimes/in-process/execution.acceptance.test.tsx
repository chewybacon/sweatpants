import { expect, it } from "vitest";
import { createChatApp } from "@sweatpants/agent-host/server";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import { setupInMemoryDurableStreams } from "@sweatpants/durable-chat-runtime/response-streams";
import { withTestScenario, type TestApplicationFactoryContext } from "@sweatpants/test-rig";
import { executionLocation } from "../../../fixtures/execution-location.ts";
import { testToolRuntime } from "../../../support/test-tool-runtime.ts";
import { useUI } from "../../../support/ui.tsx";

function createApplication(context: TestApplicationFactoryContext) {
  const app = createChatApp({
    name: "in-process-placement",
    secret: "in-process-placement-test-secret-at-least-32-bytes",
    storage: { kind: "memory" },
    tools: [executionLocation],
    execution: testToolRuntime(),
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

it("executes the actual authored tool body on the host thread", async () => {
  await withTestScenario({ binding: "http", createApplication }, function* (rig) {
    // Arrange: use the real public client without interaction plugins.
    using ui = yield* useUI(rig, { plugins: [] });

    // Act: request a tool invocation through the real HTTP application.
    const send = yield* ui.waitForEnabledButton("Book trip");
    send.click();
    const request = yield* rig.model.request();
    yield* request.respond.toolCalls([
      { id: "location", name: "execution_location", arguments: {} },
    ]);

    // Assert: the tool body observed the host thread, not a worker.
    const result = yield* rig.model.request();
    expect(result.body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call_output",
          call_id: "location",
          output: JSON.stringify({ onMainThread: true }),
        }),
      ]),
    );

    // Act: finish the response.
    yield* result.respond.text("Executed in-process");

    // Assert: the client receives a successful completion.
    yield* ui.waitForText("Executed in-process");
    yield* ui.waitForElement("ready status", () => ui.queryByText("ready", { selector: "output" }));
    expect(ui.client.getSnapshot().error).toBeNull();
    expect(rig.model.requests()).toHaveLength(2);
  });
});
