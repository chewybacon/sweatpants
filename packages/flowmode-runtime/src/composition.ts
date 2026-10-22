import type { WorkflowKernel, WorkflowExecutionState, WorkflowExecution } from "./index.ts";
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
    Required<WorkflowExecutionState["execution"]>
  >[];
}

export function createWorkflowKernel({
  driver,
  middleware = [],
  executionMiddleware = [],
}: WorkflowKernelOptions): WorkflowKernel {
  function decorate(state: WorkflowExecutionState): WorkflowExecutionState {
    return {
      boundary: state.boundary,
      execution: composeWorkflowExecution({
        driver: state.execution,
        middleware: executionMiddleware,
      }),
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

/** Decorate an existing live handle without introducing another lifecycle guard. */
export function composeWorkflowExecution({
  driver: execution,
  middleware = [],
}: OperationOptions<WorkflowExecution, Required<WorkflowExecution>>): WorkflowExecution {
  return {
    // CONDITIONAL-SPREAD: Preserve optional inspection without inventing support.
    ...(execution.inspect
      ? {
          inspect: composeOperation(
            () => execution.inspect!(),
            middleware.map((m) => m.inspect),
          ),
        }
      : {}),
    resume: composeOperation(
      (id, reply) => execution.resume(id, reply),
      middleware.map((m) => m.resume),
    ),
    cancel: composeOperation(
      (reason) => execution.cancel(reason),
      middleware.map((m) => m.cancel),
    ),
    dispose: composeOperation(
      () => execution.dispose(),
      middleware.map((m) => m.dispose),
    ),
    capture: composeOperation(
      () => execution.capture(),
      middleware.map((m) => m.capture),
    ),
  };
}
