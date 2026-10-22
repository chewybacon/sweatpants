import { describe, expect, it } from "vitest";
import { EventType } from "@ag-ui/core";
import { withTestScenario } from "@sweatpants/test-rig";
import { createApplication } from "../../../fixtures/application.ts";
import { durableSelection, selectionEffects } from "../../../fixtures/durable-selection.ts";
import { selectionPlugin } from "../../../fixtures/selection-plugin.tsx";
import { useUI } from "../../../support/ui.tsx";
import { observedExecution } from "./fixtures/observed-execution.ts";

describe("durable worker lifecycle", () => {
  for (const profile of ["accept", "decline", "cancel", "fenced"] as const) {
    it(`releases each parked worker and replays in a fresh attachment for ${profile}`, async () => {
      const { execution, stats } = observedExecution(profile === "fenced");
      const effects: string[] = [];
      await withTestScenario(
        {
          binding: "http",
          createApplication: (context) =>
            createApplication(context, {
              tools: [durableSelection],
              execution,
              effects: selectionEffects((topic) => effects.push(topic)),
            }),
        },
        function* (rig) {
          // Arrange: place the authored durable generator in real worker threads.
          using ui = yield* useUI(rig, { plugins: [selectionPlugin] });
          const send = yield* ui.waitForEnabledButton("Book trip");
          send.click();
          const outer = yield* rig.model.request();
          yield* outer.respond.toolCalls([
            { id: "worker-selection", name: "select_option", arguments: { topic: "worker" } },
          ]);
          const nested = yield* rig.model.request();
          yield* nested.respond.text("Worker note");
          const choice = yield* ui.waitForEnabledButton(
            profile === "decline"
              ? "Decline"
              : profile === "cancel"
                ? "Cancel choice"
                : "worker-beta",
          );

          // Assert: the sample and elicitation each relinquished their attachment.
          expect(stats).toEqual({ activeAttachments: 0, attachmentCount: 2, shutdownCount: 2 });
          const interrupt = rig.agui
            .events()
            .find(
              (event) =>
                event.type === EventType.RUN_FINISHED && event.outcome?.type === "interrupt",
            );
          if (
            interrupt?.type !== EventType.RUN_FINISHED ||
            interrupt.outcome?.type !== "interrupt"
          ) {
            throw new Error("Expected durable interrupt");
          }
          const identity = interrupt.outcome.interrupts[0];
          expect(identity.subagentRunId).toMatch(/^[a-f0-9]{64}$/);

          // Act: resume the persisted elicit through the plugin and another worker.
          choice.click();
          const final = yield* rig.model.request();
          expect(stats).toEqual({ activeAttachments: 0, attachmentCount: 3, shutdownCount: 3 });
          expect(effects).toEqual(["worker"]);
          expect(JSON.stringify(final.body.input)).toContain(
            profile === "decline" || profile === "cancel" ? "none" : "worker-beta",
          );
          expect(JSON.stringify(final.body.input)).toContain("worker-recorded");
          expect(JSON.stringify(final.body.input)).toContain("Worker note");
          yield* final.respond.text("Worker complete");
          yield* ui.waitForText("Worker complete");
          yield* ui.waitForEnabledButton("Book trip");
          const activity = rig.agui
            .events()
            .filter(
              (event) =>
                (event.type === EventType.ACTIVITY_SNAPSHOT ||
                  event.type === EventType.ACTIVITY_DELTA) &&
                event.messageId === `elicit:${identity.id}`,
            );
          expect(activity.length).toBeGreaterThanOrEqual(2);
          for (const event of activity) {
            expect(event).toMatchObject({ subagentRunId: identity.subagentRunId });
          }

          // Assert: outer follow-up history has one call/result and no private prompt.
          ui.getByRole("button", { name: "Book trip" }).click();
          const next = yield* rig.model.request();
          const input = next.body.input;
          if (!Array.isArray(input)) {
            throw new Error("Expected provider input");
          }
          expect(
            input.filter(
              (item: Record<string, unknown>) =>
                item["type"] === "function_call" && item["call_id"] === "worker-selection",
            ),
          ).toHaveLength(1);
          expect(
            input.filter(
              (item: Record<string, unknown>) =>
                item["type"] === "function_call_output" && item["call_id"] === "worker-selection",
            ),
          ).toHaveLength(1);
          expect(JSON.stringify(input)).not.toContain("PRIVATE_SELECTION_NOTE");
          const outerMessages = input.filter(
            (item: Record<string, unknown>) =>
              item["role"] === "user" || item["role"] === "assistant",
          );
          expect(JSON.stringify(outerMessages)).not.toContain("Worker note");
          yield* next.respond.text("Worker successor");
          yield* ui.waitForText("Worker successor");
          yield* ui.waitForEnabledButton("Book trip");
          expect(stats.activeAttachments).toBe(0);
        },
      );
    });
  }
});
