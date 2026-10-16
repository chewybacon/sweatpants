import { call } from "effection";
import { assertJson, canonicalDigest, type Json } from "@sweatpants/foundation";
import {
  CrankError,
  programRouteDriverKind,
  replayProgramRecovery,
  verifyProgramReplayEntry,
  assertProgramReplayFrontier,
  type AttachProgramRequest,
  type DurableElicitDescriptor,
  type ProgramAttachment,
  type ProgramDriver,
  type ProgramStep,
} from "@sweatpants/durable-execution";
import {
  assertKernelCompatibility,
  type KernelActivation,
  type WorkflowKernel,
  type WorkflowProgram,
} from "@sweatpants/workflow-kernel";
import { prepareWorkflow, type WorkflowDriverDependencies } from "./prepare.ts";

const checkpointFormat = "sweatpants.workflow-driver.elicit.v1";

/** First integration slice: kernels yield typed elicitation requests only. */
export interface WorkflowDriverOptions extends WorkflowDriverDependencies {
  readonly driverKind: string;
  /** Validates and binds a kernel request to an installed elicitation contract. */
  readonly bindElicit: (request: Json, site: string) => DurableElicitDescriptor;
}

/** One activation's compute. Never placed in the durable checkpoint. */
interface Handle {
  readonly request: AttachProgramRequest;
  readonly prepared: PreparedWorkflow;
  activation?: KernelActivation;
  step?: ProgramStep;
  index: number;
  disposed: boolean;
  checkpointable: boolean;
}
type PreparedWorkflow = {
  kernel: WorkflowKernel;
  program: WorkflowProgram;
};

/** Optional adapter. Effect acceptance and checkpoint provenance remain host responsibilities. */
export function createWorkflowDriver(options: WorkflowDriverOptions): ProgramDriver {
  const handles = new WeakMap<object, Handle>();
  function findHandle(attachment: ProgramAttachment): Handle | undefined {
    const token = attachment.handle;
    return token !== null && typeof token === "object" ? handles.get(token) : undefined;
  }
  function handleFor(attachment: ProgramAttachment): Handle {
    const handle = findHandle(attachment);
    if (!handle || handle.disposed) {
      throw new CrankError("program_protocol_error", "Workflow attachment is unavailable");
    }
    return handle;
  }
  function view(handle: Handle): ProgramStep {
    const boundary = handle.activation?.boundary;
    if (!boundary) {
      throw new CrankError("program_protocol_error", "Workflow has not started");
    }
    if (boundary.kind === "effect") {
      return {
        type: "operation",
        actionIndex: handle.index,
        descriptor: options.bindElicit(boundary.request, boundary.site),
      };
    }
    const outcome = boundary.outcome;
    if (outcome.kind === "returned") {
      return { type: "completed", actionIndex: handle.index, value: assertJson(outcome.value) };
    }
    return {
      type: "failed",
      actionIndex: handle.index,
      error: {
        code: outcome.kind === "cancelled" ? "program_cancelled" : "workflow_failed",
        message:
          outcome.kind === "cancelled" ? "Workflow cancelled" : JSON.stringify(outcome.value),
      },
    };
  }
  function identity(request: AttachProgramRequest): string {
    return canonicalDigest({
      sessionId: request.sessionId,
      taskId: request.taskId,
      program: request.program,
      input: request.input,
    });
  }
  return {
    evaluatorKind: "program",
    capabilities: {
      replay: { kind: "replay", version: 1 },
      continuation: { kind: "continuation", version: "1", format: checkpointFormat },
    },
    *attach(request) {
      if (programRouteDriverKind(request.route) !== options.driverKind) {
        throw new CrankError("program_protocol_error", "Workflow route uses a different driver");
      }
      const prepared = yield* prepareWorkflow(options, request.program.digest);
      const token = {};
      const attachment: ProgramAttachment = {
        attachmentId: crypto.randomUUID(),
        taskId: request.taskId,
        driverKind: options.driverKind,
        route: request.route,
        executionEpoch: request.executionEpoch,
        handle: token,
      };
      handles.set(token, {
        request: structuredClone(request),
        prepared,
        index: 0,
        disposed: false,
        checkpointable: true,
      });
      return attachment;
    },
    *step(attachment, command) {
      const handle = handleFor(attachment);
      if (command.type === "start") {
        if (
          handle.activation ||
          canonicalDigest(command.input) !== canonicalDigest(handle.request.input)
        ) {
          throw new CrankError("program_protocol_error", "Invalid workflow start");
        }
        handle.activation = yield* handle.prepared.kernel.start(
          handle.prepared.program,
          handle.request.input,
        );
      } else if (command.type === "resume") {
        if (
          !handle.activation ||
          handle.step?.type !== "operation" ||
          command.actionIndex !== handle.index
        ) {
          throw new CrankError("program_protocol_error", "Workflow resume is out of order");
        }
        const receipt = command.receipt;
        if (
          receipt.sessionId !== handle.request.sessionId ||
          receipt.taskId !== handle.request.taskId ||
          !receipt.pullId ||
          !receipt.resolutionOffset ||
          // Runtime boundary: callers may supply values that violate the static union.
          // oxlint-disable-next-line typescript/no-unnecessary-condition
          (receipt.status !== "accepted" && receipt.status !== "duplicate") ||
          receipt.outcomeDigest !== canonicalDigest(command.outcome)
        ) {
          throw new CrankError(
            "program_protocol_error",
            "Workflow resume requires an accepted outcome receipt",
          );
        }
        const outcome = command.outcome;
        const execution = handle.activation.execution;
        let boundary;
        if (outcome.status === "ok") {
          boundary = yield* execution.resume({ kind: "value", value: outcome.value });
        } else if (outcome.status === "error") {
          boundary = yield* execution.resume({ kind: "throw", value: assertJson(outcome.error) });
        }
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- Reject invalid runtime outcomes explicitly.
        else if (outcome.status === "cancelled") {
          boundary = yield* execution.cancel();
        } else {
          throw new CrankError("program_protocol_error", "Unsupported elicitation outcome");
        }
        handle.activation = { execution, boundary };
        handle.index++;
      } else if (command.type === "cancel") {
        handle.checkpointable = false;
        if (!handle.activation) {
          throw new CrankError("program_protocol_error", "Workflow has not started");
        }
        const boundary = yield* handle.activation.execution.cancel();
        handle.activation = { execution: handle.activation.execution, boundary };
      } else {
        throw new CrankError("program_protocol_error", "Workflow spike supports elicitation only");
      }
      handle.step = view(handle);
      return structuredClone(handle.step);
    },
    *checkpoint(attachment) {
      const handle = handleFor(attachment);
      if (!handle.activation || !handle.step) {
        throw new CrankError("program_protocol_error", "Workflow has not started");
      }
      if (!handle.checkpointable) {
        return { kind: "replay" };
      }
      const snapshot = yield* handle.activation.execution.capture();
      assertKernelCompatibility(options.kernelIdentity, handle.prepared.program, snapshot);
      return {
        kind: "continuation",
        format: checkpointFormat,
        programDigest: handle.request.program.digest,
        state: assertJson({
          identity: identity(handle.request),
          index: handle.index,
          snapshot,
          frontierDigest: canonicalDigest(handle.step),
        }),
      };
    },
    *restore(request) {
      if (request.checkpoint.kind === "replay") {
        return yield* replayProgramRecovery.restore.call(this, request);
      }
      const checkpoint = request.checkpoint;
      const state = checkpoint.state;
      if (
        checkpoint.format !== checkpointFormat ||
        checkpoint.programDigest !== request.attach.program.digest ||
        !state ||
        typeof state !== "object" ||
        Array.isArray(state) ||
        state.identity !== identity(request.attach) ||
        typeof state.index !== "number" ||
        !Number.isSafeInteger(state.index) ||
        state.index < 0 ||
        state.index !== checkpoint.resumeAfter.actionIndex + 1 ||
        typeof state.frontierDigest !== "string"
      ) {
        throw new CrankError(
          "program_protocol_error",
          "Workflow checkpoint identity or position differs",
        );
      }
      const saved = state.snapshot;
      if (
        !saved ||
        typeof saved !== "object" ||
        Array.isArray(saved) ||
        saved.programDigest !== request.attach.program.digest ||
        canonicalDigest(saved.kernel ?? null) !== canonicalDigest(options.kernelIdentity) ||
        !("state" in saved)
      ) {
        throw new CrankError("program_protocol_error", "Workflow kernel snapshot differs");
      }
      const attachment = yield* this.attach(request.attach);
      let success = false;
      try {
        const handle = handleFor(attachment);
        handle.index = state.index;
        handle.activation = yield* handle.prepared.kernel.restore(handle.prepared.program, {
          kernel: options.kernelIdentity,
          programDigest: request.attach.program.digest,
          state: saved.state,
        });
        let frontier = view(handle);
        handle.step = structuredClone(frontier);
        if (canonicalDigest(frontier) !== state.frontierDigest) {
          throw new CrankError("replay_diverged", "Restored workflow frontier differs");
        }
        let previous = checkpoint.resumeAfter.replayChainDigest;
        let through = checkpoint.resumeAfter.actionIndex;
        const iterator =
          request.replay[Symbol.iterator]?.() ?? request.replay[Symbol.asyncIterator]?.();
        if (!iterator) {
          throw new CrankError("invalid_descriptor", "Replay source has no iterator");
        }
        let exhausted = false;
        try {
          for (;;) {
            const next = yield* call(async () => await iterator.next());
            if (next.done) {
              exhausted = true;
              break;
            }
            const entry = next.value;
            verifyProgramReplayEntry(request.replayChainSeed, entry, previous);
            assertProgramReplayFrontier(frontier, entry);
            if (entry.type !== "operation") {
              throw new CrankError(
                "program_protocol_error",
                "Workflow spike cannot replay emissions",
              );
            }
            frontier = yield* this.step(attachment, {
              type: "resume",
              actionIndex: entry.actionIndex,
              outcome: entry.outcome,
              receipt: entry.receipt,
              replayed: true,
            });
            previous = entry.entryDigest;
            through = entry.actionIndex;
          }
        } finally {
          if (!exhausted && iterator.return) {
            yield* call(async () => await iterator.return!());
          }
        }
        if (
          through !== request.replayedThroughActionIndex ||
          previous !== request.replayChainDigest
        ) {
          throw new CrankError(
            "replay_diverged",
            "Workflow recovery did not reach the requested journal position",
          );
        }
        const frontierDigest = canonicalDigest(frontier);
        success = true;
        return {
          attachment,
          frontier,
          frontierDigest,
          replayedThroughActionIndex: through,
          replayChainDigest: previous,
        };
      } finally {
        if (!success) {
          yield* this.shutdown(attachment, "failed");
        }
      }
    },
    *shutdown(attachment) {
      const handle = findHandle(attachment);
      if (!handle || handle.disposed) {
        return;
      }
      handle.disposed = true;
      try {
        if (handle.activation) {
          yield* handle.activation.execution.dispose();
        }
      } finally {
        yield* handle.prepared.kernel.close();
      }
    },
  };
}
