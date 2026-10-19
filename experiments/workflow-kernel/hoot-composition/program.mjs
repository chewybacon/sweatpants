import { decodeExchange } from "../exchange-codec.mts";
import { HOOT_PROGRAM_FORMAT } from "./linker.mts";
import {
  createKernelProgramBackend,
  createKernelProgramBundle,
  loadKernelProgram,
} from "../../../packages/program-backend-kernel/dist/index.js";
import {
  assertKernelCompatibility,
  createKernelExecution,
} from "../../../packages/workflow-kernel/dist/index.js";
import { CrankError } from "../../../packages/durable-execution/dist/index.js";
import { createWorkflowProgramDriver } from "../../../packages/journal-authority/dist/index.js";
import { call } from "effection";
function kernel(observe, source, digest, loadMachine, identity) {
  let machine = null,
    closed = false;
  function check() {
    if (!machine || closed) {
      throw Error("Hoot instance disposed");
    }
  }
  let suspension = 0;
  function boundary(step) {
    if (step.kind === "effect") {
      return {
        kind: "suspended",
        suspensionId: String(++suspension),
        request: decodeExchange(step.site, step.value),
      };
    }
    if (step.kind === "returned" || step.kind === "thrown") {
      return step.kind === "returned"
        ? { kind: "completed", value: step.value }
        : { kind: "failed", error: step.value };
    }
    if (step.kind === "cancelled") {
      return { kind: "cancelled" };
    }
    throw Error("Unknown Hoot boundary");
  }
  function transition(event, action) {
    const started = performance.now();
    let result;
    try {
      result = boundary(action());
    } catch (error) {
      throw new CrankError("workflow_failed", error.message);
    }
    observe(event, {
      boundary: result,
      inspection: machine.inspect(result),
      durationMs: performance.now() - started,
    });
    return result;
  }
  const driver = {
    *turn(command) {
      if (command.kind === "cancel") {
        check();
        return transition("cancel", () => machine.cancel());
      }
      const reply = command.reply;
      check();
      observe("reply", { reply });
      return transition("resume", () =>
        reply.kind === "throw" ? machine.reject(reply.value) : machine.resume(reply.value),
      );
    },
    *capture() {
      check();
      const state = machine.capture();
      observe("capture", { bytes: new TextEncoder().encode(state).length });
      return { kernel: identity, programDigest: digest, state };
    },
    *dispose() {
      if (machine) {
        machine = null;
        observe("dispose");
      }
    },
  };
  function validate(program, snapshot) {
    if (closed || machine) {
      throw Error("Kernel already used");
    }
    assertKernelCompatibility(identity, program, snapshot);
    if (program.digest !== digest || program.code !== source) {
      throw Error("Wrong program");
    }
  }
  return {
    identity,
    *start(program, input) {
      validate(program);
      machine = yield* call(loadMachine);
      return createKernelExecution(
        transition("start", () => machine.start(source, input)),
        driver,
      );
    },
    *restore(program, snapshot) {
      validate(program, snapshot);
      if (typeof snapshot.state !== "string") {
        throw Error("Invalid snapshot");
      }
      observe("checkpoint-selected", { snapshot });
      machine = yield* call(loadMachine);
      return createKernelExecution(
        transition("restore", () => machine.restore(source, snapshot.state)),
        driver,
      );
    },
    *close() {
      yield* driver.dispose();
      closed = true;
    },
  };
}
export function createPortableHootProgram(
  { source, contract, bindOperation, bindings = [] },
  { loadMachine, identity },
) {
  if (identity.programFormat !== HOOT_PROGRAM_FORMAT) {
    throw Error("Incompatible Hoot program format");
  }
  const bundle = createKernelProgramBundle(
    { format: identity.programFormat, payload: source },
    identity,
    contract,
    bindings,
  );
  const { manifest, artifact } = bundle;
  const digest = artifact.digest;
  return {
    manifest,
    artifact,
    createKernel(observe = () => {}) {
      return kernel(observe, source, digest, loadMachine, identity);
    },
    createDriver(observe = () => {}) {
      const driver = createWorkflowProgramDriver(
        createKernelProgramBackend({
          *manifest(program) {
            if (program.digest !== digest) {
              throw Error("Manifest unavailable");
            }
            loadKernelProgram(bundle, program.digest);
            return structuredClone(manifest);
          },
          kernelIdentity: identity,
          *createKernel() {
            return kernel(observe, source, digest, loadMachine, identity);
          },
          *loadProgram(requested) {
            if (requested !== digest) {
              throw Error("Program unavailable");
            }
            return loadKernelProgram(bundle, requested);
          },
          bindOperation,
        }),
      );
      return driver;
    },
  };
}
