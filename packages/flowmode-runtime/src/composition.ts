import type { WorkflowKernel, WorkflowExecutionState } from "./index.ts";
import {
  composeOperation,
  type OperationMiddleware,
  type OperationOptions,
} from "@sweatpants/foundation";
import type {
  WorkflowCompiler,
  WorkflowLinker,
  WorkflowAuthoring,
  WorkflowRuntime,
} from "./authoring.ts";

export type WorkflowCompilerOptions = OperationOptions<
  WorkflowCompiler,
  Pick<WorkflowCompiler, "compile">
>;
export type WorkflowLinkerOptions = OperationOptions<WorkflowLinker, Pick<WorkflowLinker, "link">>;
export type WorkflowAuthoringOptions = OperationOptions<
  WorkflowAuthoring,
  Pick<WorkflowAuthoring, "describe">
>;
export interface WorkflowRuntimeOptions extends OperationOptions<
  WorkflowRuntime,
  Pick<WorkflowRuntime, "createKernel">
> {
  readonly kernelMiddleware?: WorkflowKernelOptions["middleware"];
  readonly executionMiddleware?: WorkflowKernelOptions["executionMiddleware"];
}

export function createWorkflowCompiler({
  driver,
  middleware = [],
}: WorkflowCompilerOptions): WorkflowCompiler {
  return {
    sourceLanguage: driver.sourceLanguage,
    definitionFormat: driver.definitionFormat,
    compile: composeOperation(
      (request) => driver.compile(request),
      middleware.map((m) => m.compile),
    ),
  };
}

export function createWorkflowLinker({
  driver,
  middleware = [],
}: WorkflowLinkerOptions): WorkflowLinker {
  return {
    definitionFormat: driver.definitionFormat,
    programFormat: driver.programFormat,
    link: composeOperation(
      (request) => driver.link(request),
      middleware.map((m) => m.link),
    ),
  };
}

export function createWorkflowAuthoring({
  driver,
  middleware = [],
}: WorkflowAuthoringOptions): WorkflowAuthoring {
  return {
    sourceLanguage: driver.sourceLanguage,
    describe: composeOperation(
      (request) => driver.describe(request),
      middleware.map((m) => m.describe),
    ),
  };
}

export function createWorkflowRuntime({
  driver,
  middleware = [],
  kernelMiddleware = [],
  executionMiddleware = [],
}: WorkflowRuntimeOptions): WorkflowRuntime {
  return {
    kernelIdentity: driver.kernelIdentity,
    createKernel: composeOperation(
      function* () {
        return createWorkflowKernel({
          driver: yield* driver.createKernel(),
          middleware: kernelMiddleware,
          executionMiddleware,
        });
      },
      middleware.map((m) => m.createKernel),
    ),
  };
}

export interface WorkflowKernelOptions extends OperationOptions<
  WorkflowKernel,
  Pick<WorkflowKernel, "start" | "restore" | "close">
> {
  readonly executionMiddleware?: readonly OperationMiddleware<
    WorkflowExecutionState["execution"]
  >[];
}

export function createWorkflowKernel({
  driver,
  middleware = [],
  executionMiddleware = [],
}: WorkflowKernelOptions): WorkflowKernel {
  function decorate(state: WorkflowExecutionState): WorkflowExecutionState {
    const execution = state.execution;
    return {
      boundary: state.boundary,
      // Decorate the existing live handle; do not create a second lifecycle guard.
      execution: {
        resume: composeOperation(
          (id, reply) => execution.resume(id, reply),
          executionMiddleware.map((m) => m.resume),
        ),
        cancel: composeOperation(
          (reason) => execution.cancel(reason),
          executionMiddleware.map((m) => m.cancel),
        ),
        dispose: composeOperation(
          () => execution.dispose(),
          executionMiddleware.map((m) => m.dispose),
        ),
        capture: composeOperation(
          () => execution.capture(),
          executionMiddleware.map((m) => m.capture),
        ),
      },
    };
  }
  return {
    identity: driver.identity,
    start: composeOperation(
      function* (program, input) {
        return decorate(yield* driver.start(program, input));
      },
      middleware.map((m) => m.start),
    ),
    restore: composeOperation(
      function* (program, snapshot) {
        return decorate(yield* driver.restore(program, snapshot));
      },
      middleware.map((m) => m.restore),
    ),
    close: composeOperation(
      () => driver.close(),
      middleware.map((m) => m.close),
    ),
  };
}
