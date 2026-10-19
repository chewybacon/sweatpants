import type { WorkflowKernel } from "./index.ts";
import { composeOperation, type OperationOptions } from "@sweatpants/foundation";
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
export type WorkflowRuntimeOptions = OperationOptions<
  WorkflowRuntime,
  Pick<WorkflowRuntime, "createKernel">
>;

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
}: WorkflowRuntimeOptions): WorkflowRuntime {
  return {
    kernelIdentity: driver.kernelIdentity,
    createKernel: composeOperation(
      () => driver.createKernel(),
      middleware.map((m) => m.createKernel),
    ),
  };
}

export type WorkflowKernelOptions = OperationOptions<
  WorkflowKernel,
  Pick<WorkflowKernel, "start" | "restore" | "close">
>;

export function createWorkflowKernel({
  driver,
  middleware = [],
}: WorkflowKernelOptions): WorkflowKernel {
  return {
    identity: driver.identity,
    start: composeOperation(
      (program, input) => driver.start(program, input),
      middleware.map((m) => m.start),
    ),
    restore: composeOperation(
      (program, snapshot) => driver.restore(program, snapshot),
      middleware.map((m) => m.restore),
    ),
    close: composeOperation(
      () => driver.close(),
      middleware.map((m) => m.close),
    ),
  };
}
