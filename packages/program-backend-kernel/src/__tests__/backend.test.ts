import { describe, expect, it } from "vitest";
import { run, type Operation } from "effection";
import { canonicalDigest } from "@sweatpants/foundation";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  type AttachProgramRequest,
  type EffectDescriptor,
  type ProgramRestoreRequest,
} from "@sweatpants/durable-execution";
import type { KernelActivation, KernelBoundary, WorkflowKernel } from "@sweatpants/workflow-kernel";
import { createKernelProgramBackend } from "../index.ts";
import {
  createWorkflowProgramDriver,
  type WorkflowProgramDriverOptions,
} from "@sweatpants/journal-authority";

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
function fixture(effect?: EffectDescriptor, options?: WorkflowProgramDriverOptions) {
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
  const driver = createWorkflowProgramDriver(
    createKernelProgramBackend({
      *manifest() {
        throw Error("Manifest lookup is outside this fixture");
      },
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
      bindOperation() {
        if (effect) {
          return effect;
        }
        return {
          kind: "elicit",
          key: "approval",
          message: "Approve?",
          response: ANY_JSON_SCHEMA_DESCRIPTOR,
        };
      },
    }),
    options,
  );
  return { driver, events };
}

describe("kernel program backend", () => {
  it.each([
    undefined,
    {
      kind: "effect",
      name: "mail.send",
      version: "1",
      input: { to: "recipient", text: "hello" },
      resolver: { audience: "host:mail" },
    } satisfies EffectDescriptor,
  ])(
    "restores a detached operation checkpoint without starting the prefix (%j)",
    async (effect) => {
      const first = fixture(effect);
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
      const second = fixture(effect);
      await run(function* () {
        const result = yield* second.driver.restore({
          attach,
          checkpoint: {
            ...checkpoint,
            resumeAfter: { actionIndex: -1, replayChainDigest: "seed" },
          },
          replay: [],
          replayChainSeed: "seed",
          replayChainDigest: "seed",
          replayedThroughActionIndex: -1,
        });
        expect(result.frontier).toMatchObject({
          type: "operation",
          descriptor: effect ?? { message: "Approve?" },
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
          replayed: true,
        });
        expect(end).toEqual({ type: "completed", actionIndex: 1, value: true });
        yield* second.driver.shutdown(result.attachment, "completed");
      });
      expect(second.events).toEqual(["restore", "resume", "dispose", "close"]);
    },
  );
  it("uses shared effect authorization and never checkpoints an unaccepted attempt", async () => {
    const effect: EffectDescriptor = {
      kind: "effect",
      name: "test.send",
      version: "1",
      input: null,
      resolver: { audience: "program-execution" },
    };
    let attempts = 0;
    const { driver } = fixture(effect, {
      effectHandlers: new Map([
        [
          effect.name,
          function* () {
            attempts++;
            return true;
          },
        ],
      ]),
    });
    await run(function* () {
      const attachment = yield* driver.attach(attach);
      yield* driver.step(attachment, { type: "start", input: null });
      const attempted = yield* driver.step(attachment, {
        type: "authorize",
        actionIndex: 0,
        pullId: "p",
        attemptId: "a",
        resolutionCapability: "capability",
        descriptor: effect,
      });
      expect(attempted).toMatchObject({ authorizedOutcome: { status: "ok", value: true } });
      expect(yield* driver.checkpoint(attachment)).toEqual({ kind: "replay" });
      const outcome = { status: "ok" as const, value: true };
      const end = yield* driver.step(attachment, {
        type: "resume",
        actionIndex: 0,
        outcome,
        replayed: false,
        receipt: {
          sessionId: "s",
          taskId: "t",
          pullId: "p",
          resolutionOffset: "1",
          status: "accepted",
          outcomeDigest: canonicalDigest(outcome),
        },
      });
      expect(end).toEqual({ type: "completed", actionIndex: 1, value: true });
      yield* driver.shutdown(attachment, "completed");
    });
    expect(attempts).toBe(1);
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
      "Checkpoint identity or position differs",
    );
    expect(events).toEqual([]);
  });
});
