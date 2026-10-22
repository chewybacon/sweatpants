import { describe, expect, it } from "vitest";
import { call, spawn } from "effection";
import { EventType } from "@ag-ui/core";
import { withTestScenario } from "@sweatpants/test-rig";
import { createApplication } from "../../fixtures/application.ts";
import { immediateTool, invocations } from "../../fixtures/immediate-tool.ts";
import { testToolRuntime } from "../../support/test-tool-runtime.ts";
import { useClient, waitForSnapshot } from "../../support/client.ts";

const options = {
  binding: "http" as const,
  createApplication: (context: Parameters<typeof createApplication>[0]) =>
    createApplication(context, { tools: [immediateTool], execution: testToolRuntime() }),
};

describe("public tool validation and failure recovery", () => {
  for (const failure of [
    "throw",
    "invalid_output",
    "invalid_arguments",
    "unknown",
    "malformed",
  ] as const) {
    it(`preserves the call/error history and recovers after ${failure}`, async () => {
      await withTestScenario(options, function* (rig) {
        // Arrange: run actual tool bodies and count entries before validation.
        const client = yield* useClient(rig, { threadId: `validation-${failure}` });
        const before = invocations.length;
        const mark = rig.agui.mark();

        // Act: submit the invalid or failing call through the model protocol.
        const sending = yield* spawn(() => call(() => client.sendMessage(`failure ${failure}`)));
        const request = yield* rig.model.request();
        if (failure === "malformed") {
          yield* request.respond.malformedToolCall({
            id: "failed-call",
            name: "immediate",
            arguments: "{not-json",
          });
        } else {
          yield* request.respond.toolCalls([
            {
              id: "failed-call",
              name: failure === "unknown" ? "not_in_catalog" : "immediate",
              arguments:
                failure === "invalid_arguments"
                  ? {}
                  : { value: failure, behavior: failure === "unknown" ? "complete" : failure },
            },
          ]);
        }
        if (failure === "throw" || failure === "invalid_output") {
          const result = yield* rig.model.request();
          expect(JSON.stringify(result.body.input)).toContain("failed-call");
          expect(JSON.stringify(result.body.input)).toMatch(/error|fail|invalid/i);
          yield* result.respond.text("Tool failed; try again");
          yield* waitForSnapshot(client, (state) => state.status === "ready");
        } else {
          yield* waitForSnapshot(client, (state) => state.status === "error");
          expect(
            rig.agui.events(mark).filter((event) => event.type === EventType.RUN_ERROR),
          ).toHaveLength(1);
        }
        yield* sending;

        // Assert: rejected arguments never enter the authored tool body.
        expect(invocations.length - before).toBe(
          failure === "throw" || failure === "invalid_output" ? 1 : 0,
        );

        // Act: send again with the same public client.
        const recovery = yield* spawn(() =>
          call(() => client.sendMessage("Recover after failure")),
        );
        const next = yield* rig.model.request();

        // Assert: recovery keeps the original call and its error on the wire.
        expect(JSON.stringify(next.body.input)).toContain("Recover after failure");
        expect(JSON.stringify(next.body.input)).toContain("failed-call");
        expect(JSON.stringify(next.body.input)).toMatch(/error|fail|invalid|unknown/i);
        yield* next.respond.text("Recovered");
        yield* recovery;
        const ready = yield* waitForSnapshot(client, (state) => state.status === "ready");
        expect(ready.error).toBeNull();
        expect(JSON.stringify(ready.messages)).toContain("Recovered");
      });
    });
  }
});
