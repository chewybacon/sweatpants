import { describe, expect, it } from "vitest";

import type { DurableSemanticRecord } from "../durable-authority.ts";
import { normalizeSemanticJournal } from "../testing/semantic-journal-normalizer.ts";

const baseline: DurableSemanticRecord[] = [
  {
    offset: "7",
    eventId: "backend-event",
    sessionId: "session",
    ownerEpoch: 4,
    payload: {
      type: "TaskClosed",
      taskId: "task",
      outcome: { status: "ok", value: "result" },
    },
  },
];

describe("semantic journal normalizer", () => {
  it("removes only permitted backend and activation coordination fields", () => {
    const runtimeOnlyMutation = structuredClone(baseline);
    runtimeOnlyMutation[0]!.offset = "99";
    runtimeOnlyMutation[0]!.eventId = "other-backend-event";
    runtimeOnlyMutation[0]!.ownerEpoch = 88;
    expect(normalizeSemanticJournal(runtimeOnlyMutation)).toEqual(
      normalizeSemanticJournal(baseline),
    );
  });

  it("retains semantic order, record type, task identity, and canonical outcome", () => {
    const outcomeMutation = structuredClone(baseline);
    outcomeMutation[0]!.payload = {
      type: "TaskClosed",
      taskId: "task",
      outcome: { status: "ok", value: "different" },
    };
    expect(normalizeSemanticJournal(outcomeMutation)).not.toEqual(
      normalizeSemanticJournal(baseline),
    );

    const taskMutation = structuredClone(baseline);
    taskMutation[0]!.payload = {
      type: "TaskClosed",
      taskId: "other-task",
      outcome: { status: "ok", value: "result" },
    };
    expect(normalizeSemanticJournal(taskMutation)).not.toEqual(normalizeSemanticJournal(baseline));
  });
});
