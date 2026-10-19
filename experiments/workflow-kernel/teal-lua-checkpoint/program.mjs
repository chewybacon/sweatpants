import { createLuaKernel, luaIdentity } from "./kernel.mts";
import {
  createKernelProgramBackend,
  createKernelProgramBundle,
  loadKernelProgram,
} from "../../../packages/program-backend-kernel/dist/index.js";
import { createWorkflowProgramDriver } from "../../../packages/journal-authority/dist/index.js";

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
    createKernel: (observe) => createLuaKernel(invoke, observe),
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
