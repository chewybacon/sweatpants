import { createKernelProgram, createKernelProgramBundle } from "@sweatpants/flowmode-backend";
import { createWorkflowRuntime } from "@sweatpants/flowmode-runtime";
import { createMontyKernel, montyIdentity } from "./kernel.mjs";
export function createMontyProgram({ source, contract, bindOperation }, loadModule) {
  // Include the supplied contracts in the digest as well as the authored source.
  const bundle = createKernelProgramBundle(
    { format: montyIdentity.programFormat, payload: source },
    montyIdentity,
    contract,
  );
  function runtime(options = {}) {
    return createWorkflowRuntime({
      ...options,
      driver: {
        kernelIdentity: montyIdentity,
        *createKernel() {
          return createMontyKernel(loadModule);
        },
      },
    });
  }
  return {
    ...bundle,
    createKernel: (options) => runtime(options).createKernel(),
    createDriver: (options) =>
      createKernelProgram({ bundle, runtime: runtime(options), bindOperation }).createDriver(),
  };
}
