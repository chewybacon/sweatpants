import { describe, expect, it } from "vitest";
import { run, scoped, type Operation } from "effection";
import { canonicalDigest } from "@sweatpants/foundation";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  CrankError,
  type AttachProgramRequest,
  type EffectDescriptor,
  type ProgramRestoreRequest,
} from "@sweatpants/durable-execution";
import {
  KernelExecutor,
  createKernelExecution,
  type WorkflowExecutionState,
  type WorkflowBoundary,
  type WorkflowKernel,
} from "@sweatpants/workflow-kernel";
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
function fixture(
  effect?: EffectDescriptor,
  options?: WorkflowProgramDriverOptions,
  startError?: Error,
) {
  const events: string[] = [];
  const boundary: WorkflowBoundary = {
    kind: "suspended",
    suspensionId: "1",
    request: { site: "approval", binding: "approval", input: null },
  };
  function executionState(): WorkflowExecutionState {
    return createKernelExecution(boundary, {
      *turn(command) {
        if (command.kind === "cancel") {
          events.push("cancel");
          return { kind: "cancelled" };
        }
        const reply = command.reply;
        events.push("resume");
        return { kind: "completed", value: reply.value };
      },
      *capture() {
        return { kernel: identity, programDigest: "digest", state: { waiting: true } };
      },
      *dispose() {
        events.push("dispose");
      },
    });
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
            if (startError) {
              throw startError;
            }
            return executionState();
          },
          *restore() {
            events.push("restore");
            return executionState();
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
  it("keeps completed compute available for capture until its container is disposed", async () => {
    const { driver, events } = fixture();
    await run(function* () {
      const attachment = yield* driver.attach(attach);
      yield* driver.step(attachment, { type: "start", input: null });
      const outcome = { status: "ok" as const, value: true };
      const completed = yield* driver.step(attachment, {
        type: "resume",
        actionIndex: 0,
        outcome,
        replayed: true,
        receipt: {
          sessionId: "s",
          taskId: "t",
          pullId: "p",
          resolutionOffset: "1",
          outcomeDigest: canonicalDigest(outcome),
          status: "accepted",
        },
      });
      expect(completed).toEqual({ type: "completed", actionIndex: 1, value: true });
      expect(events).toEqual(["start", "resume"]);
      const checkpoint = yield* driver.checkpoint(attachment);
      expect(checkpoint.kind).toBe("continuation");
      expect(events).toEqual(["start", "resume"]);
      yield* driver.shutdown(attachment, "completed");
      expect(events).toEqual(["start", "resume", "dispose", "close"]);
    });
  });

  it("observes fresh and restored starts through the same scoped executor middleware", async () => {
    const first = fixture();
    const second = fixture();
    const observed: string[] = [];
    await run(function* () {
      yield* KernelExecutor.api.around({
        *start([program, input], next) {
          observed.push(`before:${program.digest}`);
          const executionState = yield* next(program, input);
          observed.push(`after:${executionState.boundary.kind}`);
          return executionState;
        },
      });
      const checkpoint = yield* scoped(function* () {
        const attachment = yield* first.driver.attach(attach);
        yield* first.driver.step(attachment, { type: "start", input: null });
        const saved = yield* first.driver.checkpoint(attachment);
        yield* first.driver.shutdown(attachment, "parked");
        return saved;
      });
      if (checkpoint.kind !== "continuation") {
        throw Error("Expected continuation");
      }
      yield* scoped(function* () {
        const restored = yield* second.driver.restore({
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
        expect(restored.frontier).toMatchObject({ type: "operation", actionIndex: 0 });
        yield* second.driver.shutdown(restored.attachment, "parked");
      });
    });
    expect(observed).toEqual([
      "before:digest",
      "after:suspended",
      "before:digest",
      "after:suspended",
    ]);
    expect(first.events).toEqual(["start", "dispose", "close"]);
    expect(second.events).toEqual(["restore", "dispose", "close"]);
  });

  it("keeps restored startup scoped while a fresh sibling starts normally", async () => {
    const first = fixture();
    const checkpoint = await run(function* () {
      const attachment = yield* first.driver.attach(attach);
      yield* first.driver.step(attachment, { type: "start", input: null });
      const saved = yield* first.driver.checkpoint(attachment);
      yield* first.driver.shutdown(attachment, "parked");
      return saved;
    });
    if (checkpoint.kind !== "continuation") {
      throw Error("Expected continuation");
    }
    const restoring = fixture();
    const fresh = fixture();
    await run(function* () {
      const restored = yield* restoring.driver.restore({
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
      const attachment = yield* fresh.driver.attach({ ...attach, taskId: "sibling" });
      const next = yield* fresh.driver.step(attachment, { type: "start", input: null });
      expect(next).toMatchObject({ type: "operation", actionIndex: 0 });
      expect(restoring.events).toEqual(["restore"]);
      expect(fresh.events).toEqual(["start"]);
      yield* fresh.driver.shutdown(attachment, "parked");
      yield* restoring.driver.shutdown(restored.attachment, "parked");
    });
    expect(restoring.events).toEqual(["restore", "dispose", "close"]);
    expect(fresh.events).toEqual(["start", "dispose", "close"]);
  });

  it("preserves a failed start frontier without capturing unavailable computation", async () => {
    const { driver } = fixture(
      undefined,
      undefined,
      new CrankError("workflow_failed", "Unknown caller form: missing"),
    );
    await run(function* () {
      const attachment = yield* driver.attach(attach);
      const boundary = yield* driver.step(attachment, { type: "start", input: null });
      expect(boundary.type).toBe("failed");
      expect(JSON.stringify(boundary)).toContain("Unknown caller form: missing");
      expect(yield* driver.checkpoint(attachment)).toEqual({ kind: "replay" });
      yield* driver.shutdown(attachment, "failed");
    });
  });
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
