import type { DurableProgramManifest } from "@sweatpants/durable-execution";
import type { KernelProgramBackendOptions } from "@sweatpants/flowmode-backend";
import type {
  WorkflowBinding,
  WorkflowRuntimeOptions,
  KernelIdentity,
  WorkflowBoundary,
  WorkflowProgram,
  KernelSnapshot,
  WorkflowExecutionDriver,
} from "@sweatpants/flowmode-runtime";
import type { HootMachine, HootBoundary } from "./machine-api.mts";
import { decodeExchange } from "@sweatpants/flowmode-runtime";
import { HOOT_PROGRAM_FORMAT } from "./linker.mts";
import { createKernelProgram, createKernelProgramBundle } from "@sweatpants/flowmode-backend";
import {
  assertKernelCompatibility,
  createKernelExecution,
  createWorkflowKernel,
  createWorkflowRuntime,
} from "@sweatpants/flowmode-runtime";
import { CrankError } from "@sweatpants/durable-execution";
import { call } from "effection";

export interface HootProgramOptions {
  source: string;
  contract: Omit<DurableProgramManifest, "digest">;
  bindOperation: KernelProgramBackendOptions["bindOperation"];
  bindings?: readonly WorkflowBinding[];
  runtimeOptions?: Omit<WorkflowRuntimeOptions, "driver">;
}
export interface HootKernelDependencies {
  loadMachine: () => Promise<HootMachine>;
  identity: KernelIdentity;
}
export type HootObserver = (event: string, data?: Record<string, unknown>) => void;

function kernel(
  observe: HootObserver,
  source: string,
  digest: string,
  loadMachine: HootKernelDependencies["loadMachine"],
  identity: KernelIdentity,
) {
  let machine: HootMachine | null = null;
  let closed = false;
  function check() {
    if (!machine || closed) {
      throw Error("Hoot instance disposed");
    }
    return machine;
  }
  let suspension = 0;
  function boundary(step: HootBoundary): WorkflowBoundary {
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
  function transition(event: string, action: () => HootBoundary): WorkflowBoundary {
    const started = performance.now();
    let result;
    try {
      result = boundary(action());
    } catch (error) {
      throw new CrankError(
        "workflow_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    observe(event, {
      boundary: result,
      inspection: check().inspect(result),
      durationMs: performance.now() - started,
    });
    return result;
  }
  const driver: WorkflowExecutionDriver = {
    *turn(command) {
      if (command.kind === "cancel") {
        check();
        return transition("cancel", () => check().cancel());
      }
      const reply = command.reply;
      check();
      observe("reply", { reply });
      return transition("resume", () =>
        reply.kind === "throw" ? check().reject(reply.value) : check().resume(reply.value),
      );
    },
    *capture() {
      check();
      const state = check().capture();
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
  function validate(program: WorkflowProgram, snapshot?: KernelSnapshot) {
    if (closed || machine) {
      throw Error("Kernel already used");
    }
    assertKernelCompatibility(identity, program, snapshot);
    if (program.digest !== digest || program.code !== source) {
      throw Error("Wrong program");
    }
  }
  return createWorkflowKernel({
    driver: {
      identity,
      *start(program, input) {
        validate(program);
        machine = yield* call(loadMachine);
        return createKernelExecution({
          initial: transition("start", () => check().start(source, input)),
          driver: driver,
        });
      },
      *restore(program, snapshot) {
        validate(program, snapshot);
        if (typeof snapshot.state !== "string") {
          throw Error("Invalid snapshot");
        }
        const state = snapshot.state;
        observe("checkpoint-selected", { snapshot });
        machine = yield* call(loadMachine);
        return createKernelExecution({
          initial: transition("restore", () => check().restore(source, state)),
          driver: driver,
        });
      },
      *close() {
        yield* driver.dispose();
        closed = true;
      },
    },
  });
}
export function createPortableHootProgram(
  { source, contract, bindOperation, bindings = [], runtimeOptions = {} }: HootProgramOptions,
  { loadMachine, identity }: HootKernelDependencies,
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
  function runtime(observe: HootObserver = () => {}) {
    return createWorkflowRuntime({
      ...runtimeOptions,
      driver: {
        kernelIdentity: identity,
        *createKernel() {
          return kernel(observe, source, bundle.artifact.digest, loadMachine, identity);
        },
      },
    });
  }
  return {
    ...bundle,
    createKernel: (observe?: HootObserver) => runtime(observe).createKernel(),
    createDriver(observe?: HootObserver) {
      return createKernelProgram({
        bundle,
        runtime: runtime(observe),
        bindOperation,
      }).createDriver();
    },
  };
}
