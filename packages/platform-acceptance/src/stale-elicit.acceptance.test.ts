import { describe, expect, it } from "vitest";
import { call } from "effection";
import { projectChatMessagesToWire } from "@sweatpants/chat-core";
import { withTestScenario, type TestRigOptions } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_DURABLE_TOOL_NAME,
  ACCEPTANCE_MODEL_ID,
  DURABLE_SAMPLE_PROMPT_MARKER,
  createAcceptanceApplication,
} from "./lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

type DurableFrame = {
  readonly lsn: number;
  readonly event: { readonly type: string; readonly code?: string; readonly message?: string };
};

function parseFrames(body: string): readonly DurableFrame[] {
  return body
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DurableFrame);
}

function readResponseWithin(response: Response, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void response.body
        ?.cancel("stale elicitation retry response timed out")
        .catch(() => undefined);
      reject(new Error(`stale elicitation retry response exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    response.text().then(
      (body) => {
        clearTimeout(timer);
        resolve(body);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function runStaleElicit(binding: Binding): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createAcceptanceApplication,
      scenarioTimeoutMs: 30_000,
    },
    function* (s) {
      const conversation = s.conversation({ initialToolChoice: "required" });
      const turn = yield* conversation.send("STALE_ELICIT_DURABLE_V1");
      const outer = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* outer.respond.toolCalls([
        {
          id: "stale-elicit-call",
          name: ACCEPTANCE_DURABLE_TOOL_NAME,
          arguments: { topic: "stale" },
        },
      ]);
      const sample = yield* s.model.request((request) => {
        expect(JSON.stringify(request.body.input)).toContain(DURABLE_SAMPLE_PROMPT_MARKER);
      });
      yield* sample.respond.text("STALE_ELICIT_SAMPLE_V1");

      const pending = yield* turn.elicit("chooseOption");
      const pendingSnapshot = yield* turn.snapshot();
      const staleMessages = projectChatMessagesToWire(pendingSnapshot.messages);
      const staleResume = {
        interruptId: pending.elicitId,
        status: "resolved" as const,
        payload: {
          action: "accept" as const,
          content: { selected: "stale-beta" },
        },
      };

      // A current client settles the durable elicit first.
      yield* pending.accept({ selected: "stale-alpha" });
      const terminal = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* terminal.respond.text("STALE_ELICIT_COMPLETE_V1");
      yield* turn.settled();

      // Reopen proves the settled fact is reconstructed before the old client
      // attempts to submit its captured pending response.
      const reopened = yield* conversation.reopen();
      const reconstructed = reopened.snapshot();
      const reconstructedText = JSON.stringify(reconstructed.messages);
      expect(reconstructedText).toContain(pending.elicitId);
      expect(reconstructedText).toContain('"state":"responded"');

      const postCapturedResume = function* (selection: string) {
        const response = yield* call(() =>
          s.transport.fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
            body: JSON.stringify({
              trigger: "submit-message",
              threadId: conversation.conversationId,
              conversationId: conversation.conversationId,
              runId: `stale-client-run:${selection}`,
              messages: staleMessages,
              resume: [
                {
                  ...staleResume,
                  payload: {
                    action: "accept" as const,
                    content: { selected: selection },
                  },
                },
              ],
            }),
          }),
        );
        const body = yield* call(() => readResponseWithin(response, 2_000));
        return { response, frames: parseFrames(body) };
      };

      // An exact retry is a durable no-op: it receives a finite replay response,
      // but does not execute the tool or ask the provider for another turn.
      const requestsBeforeRetry = s.model.requests().length;
      const retry = yield* postCapturedResume("stale-alpha");
      expect(retry.response.ok).toBe(true);
      expect(retry.frames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({ type: "RUN_FINISHED" }),
          }),
        ]),
      );
      expect(s.model.requests()).toHaveLength(requestsBeforeRetry);

      // A stale client with a different answer conflicts with the durable
      // settlement and is rejected before any execution is resumed.
      const requestsBeforeConflict = s.model.requests().length;
      const conflict = yield* postCapturedResume("stale-beta");
      expect(conflict.response.ok).toBe(true);
      expect(conflict.frames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({
              type: "RUN_ERROR",
              code: "RESUME_CONFLICT",
            }),
          }),
        ]),
      );
      expect(s.model.requests()).toHaveLength(requestsBeforeConflict);
      expect(JSON.stringify(reopened.snapshot().messages)).toContain('"state":"responded"');
    },
  );
}

describe("single durable elicitation stale-client semantics", () => {
  it("rejects a conflicting already-settled response in-process", async () => {
    await runStaleElicit("in-process");
  }, 30_000);

  it("rejects a conflicting already-settled response over HTTP", async () => {
    await runStaleElicit("http");
  }, 30_000);
});
