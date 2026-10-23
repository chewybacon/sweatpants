// binding-conformance: shared semantics run once over HTTP; in-process composition
// and storage behavior have separate focused tests.
import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import { normalizeResponsesHistory, withTestScenario } from "@sweatpants/test-rig";
import type { ChatUIMessage, ChatUIPart } from "@sweatpants/chat-core";
import {
  createNestedToolApplication,
  NESTED_CHILD_NAME,
  NESTED_PARENT_NAME,
} from "../fixtures/nested-tool-application.ts";

const MODEL = "nested-tool-ownership";

function nestedMessages(parts: readonly ChatUIPart[]): ChatUIMessage[] {
  return parts.flatMap((part) =>
    part.type === "message"
      ? [part.message, ...nestedMessages(part.message.parts)]
      : "parts" in part
        ? nestedMessages(part.parts)
        : [],
  );
}
function allMessages(messages: readonly ChatUIMessage[]): ChatUIMessage[] {
  return messages.flatMap((message) => [message, ...nestedMessages(message.parts)]);
}

describe.each(["http"] as const)("nested tool ownership over %s", (binding) => {
  it.each([false, true])(
    "preserves the child call across park/resume (reopen=%s)",
    async (reopen) => {
      let recordedWork = 0;
      await withTestScenario(
        {
          binding,
          modelId: MODEL,
          scenarioTimeoutMs: 30_000,
          createApplication: (context) =>
            createNestedToolApplication(context, () => {
              recordedWork += 1;
            }),
        },
        function* (s) {
          const conversation = s.conversation({ initialToolChoice: "required" });
          const turn = yield* conversation.send("Ask the child for a reply");
          const initial = yield* s.model.request({ model: MODEL });
          expect(initial.body.tools).toMatchObject([{ name: NESTED_PARENT_NAME }]);
          expect(initial.body.tools).toHaveLength(1);
          yield* initial.respond.toolCalls([
            { id: "parent-call", name: NESTED_PARENT_NAME, arguments: {} },
          ]);

          const pending = yield* turn.elicit("reply");
          expect(pending.toolName).toBe(NESTED_CHILD_NAME);
          expect(recordedWork).toBe(1);
          const opener = s.agui
            .events()
            .find(
              (event) =>
                event.type === EventType.TOOL_CALL_START && event.toolCallId === pending.callId,
            );
          if (opener?.type !== EventType.TOOL_CALL_START) {
            throw new Error("Missing child tool opener");
          }
          expect(opener.subagentRunId).toEqual(expect.any(String));
          const snapshots = [yield* turn.snapshot()];

          let resumed = turn;
          if (reopen) {
            const reconnected = yield* conversation.reopen();
            expect(s.model.requests()).toHaveLength(1);
            snapshots.push(reconnected.snapshot());
            resumed = reconnected.resumePendingElicit("reply");
            const recovered = yield* resumed.elicit("reply");
            expect(recovered.elicitId).toBe(pending.elicitId);
            expect(recovered.bindingId).toBe(pending.bindingId);
            expect(recovered.callId).toBe(pending.callId);
            yield* recovered.accept({ reply: "nested reply survived" });
          } else {
            yield* pending.accept({ reply: "nested reply survived" });
          }

          const final = yield* s.model.request({ model: MODEL });
          expect(JSON.stringify(final.body.input)).toContain("nested reply survived");
          const modelHistory = normalizeResponsesHistory(final.body.input);
          expect(modelHistory).toMatchObject([
            { type: "user_text" },
            { type: "assistant_tool_call", name: NESTED_PARENT_NAME },
            { type: "tool_result", output: { reply: "nested reply survived" } },
          ]);
          yield* final.respond.text("Nested tool completed.");
          const completed = yield* resumed.settled();
          expect(completed.text).toContain("Nested tool completed.");
          expect(recordedWork).toBe(1);
          expect(s.model.requests()).toHaveLength(2);

          const result = s.agui
            .events()
            .find(
              (event) =>
                event.type === EventType.TOOL_CALL_RESULT && event.toolCallId === pending.callId,
            );
          if (result?.type !== EventType.TOOL_CALL_RESULT) {
            throw new Error("Missing child tool result");
          }
          expect(result.subagentRunId).toBe(opener.subagentRunId);
          expect(result).toMatchObject({
            content: expect.stringContaining("nested reply survived"),
          });
          // Hydration arrives through conversation windows, not live MESSAGES_SNAPSHOT events.
          const completedSnapshots = [yield* resumed.snapshot()];
          const completedReopen = yield* conversation.reopen();
          completedSnapshots.push(completedReopen.snapshot());
          for (const snapshot of completedSnapshots) {
            const calls = allMessages(snapshot.messages)
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool-call");
            expect(calls).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  name: NESTED_PARENT_NAME,
                  state: "output-available",
                  output: { reply: "nested reply survived" },
                }),
                expect.objectContaining({
                  callId: pending.callId,
                  state: "output-available",
                  output: { reply: "nested reply survived" },
                }),
              ]),
            );
          }
          expect(s.model.requests()).toHaveLength(2);
          snapshots.push(...completedSnapshots);
          for (const snapshot of snapshots) {
            const containing = allMessages(snapshot.messages).filter((message) =>
              message.parts.some(
                (part) => part.type === "tool-call" && part.callId === pending.callId,
              ),
            );
            expect(containing.length).toBeGreaterThan(0);
            expect(
              containing.every((message) => message.subagentRunId === opener.subagentRunId),
            ).toBe(true);
          }

          // A new turn reconstructs context from stored public roots, not the active task journal.
          // Child calls remain visible in the UI, but cannot become calls by the outer model.
          const followUp = yield* completedReopen.send("What reply did you receive?");
          const followUpRequest = yield* s.model.request({ model: MODEL });
          expect(normalizeResponsesHistory(followUpRequest.body.input)).toEqual([
            ...modelHistory,
            { type: "assistant_text", text: "Nested tool completed." },
            { type: "user_text", text: "What reply did you receive?" },
          ]);
          yield* followUpRequest.respond.text("You replied: nested reply survived.");
          expect((yield* followUp.settled()).text).toBe("You replied: nested reply survived.");
          expect(recordedWork).toBe(1);
          expect(s.model.requests()).toHaveLength(3);
        },
      );
    },
    30_000,
  );
});
