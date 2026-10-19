import { createWorkflowProgramDriver } from "../../../packages/journal-authority/dist/index.js";
// Explicit-state JS evaluator implementing the shared kernel interface.
// This is reference evidence, not the Hoot implementation.
import { createPullMachine, createCompiledPullTool } from "./pull-adapter.mjs";
import { hash, copy } from "../compiled-finally/journal.mjs";
import { createKernelProgramBackend } from "../../../packages/program-backend-kernel/dist/index.js";
import {
  assertKernelCompatibility,
  createKernelExecution,
  createWorkflowKernel,
} from "../../../packages/workflow-kernel/dist/index.js";

export const referenceIdentity = {
  kind: "js-reference",
  version: "1",
  programFormat: "compiled-bundle-1",
  snapshotFormat: "explicit-state-1",
};

export function createReferenceKernel(bundle, observe = () => {}) {
  const tool = createCompiledPullTool(bundle);
  const digest = tool.manifest.digest;
  const executions = new Set();
  let closed = false;
  function validate(program, snapshot) {
    if (closed) {
      throw Error("Kernel closed");
    }
    assertKernelCompatibility(referenceIdentity, program, snapshot);
    if (program.digest !== digest || hash(program.code) !== hash(bundle)) {
      throw Error("Program differs");
    }
  }
  function activate(input, snapshot) {
    const machine = createPullMachine(bundle, input, snapshot);
    let disposed = false;
    function check() {
      if (disposed || closed) {
        throw Error("Execution disposed");
      }
    }
    let suspension = 0;
    function boundary() {
      const next = machine.frontier();
      return next.type === "pull"
        ? {
            kind: "suspended",
            suspensionId: String(++suspension),
            request: {
              site: next.descriptor.binding.id,
              binding: JSON.stringify(["elicit", next.descriptor.key]),
              input: { message: next.descriptor.message },
            },
          }
        : next.outcome.kind === "returned"
          ? { kind: "completed", value: next.outcome.value }
          : next.outcome.kind === "thrown"
            ? { kind: "failed", error: next.outcome.value }
            : { kind: "cancelled" };
    }
    const driver = {
      *turn(command) {
        if (command.kind === "cancel") {
          check();
          observe("cancel");
          machine.cancel();
          return boundary();
        }
        const reply = command.reply;
        check();
        if (reply.kind === "value") {
          machine.resume(reply.value);
        } else {
          machine.raise(
            typeof reply.value === "object" && reply.value !== null
              ? reply.value.message
              : reply.value,
          );
        }
        return boundary();
      },
      *capture() {
        check();
        return {
          kernel: referenceIdentity,
          programDigest: digest,
          state: { input: copy(input), machine: machine.capture() },
        };
      },
      *dispose() {
        if (!disposed) {
          disposed = true;
          executions.delete(execution);
          observe("dispose");
        }
      },
    };
    const executionState = createKernelExecution({ initial: boundary(), driver: driver });
    const execution = executionState.execution;
    executions.add(execution);
    return executionState;
  }
  return createWorkflowKernel({
    driver: {
      identity: referenceIdentity,
      *start(program, input) {
        validate(program);
        observe("start");
        return activate(input);
      },
      *restore(program, snapshot) {
        validate(program, snapshot);
        const state = snapshot.state;
        if (!state || typeof state !== "object" || !("input" in state) || !("machine" in state)) {
          throw Error("Invalid reference snapshot");
        }
        observe("restore");
        return activate(state.input, state.machine);
      },
      *close() {
        if (closed) {
          return;
        }
        for (const execution of executions) {
          yield* execution.dispose();
        }
        closed = true;
        observe("close");
      },
    },
  });
}

export function createReferenceWorkflowDriver(bundle, observe = () => {}) {
  const tool = createCompiledPullTool(bundle);
  const driver = createWorkflowProgramDriver(
    createKernelProgramBackend({
      *manifest() {
        return tool.manifest;
      },
      kernelIdentity: referenceIdentity,
      *createKernel() {
        return createReferenceKernel(bundle, observe);
      },
      *loadProgram(digest) {
        if (digest !== tool.manifest.digest) {
          throw Error("Pinned program unavailable");
        }
        return { digest, kernel: referenceIdentity, code: bundle };
      },
      bindOperation({ binding, input, site }) {
        const key = Object.keys(tool.manifest.elicits).find(
          (candidate) => binding === JSON.stringify(["elicit", candidate]),
        );
        if (!key || typeof input?.message !== "string") {
          throw Error("Unknown elicitation contract");
        }
        return {
          kind: "elicit",
          key,
          message: input.message,
          response: tool.manifest.elicits[key].response,
          binding: { id: site },
        };
      },
    }),
  );
  return {
    ...driver,
    *manifest(program) {
      if (
        program.digest !== tool.manifest.digest ||
        program.id !== tool.manifest.programId ||
        program.version !== tool.manifest.version
      ) {
        throw Error("Pinned manifest unavailable");
      }
      return tool.manifest;
    },
  };
}
