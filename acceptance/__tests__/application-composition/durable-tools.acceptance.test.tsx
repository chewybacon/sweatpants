import { describe, expect, it } from "vitest";
import { inProcess } from "@sweatpants/agent-host/server";
import { routeTools } from "@sweatpants/tool-session/execution";
import { withTestScenario } from "@sweatpants/test-rig";
import { createApplication } from "../../fixtures/application.ts";
import { durableSelection, selectionEffects } from "../../fixtures/durable-selection.ts";
import { selectionPlugin } from "../../fixtures/selection-plugin.tsx";
import { immediateTool } from "../../fixtures/immediate-tool.ts";
import { testToolRuntime } from "../../support/test-tool-runtime.ts";
import { useUI } from "../../support/ui.tsx";

const options = {
  binding: "http" as const,
  createApplication: (context: Parameters<typeof createApplication>[0]) =>
    createApplication(context, {
      tools: [durableSelection],
      effects: selectionEffects(),
      execution: inProcess(),
    }),
};

describe("durable tool authoring", () => {
  for (const outcome of ["accept", "decline", "cancel"] as const) {
    it(`replays a durable tool through sampling and a typed ${outcome} choice`, async () => {
      const effects: string[] = [];
      await withTestScenario(
        {
          ...options,
          createApplication: (context) =>
            createApplication(context, {
              tools: [durableSelection],
              effects: selectionEffects((topic) => effects.push(topic)),
              execution: inProcess(),
            }),
        },
        function* (rig) {
          // Arrange: the real durable program runs under the host crank.
          using ui = yield* useUI(rig, { plugins: [selectionPlugin] });
          const send = yield* ui.waitForEnabledButton("Book trip");

          // Act: execute the recorded effect and private nested sample before parking.
          send.click();
          const outer = yield* rig.model.request();
          yield* outer.respond.toolCalls([
            { id: "selection", name: "select_option", arguments: { topic: "trains" } },
          ]);
          const nested = yield* rig.model.request();
          expect(nested.pullId).not.toBe(outer.pullId);
          expect(JSON.stringify(nested.body.input)).toContain("PRIVATE_SELECTION_NOTE");
          yield* nested.respond.text("Take the express");
          const choice = yield* ui.waitForEnabledButton(
            outcome === "accept"
              ? "trains-beta"
              : outcome === "decline"
                ? "Decline"
                : "Cancel choice",
          );
          choice.click();
          const final = yield* rig.model.request();

          // Assert: replay retains the sample/record and never re-executes the effect.
          expect(effects).toEqual(["trains"]);
          expect(JSON.stringify(final.body.input)).toContain(
            outcome === "accept" ? "trains-beta" : "none",
          );
          expect(JSON.stringify(final.body.input)).toContain("trains-recorded");
          expect(JSON.stringify(final.body.input)).toContain("Take the express");
          expect(JSON.stringify(final.body.input)).not.toContain("PRIVATE_SELECTION_NOTE");
          yield* final.respond.text("Selection complete");
          yield* ui.waitForText("Selection complete");
          yield* ui.waitForEnabledButton("Book trip");

          // Act: send a successor and inspect its unnormalized provider history.
          ui.getByRole("button", { name: "Book trip" }).click();
          const next = yield* rig.model.request();
          const input = next.body.input;
          if (!Array.isArray(input)) {
            throw new Error("Expected provider history");
          }
          expect(
            input.filter(
              (item: Record<string, unknown>) =>
                item["type"] === "function_call_output" && item["call_id"] === "selection",
            ),
          ).toHaveLength(1);
          expect(JSON.stringify(input)).not.toContain("PRIVATE_SELECTION_NOTE");
          yield* next.respond.text("Successor complete");
          yield* ui.waitForText("Successor complete");
          yield* ui.waitForEnabledButton("Book trip");
          expect(effects).toEqual(["trains"]);
        },
      );
    });
  }

  it("routes ordinary and durable calls from the same model response", async () => {
    await withTestScenario(
      {
        ...options,
        createApplication: (context) =>
          createApplication(context, {
            tools: [immediateTool, durableSelection],
            effects: selectionEffects(),
            execution: routeTools({
              routes: [
                { tools: [immediateTool], runtime: testToolRuntime() },
                { tools: [durableSelection], runtime: inProcess() },
              ],
            }),
          }),
      },
      function* (rig) {
        // Arrange: placement is selected on the public application configuration.
        using ui = yield* useUI(rig, { plugins: [selectionPlugin] });

        // Act: the model selects one ordinary and one durable tool.
        const send = yield* ui.waitForEnabledButton("Book trip");
        send.click();
        const request = yield* rig.model.request();
        yield* request.respond.toolCalls([
          { id: "ordinary", name: "immediate", arguments: { value: "ordinary" } },
          { id: "durable", name: "select_option", arguments: { topic: "mixed" } },
        ]);
        const nested = yield* rig.model.request();
        yield* nested.respond.text("Mixed note");
        const choice = yield* ui.waitForEnabledButton("mixed-alpha");
        choice.click();
        const final = yield* rig.model.request();
        const input = final.body.input;
        if (!Array.isArray(input)) {
          throw new Error("Expected provider history");
        }

        // Assert: both placements contribute exactly one correlated result before the final sample.
        expect(
          input
            .filter((item: Record<string, unknown>) => item["type"] === "function_call_output")
            .map((item: Record<string, unknown>) => item["call_id"]),
        ).toEqual(["ordinary", "durable"]);
        expect(JSON.stringify(input)).toContain("mixed-alpha");
        yield* final.respond.text("Both complete");
        yield* ui.waitForText("Both complete");
        yield* ui.waitForEnabledButton("Book trip");
        expect(rig.model.requests()).toHaveLength(3);
      },
    );
  });
});
