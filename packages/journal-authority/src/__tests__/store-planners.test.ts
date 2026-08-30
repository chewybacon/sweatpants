import { DurableCollections, durableKey } from "@sweatpants/durable-storage-kernel";
import { describe, expect, it } from "vitest";
import { encodeExecutionControl } from "../store/store-persistence.ts";
import { planExecutionCommit } from "../store/store-planners.ts";

const control = {
  executionId: "execution",
  controlRevision: "4",
  ownerFence: "7",
  status: "active" as const,
  rootTaskId: "root",
  stopGeneration: "0",
  requestedDisposition: null,
  control: { state: "active" },
  updatedAt: 1,
};

const currentRecord = {
  collection: DurableCollections.executionControls,
  key: durableKey("execution"),
  revision: control.controlRevision,
  fence: control.ownerFence,
  value: encodeExecutionControl(control),
} as const;

describe("execution storage planner", () => {
  it("rejects a stale fence before a stale revision", () => {
    expect(
      planExecutionCommit({
        currentRecord,
        request: {
          executionId: "execution",
          expectedControlRevision: "2",
          expectedOwnerFence: "6",
          nextControl: { ...control, ownerFence: "8" },
          updatedAt: 2,
        },
      }),
    ).toMatchObject({ kind: "complete", result: { status: "stale_owner" } });
  });

  it("plans side records and exactly one fenced authority replacement", () => {
    const decision = planExecutionCommit({
      currentRecord,
      request: {
        executionId: "execution",
        expectedControlRevision: "4",
        expectedOwnerFence: "7",
        nextControl: {
          executionId: "execution",
          ownerFence: "8",
          status: "parked",
          rootTaskId: "root",
          stopGeneration: "0",
          requestedDisposition: null,
          control: { state: "parked" },
        },
        updatedAt: 2,
      },
    });
    expect(decision).toMatchObject({
      kind: "apply",
      mutation: {
        ensures: [],
        authority: {
          expected: { revision: "4", fence: "7" },
          next: { revision: "5", fence: "8" },
        },
      },
    });
  });
});
