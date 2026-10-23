// @vitest-environment node
import { call, createSignal, spawn } from "effection";
import { expect, it } from "vitest";
import { EventType } from "@ag-ui/core";
import { makePlugin } from "@sweatpants/react-chat";
import { withTestScenario } from "@sweatpants/test-rig";
import { createApplication } from "../../fixtures/application.ts";
import { createSingleChoice } from "../../fixtures/single-choice.ts";
import { useClient, waitForSnapshot } from "../../support/client.ts";
import { testToolRuntime } from "../../support/test-tool-runtime.ts";

for (const action of ["accept", "decline", "cancel"] as const) {
  it(`replays the same ${action} command and rejects a changed payload under its identity`, async () => {
    let executions = 0;
    const tool = createSingleChoice(() => executions++);
    const answer = createSignal<{ action: "accept"; content: { number: number } }>();
    const plugin = makePlugin(tool)
      .onElicit({
        choose: function* () {
          const subscription = yield* answer;
          return (yield* subscription.next()).value;
        },
      })
      .build();
    await withTestScenario(
      {
        binding: "http",
        createApplication: (context) =>
          createApplication(context, {
            tools: [tool],
            execution: testToolRuntime(),
          }),
      },
      function* (rig) {
        // Arrange: capture the public identity of a parked ordinary invocation.
        const client = yield* useClient(rig, { plugins: [plugin], threadId: `retry-${action}` });
        const send = yield* spawn(() => call(() => client.sendMessage("Choose once")));
        const outer = yield* rig.model.request();
        yield* outer.respond.toolCalls([
          { id: "choice", name: tool.name, arguments: { count: 3 } },
        ]);
        const snapshot = yield* waitForSnapshot(
          client,
          (state) => state.authority?.state === "parked",
        );
        yield* send;
        const authority = snapshot.authority;
        if (authority?.state !== "parked") {
          throw new Error("Expected parked authority");
        }
        const event = rig.agui
          .events()
          .find(
            (candidate) =>
              candidate.type === EventType.RUN_FINISHED && candidate.outcome?.type === "interrupt",
          );
        if (event?.type !== EventType.RUN_FINISHED || event.outcome?.type !== "interrupt") {
          throw new Error("Expected a public interrupt");
        }
        const interruptId = event.outcome.interrupts[0].id;
        if (action === "accept") {
          // Act: bypass the client's admission guard while this choice is parked.
          const conflictResponse = yield* call(() =>
            rig.transport.fetch("/assistant/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
              body: JSON.stringify({
                clientId: "admission-probe",
                conversationId: `retry-${action}`,
                runId: crypto.randomUUID(),
                command: {
                  type: "send-message",
                  commandId: crypto.randomUUID(),
                  issuedAt: Date.now(),
                  expiresAt: Date.now() + 60_000,
                  basisRevision: authority.revision,
                  messageId: "not-admitted",
                },
                userMessage: { id: "not-admitted", role: "user", content: "Must not be admitted" },
                state: {},
                context: [],
                forwardedProps: {},
              }),
            }),
          );
          const text = yield* call(() => conflictResponse.text());
          const frames = text
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          expect(conflictResponse.status).toBe(200);
          expect(frames).toContainEqual(
            expect.objectContaining({
              type: "sweatpants.conversation-authority.v1",
              authority: expect.objectContaining({ state: "parked" }),
            }),
          );
          expect(frames).toContainEqual(
            expect.objectContaining({ type: "RUN_ERROR", code: "conversation_not_idle" }),
          );
          expect(rig.model.requests()).toHaveLength(1);
        }

        const command = {
          type: "respond-to-elicit",
          commandId: crypto.randomUUID(),
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          basisRevision: authority.revision,
          logicalTurnId: authority.activeLogicalTurnId,
          executionId: authority.activeExecutionId,
          interruptId,
          status: action === "cancel" ? "cancelled" : "resolved",
          payload: action === "accept" ? { action, content: { number: 1 } } : { action },
        };
        function* post(nextCommand: typeof command) {
          const response = yield* call(() =>
            rig.transport.fetch("/assistant/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
              body: JSON.stringify({
                clientId: "retry-client",
                conversationId: `retry-${action}`,
                runId: crypto.randomUUID(),
                state: {},
                context: [],
                forwardedProps: {},
                command: nextCommand,
              }),
            }),
          );
          expect(response.status).toBe(200);
          const body = yield* call(() => response.text());
          return body
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        }

        // Act: settle with a wire command, then resend that exact command identity.
        const completing = yield* spawn(() => post(command));
        const final = yield* rig.model.request();
        const output = (
          final.body.input as Array<{ type: string; call_id?: string; output?: string }>
        ).find((item) => item.type === "function_call_output" && item.call_id === "choice");
        expect(JSON.parse(output!.output!)).toEqual({
          action,
          selected: action === "accept" ? 1 : null,
        });
        yield* final.respond.text("Choice settled");
        const completed = yield* completing;
        expect(completed.some((frame) => frame.type === "RUN_ERROR")).toBe(false);
        expect(completed.some((frame) => frame.type === "RUN_FINISHED")).toBe(true);
        const duplicate = yield* post(command);

        // Assert: a retry returns the current window without completing another run.
        expect(duplicate.some((frame) => frame.type === "RUN_ERROR")).toBe(false);
        expect(duplicate.some((frame) => frame.type === "RUN_FINISHED")).toBe(false);
        expect(duplicate.some((frame) => frame.type === "sweatpants.conversation-window.v1")).toBe(
          true,
        );
        expect(rig.model.requests()).toHaveLength(2);
        expect(executions).toBe(1);

        // Act / Assert: reusing that ID for a different answer is an identity conflict.
        const conflict = yield* post({
          ...command,
          payload: { action: "accept", content: { number: 2 } },
        });
        expect(conflict).toContainEqual(
          expect.objectContaining({
            type: "RUN_ERROR",
            code: "command_identity_conflict",
          }),
        );
        expect(rig.model.requests()).toHaveLength(2);
        expect(executions).toBe(1);
      },
    );
  });
}
