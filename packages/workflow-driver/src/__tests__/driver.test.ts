import { describe, expect, it } from "vitest";
import { run, type Operation } from "effection";
import { canonicalDigest } from "@sweatpants/foundation";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  type AttachProgramRequest,
  type ProgramRestoreRequest,
} from "@sweatpants/durable-execution";
import type { KernelActivation, KernelBoundary, WorkflowKernel } from "@sweatpants/workflow-kernel";
import { createWorkflowDriver } from "../index.ts";

const identity = { kind: "fixture", version: "1", programFormat: "1", snapshotFormat: "1" };
const attach: AttachProgramRequest = {
  sessionId: "s",
  taskId: "t",
  program: { id: "approval", version: "1", digest: "digest" },
  input: null,
  route: { driverKind: "workflow" },
  executionEpoch: 1,
};
// Interface double for adapter protocol checks. Real evaluator proofs live in artifact-build.
function fixture() {
  const events: string[] = [];
  const boundary: KernelBoundary = { kind: "effect", site: "approval", request: null };
  function activation(): KernelActivation {
    return {
      boundary,
      execution: {
        *resume(reply) {
          events.push("resume");
          return { kind: "terminal", outcome: { kind: "returned", value: reply.value } };
        },
        *cancel() {
          events.push("cancel");
          return { kind: "terminal", outcome: { kind: "cancelled" } };
        },
        *capture() {
          return { kernel: identity, programDigest: "digest", state: { waiting: true } };
        },
        *dispose() {
          events.push("dispose");
        },
      },
    };
  }
  const driver = createWorkflowDriver({
    driverKind: "workflow",
    kernelIdentity: identity,
    *loadProgram(digest) {
      return { digest, kernel: identity, code: [] };
    },
    *createKernel(): Operation<WorkflowKernel> {
      let closed = false;
      return {
        identity,
        *start() {
          events.push("start");
          return activation();
        },
        *restore() {
          events.push("restore");
          return activation();
        },
        *close() {
          if (!closed) {
            closed = true;
            events.push("close");
          }
        },
      };
    },
    bindElicit() {
      return {
        kind: "elicit",
        key: "approval",
        message: "Approve?",
        response: ANY_JSON_SCHEMA_DESCRIPTOR,
      };
    },
  });
  return { driver, events };
}

describe("workflow driver adapter", () => {
  it("restores a detached checkpoint without starting the prefix", async () => {
    const first = fixture();
    const checkpoint = await run(function* () {
      const attachment = yield* first.driver.attach(attach);
      const step = yield* first.driver.step(attachment, { type: "start", input: null });
      // Mutating caller-owned output must not change the driver's captured frontier.
      if (step.type === "operation" && step.descriptor.kind === "elicit") {
        step.descriptor.message = "edited";
      }
      const saved = yield* first.driver.checkpoint(attachment);
      yield* first.driver.shutdown(attachment, "parked");
      return structuredClone(saved);
    });
    expect(first.events).toEqual(["start", "dispose", "close"]);
    if (checkpoint.kind !== "continuation") {
      throw new Error("Expected continuation");
    }
    const second = fixture();
    await run(function* () {
      const result = yield* second.driver.restore({
        attach,
        checkpoint: { ...checkpoint, resumeAfter: { actionIndex: -1, replayChainDigest: "seed" } },
        replay: [],
        replayChainSeed: "seed",
        replayChainDigest: "seed",
        replayedThroughActionIndex: -1,
      });
      expect(result.frontier).toMatchObject({
        type: "operation",
        descriptor: { message: "Approve?" },
      });
      const outcome = { status: "ok" as const, value: true };
      const end = yield* second.driver.step(result.attachment, {
        type: "resume",
        actionIndex: 0,
        outcome,
        receipt: {
          sessionId: "s",
          taskId: "t",
          pullId: "p",
          resolutionOffset: "1",
          outcomeDigest: canonicalDigest(outcome),
          status: "accepted",
        },
        replayed: false,
      });
      expect(end).toEqual({ type: "completed", actionIndex: 1, value: true });
      yield* second.driver.shutdown(result.attachment, "completed");
    });
    expect(second.events).toEqual(["restore", "resume", "dispose", "close"]);
  });
  it("uses a replay marker after unrecorded cancellation", async () => {
    const { driver, events } = fixture();
    await run(function* () {
      const attachment = yield* driver.attach(attach);
      yield* driver.step(attachment, { type: "start", input: null });
      yield* driver.step(attachment, { type: "cancel" });
      expect(yield* driver.checkpoint(attachment)).toEqual({ kind: "replay" });
      yield* driver.shutdown(attachment, "cancelled");
    });
    expect(events).toEqual(["start", "cancel", "dispose", "close"]);
  });
  it("accepts attachment envelopes that preserve the opaque handle", async () => {
    const { driver, events } = fixture();
    await run(function* () {
      const original = yield* driver.attach(attach);
      const attachment = { ...original };
      yield* driver.step(attachment, { type: "start", input: null });
      yield* driver.shutdown(attachment, "parked");
      yield* driver.shutdown(attachment, "parked");
    });
    expect(events).toEqual(["start", "dispose", "close"]);
  });
  it("rejects an unsupported checkpoint before creating a kernel", async () => {
    const { driver, events } = fixture();
    const request: ProgramRestoreRequest = {
      attach,
      checkpoint: {
        kind: "continuation",
        format: "other",
        programDigest: "digest",
        state: null,
        resumeAfter: { actionIndex: -1, replayChainDigest: "seed" },
      },
      replay: [],
      replayChainSeed: "seed",
      replayChainDigest: "seed",
      replayedThroughActionIndex: -1,
    };
    await expect(run(() => driver.restore(request))).rejects.toThrow(
      "checkpoint identity or position differs",
    );
    expect(events).toEqual([]);
  });
});
