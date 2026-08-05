import { beforeEach, describe, expect, it } from "vitest";

import {
  registerInterruptsFromRunFinished,
  resetInterruptRegistry,
  scopeIdForInterruptRun,
  upsertInterruptRecords,
  verifyResumeEntries,
} from "../registry.ts";

const threadId = "thread-schema-actions";
const interruptedRunId = "run-interrupted";
const scopeId = scopeIdForInterruptRun(threadId, interruptedRunId);

function registerRequiredCardInterrupt(): void {
  registerInterruptsFromRunFinished({
    type: "RUN_FINISHED",
    threadId,
    runId: interruptedRunId,
    outcome: {
      type: "interrupt",
      interrupts: [
        {
          id: "pick-card",
          reason: "input_required",
          responseSchema: {
            type: "object",
            required: ["cardId"],
            properties: { cardId: { type: "string" } },
          },
        },
      ],
    },
  });
}

describe("interrupt resume action validation", () => {
  beforeEach(() => {
    resetInterruptRegistry();
    registerRequiredCardInterrupt();
  });

  it.each(["decline", "cancel"] as const)(
    "accepts %s without applying the accepted-content schema",
    (action) => {
      const result = verifyResumeEntries({
        threadId,
        scopeId,
        runId: `run-${action}`,
        resume: [{ interruptId: "pick-card", status: "resolved", payload: { action } }],
      });

      expect(result.ok).toBe(true);
    },
  );

  it("distinguishes an idempotent retry from a conflicting stale response", () => {
    const accepted = verifyResumeEntries({
      threadId,
      scopeId,
      runId: "run-first-settlement",
      resume: [
        {
          interruptId: "pick-card",
          status: "resolved",
          payload: { action: "accept", content: { cardId: "ace-spades" } },
        },
      ],
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) {
      throw new Error(accepted.message);
    }
    upsertInterruptRecords(accepted.records);

    const retry = verifyResumeEntries({
      threadId,
      scopeId,
      runId: "run-stale-retry",
      resume: [
        {
          interruptId: "pick-card",
          status: "resolved",
          payload: { action: "accept", content: { cardId: "ace-spades" } },
        },
      ],
    });
    expect(retry).toMatchObject({ ok: true, idempotent: true, records: [] });

    const conflict = verifyResumeEntries({
      threadId,
      scopeId,
      runId: "run-stale-conflict",
      resume: [
        {
          interruptId: "pick-card",
          status: "resolved",
          payload: { action: "accept", content: { cardId: "king-hearts" } },
        },
      ],
    });
    expect(conflict).toMatchObject({ ok: false, code: "RESUME_CONFLICT" });
  });

  it("validates accept.content against the response schema", () => {
    const invalid = verifyResumeEntries({
      threadId,
      scopeId,
      runId: "run-invalid",
      resume: [
        {
          interruptId: "pick-card",
          status: "resolved",
          payload: { action: "accept", content: {} },
        },
      ],
    });
    expect(invalid).toMatchObject({ ok: false, code: "RESUME_PAYLOAD_INVALID" });

    const valid = verifyResumeEntries({
      threadId,
      scopeId,
      runId: "run-valid",
      resume: [
        {
          interruptId: "pick-card",
          status: "resolved",
          payload: { action: "accept", content: { cardId: "ace-spades" } },
        },
      ],
    });
    expect(valid.ok).toBe(true);
  });
});
