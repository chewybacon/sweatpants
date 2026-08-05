import { run } from "effection";
import { describe, expect, it } from "vitest";
import { createInMemoryBufferStore } from "@sweatpants/durable-streams";
import {
  registerInterruptsFromRunFinished,
  resetInterruptRegistry,
  scopeIdForInterruptRun,
  upsertInterruptRecords,
  verifyResumeEntries,
} from "../registry.ts";
import { readLatestThreadInterruptState, recordThreadInterruptState } from "../store.ts";

const threadId = "thread-interrupt-durability";
const interruptedRunId = "run-interrupt-durability";
const scopeId = scopeIdForInterruptRun(threadId, interruptedRunId);

function registerInterrupt(): void {
  registerInterruptsFromRunFinished({
    type: "RUN_FINISHED",
    threadId,
    runId: interruptedRunId,
    outcome: {
      type: "interrupt",
      interrupts: [
        {
          id: "choose-option",
          reason: "input_required",
          responseSchema: {
            type: "object",
            required: ["selected"],
            properties: { selected: { type: "string" } },
          },
        },
      ],
    },
  });
}

describe("durable interrupt state", () => {
  it("restores a settled single elicit and rejects a conflicting stale response", async () => {
    const store = createInMemoryBufferStore<string>();

    await run(function* () {
      resetInterruptRegistry();
      registerInterrupt();
      const accepted = verifyResumeEntries({
        threadId,
        scopeId,
        runId: "run-settlement",
        resume: [
          {
            interruptId: "choose-option",
            status: "resolved",
            payload: { action: "accept", content: { selected: "alpha" } },
          },
        ],
      });
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) {
        throw new Error(accepted.message);
      }
      upsertInterruptRecords(accepted.records);

      yield* recordThreadInterruptState(store, threadId, accepted.records);
      resetInterruptRegistry();

      const restored = yield* readLatestThreadInterruptState(store, threadId);
      expect(restored).toHaveLength(1);
      expect(restored?.[0]).toMatchObject({
        interruptId: "choose-option",
        status: "resolved",
        resolutionHash: expect.any(String),
      });
      upsertInterruptRecords(restored ?? []);

      const stale = verifyResumeEntries({
        threadId,
        scopeId,
        runId: "run-stale-client",
        resume: [
          {
            interruptId: "choose-option",
            status: "resolved",
            payload: { action: "accept", content: { selected: "beta" } },
          },
        ],
      });
      expect(stale).toMatchObject({ ok: false, code: "RESUME_CONFLICT" });
    });
  });
});
