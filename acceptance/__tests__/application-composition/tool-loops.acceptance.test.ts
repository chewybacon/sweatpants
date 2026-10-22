import { describe, expect, it } from "vitest";
import { call, spawn } from "effection";
import { withTestScenario } from "@sweatpants/test-rig";
import { createApplication } from "../../fixtures/application.ts";
import { immediateTool } from "../../fixtures/immediate-tool.ts";
import { testToolRuntime } from "../../support/test-tool-runtime.ts";
import { useClient, waitForSnapshot } from "../../support/client.ts";

const options = {
  binding: "http" as const,
  createApplication: (context: Parameters<typeof createApplication>[0]) =>
    createApplication(context, { tools: [immediateTool], execution: testToolRuntime() }),
};

describe("public tool loops", () => {
  for (const mode of ["two-calls", "split-arguments", "preface", "mixed-results"] as const) {
    it(`preserves correlated call/results for ${mode}`, async () => {
      await withTestScenario(options, function* (rig) {
        // Arrange: compose an ordinary tool through the public application API.
        const client = yield* useClient(rig, { threadId: mode });

        // Act: release the model response, including a real parser boundary.
        const sending = yield* spawn(() => call(() => client.sendMessage(`Run ${mode}`)));
        const request = yield* rig.model.request();
        const calls = [
          { id: "first", name: "immediate", arguments: { value: "alpha", behavior: "complete" } },
        ];
        if (mode === "two-calls" || mode === "mixed-results") {
          calls.push({
            id: "second",
            name: "immediate",
            arguments: { value: "beta", behavior: mode === "mixed-results" ? "throw" : "complete" },
          });
        }
        if (mode === "preface") {
          yield* request.respond.textAndToolCalls("Let me check", calls);
        } else {
          yield* request.respond.toolCalls(
            calls,
            mode === "split-arguments" ? { argumentChunkSize: 2 } : undefined,
          );
        }
        const result = yield* rig.model.request();
        const input = result.body.input;
        if (!Array.isArray(input)) {
          throw new Error("Expected wire input messages");
        }
        const outputs = input.filter(
          (item: Record<string, unknown>) => item["type"] === "function_call_output",
        );

        // Assert: every result retains its call identity and causal order.
        expect(outputs.map((item: Record<string, unknown>) => item["call_id"])).toEqual(
          calls.map((item) => item.id),
        );
        expect(JSON.stringify(outputs)).toContain("alpha");
        if (mode === "two-calls") {
          expect(JSON.stringify(outputs)).toContain("beta");
        }
        if (mode === "mixed-results") {
          expect(JSON.stringify(outputs)).toMatch(/error|fail/i);
        }
        if (mode === "preface") {
          expect(JSON.stringify(input)).toContain("Let me check");
        }
        yield* result.respond.text("Complete");
        yield* sending;
        const ready = yield* waitForSnapshot(client, (state) => state.status === "ready");
        expect(JSON.stringify(ready.messages)).toContain("Complete");
        if (mode === "preface") {
          expect(JSON.stringify(ready.messages)).toContain("Let me check");
        }

        // Act: verify that a successor retains all call/result history.
        const followUp = yield* spawn(() => call(() => client.sendMessage("Continue")));
        const next = yield* rig.model.request();
        expect(JSON.stringify(next.body.input)).toContain("first");
        if (calls.length === 2) {
          expect(JSON.stringify(next.body.input)).toContain("second");
        }
        if (mode === "mixed-results") {
          expect(JSON.stringify(next.body.input)).toMatch(/error|fail/i);
        }
        yield* next.respond.text("Continued");
        yield* followUp;
        yield* waitForSnapshot(client, (state) => state.status === "ready");
      });
    });
  }

  it("executes sequential iterations with exact-once history", async () => {
    await withTestScenario(options, function* (rig) {
      // Arrange.
      const client = yield* useClient(rig, { threadId: "sequential" });
      const sending = yield* spawn(() => call(() => client.sendMessage("Two steps")));

      // Act: each model request observes all previously accepted results.
      for (const id of ["one", "two"]) {
        const request = yield* rig.model.request();
        if (id === "two") {
          expect(JSON.stringify(request.body.input)).toContain('"call_id":"one"');
        }
        yield* request.respond.toolCalls([{ id, name: "immediate", arguments: { value: id } }]);
      }
      const final = yield* rig.model.request();
      const input = final.body.input;
      if (!Array.isArray(input)) {
        throw new Error("Expected wire input messages");
      }

      // Assert: one output for each iteration, and no fourth provider request.
      expect(
        input
          .filter((item: Record<string, unknown>) => item["type"] === "function_call_output")
          .map((item: Record<string, unknown>) => item["call_id"]),
      ).toEqual(["one", "two"]);
      yield* final.respond.text("Done");
      yield* sending;
      yield* waitForSnapshot(client, (state) => state.status === "ready");
      expect(rig.model.requests()).toHaveLength(3);
    });
  });

  it("stops at the configured iteration limit without an extra provider request", async () => {
    await withTestScenario(
      {
        ...options,
        createApplication: (context) =>
          createApplication(context, {
            tools: [immediateTool],
            execution: testToolRuntime(),
            maxToolIterations: 2,
          }),
      },
      function* (rig) {
        // Arrange.
        const client = yield* useClient(rig, { threadId: "limit" });
        const sending = yield* spawn(() => call(() => client.sendMessage("Keep calling")));

        // Act: exhaust exactly two permitted model/tool iterations.
        for (const id of ["one", "two"]) {
          const request = yield* rig.model.request();
          yield* request.respond.toolCalls([{ id, name: "immediate", arguments: { value: id } }]);
        }

        // Assert.
        const failed = yield* waitForSnapshot(client, (state) => state.status === "error");
        yield* sending;
        expect(JSON.stringify(failed.error)).toMatch(/maximum|max_tool_iterations/i);
        expect(rig.model.requests()).toHaveLength(2);
      },
    );
  });
});
