// @ts-check
import { createLuaKernel, luaIdentity } from "./kernel.mts";
import { createKernelProgram, createKernelProgramBundle } from "@sweatpants/flowmode-backend";
import { createWorkflowRuntime } from "@sweatpants/flowmode-runtime";

/** @param {{ implementation: import("@sweatpants/flowmode-runtime").WorkflowImplementation, contract: Omit<import("@sweatpants/durable-execution").DurableProgramManifest, "digest">, bindOperation: import("@sweatpants/flowmode-backend").KernelProgramBackendOptions["bindOperation"], bindings?: readonly import("@sweatpants/flowmode-runtime").WorkflowBinding[], runtimeOptions?: Omit<import("@sweatpants/flowmode-runtime").WorkflowRuntimeOptions, "driver"> }} options
 * @param {import("./state.ts").LuaInvoker} invoke
 */
export function createLuaProgram(
  { implementation, contract, bindOperation, bindings = [], runtimeOptions = {} },
  invoke,
) {
  if (
    implementation.format !== luaIdentity.programFormat ||
    typeof implementation.payload !== "string"
  ) {
    throw Error("Incompatible Lua implementation");
  }
  const bundle = createKernelProgramBundle(implementation, luaIdentity, contract, bindings);
  /** @param {Parameters<typeof createLuaKernel>[1]} [observe] */
  function runtime(observe) {
    return createWorkflowRuntime({
      ...runtimeOptions,
      driver: {
        kernelIdentity: luaIdentity,
        *createKernel() {
          return createLuaKernel(invoke, observe);
        },
      },
    });
  }
  return {
    ...bundle,
    /** @param {Parameters<typeof createLuaKernel>[1]} [observe] */
    createKernel: (observe) => runtime(observe).createKernel(),
    /** @param {Parameters<typeof createLuaKernel>[1]} [observe] */
    createDriver(observe) {
      return createKernelProgram({
        bundle,
        runtime: runtime(observe),
        bindOperation,
      }).createDriver();
    },
  };
}

/** @param {string} source
 * @param {Omit<import("@sweatpants/durable-execution").DurableProgramManifest, "digest">} contract
 */
export function createLuaProgramBundle(source, contract) {
  return createKernelProgramBundle(
    { format: luaIdentity.programFormat, payload: source },
    luaIdentity,
    contract,
  );
}
