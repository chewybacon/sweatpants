import { beforeEach, describe, expect, it } from "vitest";

import {
  registerInterruptsFromRunFinished,
  resetInterruptRegistry,
  scopeIdForInterruptRun,
  validateResumeEntries,
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
      const result = validateResumeEntries({
        threadId,
        scopeId,
        runId: `run-${action}`,
        resume: [{ interruptId: "pick-card", status: "resolved", payload: { action } }],
      });

      expect(result.ok).toBe(true);
    },
  );

  it("validates accept.content against the response schema", () => {
    const invalid = validateResumeEntries({
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

    const valid = validateResumeEntries({
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
