// @ts-check
import { createLuaKernel, luaIdentity } from "./kernel.mts";
import {
  createKernelProgramBackend,
  createKernelProgramBundle,
  loadKernelProgram,
} from "@sweatpants/flowmode-backend";
import { createWorkflowProgramDriver } from "@sweatpants/journal-authority";

/** @param {{ implementation: import("@sweatpants/flowmode-runtime").WorkflowImplementation, contract: Omit<import("@sweatpants/durable-execution").DurableProgramManifest, "digest">, bindOperation: import("@sweatpants/flowmode-backend").KernelProgramBackendOptions["bindOperation"], bindings?: readonly import("@sweatpants/flowmode-runtime").WorkflowBinding[] }} options
 * @param {import("./state.ts").LuaInvoker} invoke
 */
export function createLuaProgram(
  { implementation, contract, bindOperation, bindings = [] },
  invoke,
) {
  if (
    implementation.format !== luaIdentity.programFormat ||
    typeof implementation.payload !== "string"
  ) {
    throw Error("Incompatible Lua implementation");
  }
  const bundle = createKernelProgramBundle(implementation, luaIdentity, contract, bindings);
  return {
    ...bundle,
    /** @param {Parameters<typeof createLuaKernel>[1]} [observe] */
    createKernel: (observe) => createLuaKernel(invoke, observe),
    /** @param {Parameters<typeof createLuaKernel>[1]} [observe] */
    createDriver(observe) {
      return createWorkflowProgramDriver(
        createKernelProgramBackend({
          kernelIdentity: luaIdentity,
          *manifest(program) {
            loadKernelProgram(bundle, program.digest);
            return structuredClone(bundle.manifest);
          },
          *loadProgram(digest) {
            return loadKernelProgram(bundle, digest);
          },
          *createKernel() {
            return createLuaKernel(invoke, observe);
          },
          bindOperation,
        }),
      );
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
