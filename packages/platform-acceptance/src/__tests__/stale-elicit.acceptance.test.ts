import { describe, expect, it } from "vitest";
import { call } from "effection";
import { withTestScenario, type TestRigOptions } from "@sweatpants/test-rig";
import {
  ACCEPTANCE_DURABLE_TOOL_NAME,
  ACCEPTANCE_MODEL_ID,
  DURABLE_SAMPLE_PROMPT_MARKER,
  createDurabilityAcceptanceApplication,
} from "../lib/acceptance-app.ts";

type Binding = TestRigOptions["binding"];

type NativeFrame = {
  readonly type: string;
  readonly code?: string;
  readonly message?: string;
};

function parseFrames(body: string): readonly NativeFrame[] {
  return body
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as NativeFrame);
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

type Settlement = "accept" | "decline" | "cancel";

type ResumeEntry = {
  readonly interruptId: string;
  readonly status: "resolved" | "cancelled";
  readonly payload?: Record<string, unknown>;
};

function settledResume(interruptId: string, settlement: Settlement): ResumeEntry {
  if (settlement === "cancel") {
    return { interruptId, status: "cancelled" };
  }
  return {
    interruptId,
    status: "resolved",
    payload:
      settlement === "accept"
        ? { action: "accept", content: { selected: "stale-alpha" } }
        : { action: "decline" },
  };
}

function conflictingResume(interruptId: string): ResumeEntry {
  return {
    interruptId,
    status: "resolved",
    payload: { action: "accept", content: { selected: "stale-beta" } },
  };
}

async function runStaleElicit(binding: Binding, settlement: Settlement): Promise<void> {
  await withTestScenario(
    {
      binding,
      modelId: ACCEPTANCE_MODEL_ID,
      createApplication: createDurabilityAcceptanceApplication,
      scenarioTimeoutMs: 30_000,
    },
    function* (s) {
      const conversation = s.conversation({ initialToolChoice: "required" });
      const turn = yield* conversation.send(`STALE_ELICIT_${settlement.toUpperCase()}_V1`);
      const outer = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* outer.respond.toolCalls([
        {
          id: `stale-elicit-${settlement}-call`,
          name: ACCEPTANCE_DURABLE_TOOL_NAME,
          arguments: { topic: `stale-${settlement}` },
        },
      ]);
      const sample = yield* s.model.request((request) => {
        expect(JSON.stringify(request.body.input)).toContain(DURABLE_SAMPLE_PROMPT_MARKER);
      });
      yield* sample.respond.text(`STALE_ELICIT_${settlement.toUpperCase()}_SAMPLE_V1`);

      const pending = yield* turn.elicit("chooseOption");
      const pendingSnapshot = yield* turn.expectSnapshot(
        (snapshot) => snapshot.authority?.state === "parked",
      );
      const pendingAuthority = pendingSnapshot.authority;
      if (pendingAuthority?.state !== "parked") {
        throw new Error("Pending elicitation did not publish parked authority");
      }
      const acceptedResume = settledResume(pending.elicitId, settlement);
      const staleConflict = conflictingResume(pending.elicitId);

      // A current client settles the durable elicit first.
      if (settlement === "accept") {
        yield* pending.accept({ selected: "stale-alpha" });
      } else if (settlement === "decline") {
        yield* pending.decline();
      } else {
        yield* pending.cancel();
      }
      const terminal = yield* s.model.request({ model: ACCEPTANCE_MODEL_ID });
      yield* terminal.respond.text(`STALE_ELICIT_${settlement.toUpperCase()}_COMPLETE_V1`);
      yield* turn.settled();

      // Reopen proves the settled fact is reconstructed before the old client
      // attempts to submit its captured pending response.
      const reopened = yield* conversation.reopen();
      const reconstructed = reopened.snapshot();
      const reconstructedText = JSON.stringify(reconstructed.messages);
      const expectedState = settlement === "cancel" ? "cancelled" : "responded";
      expect(reconstructedText).toContain(pending.elicitId);
      expect(reconstructedText).toContain(`"state":"${expectedState}"`);

      const postCapturedResume = function* (entry: ResumeEntry, label: string) {
        const commandId = crypto.randomUUID();
        const response = yield* call(() =>
          s.transport.fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
            body: JSON.stringify({
              command: {
                type: "respond-to-elicit",
                commandId,
                issuedAt: Date.now(),
                expiresAt: Date.now() + 60_000,
                basisRevision: pendingAuthority.revision,
                logicalTurnId: pendingAuthority.activeLogicalTurnId,
                executionId: pendingAuthority.activeExecutionId,
                interruptId: entry.interruptId,
                status: entry.status,
                /* CONDITIONAL-SPREAD: Omit absent payload from acceptance protocol fixtures; explicit undefined is not a portable JSON value. */
                ...(entry.payload === undefined ? {} : { payload: entry.payload }),
              },
              clientId: "stale-elicit-client",
              conversationId: conversation.conversationId,
              runId: `stale-client-run:${settlement}:${label}`,
              state: {},
              context: [],
              forwardedProps: {},
            }),
          }),
        );
        const body = yield* call(() => readResponseWithin(response, 2_000));
        return { response, frames: parseFrames(body) };
      };

      // This is a new command formed from the stale parked revision, not an
      // exact command-id retry. It must be rejected without rerunning work.
      const requestsBeforeRetry = s.model.requests().length;
      const retry = yield* postCapturedResume(acceptedResume, "retry");
      expect(retry.response.ok).toBe(true);
      expect(retry.frames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "RUN_ERROR",
            code: "elicit_not_open",
          }),
        ]),
      );
      expect(s.model.requests()).toHaveLength(requestsBeforeRetry);

      // A different response formed from the same stale revision is rejected
      // at conversation admission before journal settlement is consulted.
      const requestsBeforeConflict = s.model.requests().length;
      const conflict = yield* postCapturedResume(staleConflict, "conflict");
      expect(conflict.response.ok).toBe(true);
      expect(conflict.frames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "RUN_ERROR",
            code: "elicit_not_open",
          }),
        ]),
      );
      expect(s.model.requests()).toHaveLength(requestsBeforeConflict);
      expect(JSON.stringify(reopened.snapshot().messages)).toContain(`"state":"${expectedState}"`);
    },
  );
}

describe("single durable elicitation stale-client semantics", () => {
  it.each(["accept", "decline", "cancel"] as const)(
    "%s remains safe for stale clients in-process",
    async (settlement) => {
      await runStaleElicit("in-process", settlement);
    },
    30_000,
  );

  it.each(["accept", "decline", "cancel"] as const)(
    "%s remains safe for stale clients over HTTP",
    async (settlement) => {
      await runStaleElicit("http", settlement);
    },
    30_000,
  );
});
