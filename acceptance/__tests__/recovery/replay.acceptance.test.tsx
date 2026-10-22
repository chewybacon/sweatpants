import { describe, expect, it } from "vitest";
import { call } from "effection";
import { EventType } from "@ag-ui/core";
import { inProcess } from "@sweatpants/agent-host/server";
import { withTestScenario } from "@sweatpants/test-rig";
import { createApplication } from "../../fixtures/application.ts";
import { durableSelection, selectionEffects } from "../../fixtures/durable-selection.ts";
import { selectionPlugin } from "../../fixtures/selection-plugin.tsx";
import { useUI } from "../../support/ui.tsx";

const options = {
  binding: "http" as const,
  createApplication: (context: Parameters<typeof createApplication>[0]) =>
    createApplication(context, {
      tools: [durableSelection],
      execution: inProcess(),
      effects: selectionEffects(),
    }),
};

describe("pending durable elicitation replay", () => {
  for (const withNarration of [false, true]) {
    it(`restores the same pending elicitation${withNarration ? " with preceding streamed narration" : ""} without sampling again`, async () => {
      await withTestScenario(options, function* (rig) {
        // Arrange: a public client may already have a completed assistant answer.
        using first = yield* useUI(rig, { plugins: [selectionPlugin], threadId: "replay" });
        if (withNarration) {
          const greet = yield* first.waitForEnabledButton("Book trip");
          greet.click();
          const greeting = yield* rig.model.request();
          yield* greeting.respond.text("Welcome aboard");
          yield* first.waitForText("Welcome aboard");
          yield* first.waitForEnabledButton("Book trip");
        }

        // Act: stream narration and a durable call, then park after the nested sample.
        const send = yield* first.waitForEnabledButton("Book trip");
        send.click();
        const outer = yield* rig.model.request();
        const calls = [{ id: "pending", name: "select_option", arguments: { topic: "replay" } }];
        if (withNarration) {
          yield* outer.respond.textAndToolCalls("Here are the new choices", calls);
        } else {
          yield* outer.respond.toolCalls(calls);
        }
        const nested = yield* rig.model.request();
        yield* nested.respond.text("Accepted private sample");
        const originalChoice = yield* first.waitForEnabledButton("replay-alpha");
        if (withNarration) {
          yield* first.waitForText("Here are the new choices");
        }
        const interruptId = originalChoice
          .closest("[data-elicit-id]")
          ?.getAttribute("data-elicit-id");
        expect(interruptId).toBeTruthy();
        const before = rig.model.requests().length;
        expect(before).toBe(withNarration ? 3 : 2);

        // Act: reconnect a separate public client with the same conversation identity.
        first[Symbol.dispose]();
        yield* call(() => first.client.close());
        using resumed = yield* useUI(rig, { plugins: [selectionPlugin], threadId: "replay" });
        yield* call(() => resumed.client.reconnect());
        const restoredChoice = yield* resumed.waitForEnabledButton("replay-alpha");

        // Assert: restoring preserves accepted messages, pending identity and provider count.
        expect(restoredChoice.closest("[data-elicit-id]")?.getAttribute("data-elicit-id")).toBe(
          interruptId,
        );
        expect(JSON.stringify(resumed.client.getSnapshot().messages)).toContain(
          '"state":"pending"',
        );
        if (withNarration) {
          expect(JSON.stringify(resumed.client.getSnapshot().messages)).toContain("Welcome aboard");
          expect(JSON.stringify(resumed.client.getSnapshot().messages)).toContain(
            "Here are the new choices",
          );
          expect(JSON.stringify(resumed.client.getSnapshot().messages)).toContain("Book Oslo");
        }
        expect(rig.model.requests()).toHaveLength(before);

        // Act: answer only the restored choice and finish the outer response.
        const mark = rig.agui.mark();
        restoredChoice.click();
        const final = yield* rig.model.request();
        yield* final.respond.text("Replay complete");
        yield* resumed.waitForText("Replay complete");
        yield* resumed.waitForEnabledButton("Book trip");

        // Assert: one terminal response, one additional sample, and a durable responded fact.
        expect(
          rig.agui.events(mark).filter((event) => event.type === EventType.RUN_FINISHED),
        ).toHaveLength(1);
        expect(rig.model.requests()).toHaveLength(before + 1);
        expect(JSON.stringify(resumed.client.getSnapshot().messages)).toContain(interruptId!);
        expect(JSON.stringify(resumed.client.getSnapshot().messages)).toContain(
          '"state":"responded"',
        );
      });
    });
  }
});
