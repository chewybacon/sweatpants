import { describe, expect, it } from "vitest";
import { call } from "effection";
import { EventType } from "@ag-ui/core";
import { inProcess } from "@sweatpants/agent-host/server";
import { withTestScenario } from "@sweatpants/test-rig";
import { createApplication } from "../../fixtures/application.ts";
import { durableSelection, selectionEffects } from "../../fixtures/durable-selection.ts";
import { selectionPlugin } from "../../fixtures/selection-plugin.tsx";
import { useUI } from "../../support/ui.tsx";
import { waitForSnapshot } from "../../support/client.ts";

const options = {
  binding: "http" as const,
  createApplication: (context: Parameters<typeof createApplication>[0]) =>
    createApplication(context, {
      tools: [durableSelection],
      execution: inProcess(),
      effects: selectionEffects(),
    }),
};

describe("authoritative elicitation settlement", () => {
  for (const action of ["accept", "decline", "cancel"] as const) {
    it(`rejects duplicate and conflicting stale ${action} responses at the HTTP boundary`, async () => {
      const executed: string[] = [];
      await withTestScenario(
        {
          ...options,
          createApplication: (context) =>
            createApplication(context, {
              tools: [durableSelection],
              execution: inProcess(),
              effects: selectionEffects((topic) => executed.push(topic)),
            }),
        },
        function* (rig) {
          // Arrange: retain the actual pending authority and interrupt identity.
          using ui = yield* useUI(rig, { threadId: `stale-${action}`, plugins: [selectionPlugin] });
          const send = yield* ui.waitForEnabledButton("Book trip");
          send.click();
          const outer = yield* rig.model.request();
          yield* outer.respond.toolCalls([
            { id: "selection", name: "select_option", arguments: { topic: "stale" } },
          ]);
          const nested = yield* rig.model.request();
          yield* nested.respond.text("Recorded nested answer");
          const choice = yield* ui.waitForEnabledButton(
            action === "accept"
              ? "stale-alpha"
              : action === "decline"
                ? "Decline"
                : "Cancel choice",
          );
          const pending = yield* waitForSnapshot(
            ui.client,
            (state) => state.authority?.state === "parked",
          );
          const authority = pending.authority;
          if (authority?.state !== "parked") {
            throw new Error("Expected parked authority");
          }
          const event = rig.agui
            .events()
            .find(
              (entry) =>
                entry.type === EventType.RUN_FINISHED && entry.outcome?.type === "interrupt",
            );
          if (event?.type !== EventType.RUN_FINISHED || event.outcome?.type !== "interrupt") {
            throw new Error("Expected public interrupt");
          }
          const interruptId = event.outcome.interrupts[0].id;

          // Act: settle normally, then reconstruct that fact in a fresh client.
          choice.click();
          const final = yield* rig.model.request();
          yield* final.respond.text("Settled");
          yield* ui.waitForText("Settled");
          yield* ui.waitForEnabledButton("Book trip");
          ui[Symbol.dispose]();
          yield* call(() => ui.client.close());
          using reopened = yield* useUI(rig, {
            threadId: `stale-${action}`,
            plugins: [selectionPlugin],
          });
          yield* call(() => reopened.client.reconnect());
          const expectedState = action === "cancel" ? "cancelled" : "responded";
          expect(JSON.stringify(reopened.client.getSnapshot().messages)).toContain(
            `"state":"${expectedState}"`,
          );
          expect(JSON.stringify(reopened.client.getSnapshot().messages)).toContain(interruptId);
          const count = rig.model.requests().length;

          // Act: post new commands using the captured stale revision, including a conflicting choice.
          for (const conflict of [false, true]) {
            const payload = conflict
              ? { action: "accept", content: { selected: "stale-beta" } }
              : action === "accept"
                ? { action, content: { selected: "stale-alpha" } }
                : { action };
            const response = yield* call(() =>
              rig.transport.fetch("/assistant/chat", {
                method: "POST",
                signal: AbortSignal.timeout(2_000),
                headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
                body: JSON.stringify({
                  clientId: "captured-stale-client",
                  conversationId: `stale-${action}`,
                  runId: crypto.randomUUID(),
                  state: {},
                  context: [],
                  forwardedProps: {},
                  command: {
                    type: "respond-to-elicit",
                    commandId: crypto.randomUUID(),
                    issuedAt: Date.now(),
                    expiresAt: Date.now() + 60_000,
                    basisRevision: authority.revision,
                    logicalTurnId: authority.activeLogicalTurnId,
                    executionId: authority.activeExecutionId,
                    interruptId,
                    status: !conflict && action === "cancel" ? "cancelled" : "resolved",
                    payload,
                  },
                }),
              }),
            );
            const body = yield* call(() => response.text());
            const frames = body
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as Record<string, unknown>);

            // Assert: rejection comes from the server, never from a test-harness responder guard.
            expect(response.ok).toBe(true);
            expect(frames).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ type: "RUN_ERROR", code: "elicit_not_open" }),
              ]),
            );
            expect(rig.model.requests()).toHaveLength(count);
            expect(executed).toEqual(["stale"]);
          }
          expect(JSON.stringify(reopened.client.getSnapshot().messages)).toContain(
            `"state":"${expectedState}"`,
          );
        },
      );
    });
  }
});
