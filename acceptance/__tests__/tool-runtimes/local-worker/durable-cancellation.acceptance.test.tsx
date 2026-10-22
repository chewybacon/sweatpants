import { describe, expect, it } from "vitest";
import { call, spawn } from "effection";
import { observedExecution } from "./fixtures/observed-execution.ts";
import { withTestScenario } from "@sweatpants/test-rig";
import { createApplication } from "../../../fixtures/application.ts";
import { durableSelection, selectionEffects } from "../../../fixtures/durable-selection.ts";
import { selectionPlugin } from "../../../fixtures/selection-plugin.tsx";
import { useUI } from "../../../support/ui.tsx";
import { useClient, waitForSnapshot } from "../../../support/client.ts";

const options = {
  binding: "http" as const,
  createApplication: (context: Parameters<typeof createApplication>[0]) =>
    createApplication(context, {
      tools: [durableSelection],
      execution: observedExecution().execution,
      effects: selectionEffects(),
    }),
};

describe("durable worker cancellation and effect failures", () => {
  it("supersedes a parked durable tool before starting its successor", async () => {
    await withTestScenario(options, function* (rig) {
      // Arrange / Act: park a real durable program at a typed choice.
      using ui = yield* useUI(rig, { plugins: [selectionPlugin], queue: "interrupt" });
      const send = yield* ui.waitForEnabledButton("Book trip");
      send.click();
      const request = yield* rig.model.request();
      yield* request.respond.toolCalls([
        { id: "superseded", name: "select_option", arguments: { topic: "cancel" } },
      ]);
      const nested = yield* rig.model.request();
      yield* nested.respond.text("Recorded note");
      yield* ui.waitForEnabledButton("cancel-alpha");
      const mark = rig.agui.mark();

      // Act: submit an interrupting successor through the hook.
      ui.getByRole("button", { name: "Replace booking" }).click();
      const cancellation = yield* rig.agui.event("RUN_ERROR", { after: mark });
      expect(cancellation).toMatchObject({ code: "PROGRAM_CANCELLED" });
      const next = yield* rig.model.request();
      const history = JSON.stringify(next.body.input);

      // Assert: cancellation is retained, private sampling is not a new user turn.
      expect(history).toContain("Replace booking");
      expect(history).toContain("superseded");
      expect(history).toMatch(/cancel/i);
      expect(history).not.toContain("PRIVATE_SELECTION_NOTE");
      yield* next.respond.text("Replacement complete");
      yield* ui.waitForText("Replacement complete");
      yield* ui.waitForEnabledButton("Book trip");
    });
  });

  it("aborts a pending nested sample and recovers in a fresh client", async () => {
    await withTestScenario(options, function* (rig) {
      // Arrange / Act: leave a tool-owned provider request in flight.
      using ui = yield* useUI(rig, { threadId: "nested-cancel", plugins: [selectionPlugin] });
      const send = yield* ui.waitForEnabledButton("Book trip");
      send.click();
      const outer = yield* rig.model.request();
      yield* outer.respond.toolCalls([
        { id: "cancel-nested", name: "select_option", arguments: { topic: "cancel" } },
      ]);
      const nested = yield* rig.model.request();
      const aborted = yield* spawn(() => nested.respond.awaitAbort());

      // Act: cancel through the public client and await the actual provider abort.
      yield* call(() => ui.client.stop());
      yield* aborted;
      yield* waitForSnapshot(ui.client, (state) => state.authority?.state === "idle");
      ui[Symbol.dispose]();
      yield* call(() => ui.client.close());
      using resumed = yield* useUI(rig, { threadId: "nested-cancel", plugins: [selectionPlugin] });
      yield* call(() => resumed.client.reconnect());
      const again = yield* resumed.waitForEnabledButton("Book trip");
      again.click();
      const recovery = yield* rig.model.request();
      expect(JSON.stringify(recovery.body.input)).not.toContain("PRIVATE_SELECTION_NOTE");
      yield* recovery.respond.text("Recovered after cancellation");

      // Assert: an independent client can continue the same durable conversation.
      yield* resumed.waitForText("Recovered after cancellation");
      yield* resumed.waitForEnabledButton("Book trip");
      expect(resumed.client.getSnapshot().error).toBeNull();
    });
  });

  it("records a durable host-effect failure and recovers on the next turn", async () => {
    await withTestScenario(options, function* (rig) {
      // Arrange / Act: invoke the declared failing effect through a durable tool.
      const client = yield* useClient(rig, { threadId: "effect-failure" });
      const sending = yield* spawn(() => call(() => client.sendMessage("Fail effect")));
      const request = yield* rig.model.request();
      yield* request.respond.toolCalls([
        { id: "effect-call", name: "select_option", arguments: { topic: "effect-failure" } },
      ]);
      yield* waitForSnapshot(client, (state) => state.status === "error");
      yield* sending;

      // Act: ask another question through the same client.
      const recovery = yield* spawn(() => call(() => client.sendMessage("Recover effect failure")));
      const next = yield* rig.model.request();

      // Assert: the failed call remains paired with its error in recovery history.
      expect(JSON.stringify(next.body.input)).toContain("effect-call");
      expect(JSON.stringify(next.body.input)).toMatch(/error|fail/i);
      yield* next.respond.text("Effect recovery complete");
      yield* recovery;
      const ready = yield* waitForSnapshot(client, (state) => state.status === "ready");
      expect(ready.error).toBeNull();
    });
  });
});
