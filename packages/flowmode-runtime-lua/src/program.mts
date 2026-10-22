import { createLuaKernel, luaIdentity } from "./kernel.mts";
import { createKernelProgram, createKernelProgramBundle } from "@sweatpants/flowmode-backend";
import { createWorkflowRuntime } from "@sweatpants/flowmode-runtime";
import type { DurableProgramManifest } from "@sweatpants/durable-execution";
import type { KernelProgramBackendOptions } from "@sweatpants/flowmode-backend";
import type {
  WorkflowImplementation,
  WorkflowBinding,
  WorkflowRuntimeOptions,
} from "@sweatpants/flowmode-runtime";
import type { LuaInvoker } from "./state.ts";

export interface LuaProgramOptions {
  implementation: WorkflowImplementation;
  contract: Omit<DurableProgramManifest, "digest">;
  bindOperation: KernelProgramBackendOptions["bindOperation"];
  bindings?: readonly WorkflowBinding[];
  runtimeOptions?: Omit<WorkflowRuntimeOptions, "driver">;
}
type RuntimeMiddleware = Pick<WorkflowRuntimeOptions, "kernelMiddleware" | "executionMiddleware">;

export function createLuaProgram(
  {
    implementation,
    contract,
    bindOperation,
    bindings = [],
    runtimeOptions = {},
  }: LuaProgramOptions,
  invoke: LuaInvoker,
) {
  if (
    implementation.format !== luaIdentity.programFormat ||
    typeof implementation.payload !== "string"
  ) {
    throw Error("Incompatible Lua implementation");
  }
  const bundle = createKernelProgramBundle(implementation, luaIdentity, contract, bindings);
  function runtime(options: RuntimeMiddleware = {}) {
    return createWorkflowRuntime({
      ...runtimeOptions,
      kernelMiddleware: [
        ...(runtimeOptions.kernelMiddleware ?? []),
        ...(options.kernelMiddleware ?? []),
      ],
      executionMiddleware: [
        ...(runtimeOptions.executionMiddleware ?? []),
        ...(options.executionMiddleware ?? []),
      ],
      driver: {
        kernelIdentity: luaIdentity,
        *createKernel() {
          return createLuaKernel(invoke);
        },
      },
    });
  }
  return {
    ...bundle,
    createKernel: (options?: RuntimeMiddleware) => runtime(options).createKernel(),
    createDriver(options?: RuntimeMiddleware) {
      return createKernelProgram({
        bundle,
        runtime: runtime(options),
        bindOperation,
      }).createDriver();
    },
  };
}

export function createLuaProgramBundle(
  source: string,
  contract: Omit<DurableProgramManifest, "digest">,
) {
  return createKernelProgramBundle(
    { format: luaIdentity.programFormat, payload: source },
    luaIdentity,
    contract,
  );
}
