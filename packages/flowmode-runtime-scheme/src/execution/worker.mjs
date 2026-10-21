import { Scheme } from "../../generated/execution/reflect-worker.mjs";
import manifest from "../../generated/execution/manifest.json" with { type: "json" };
import { machineApi } from "./machine-api.mjs";
import { createPortableHootProgram } from "./program.mjs";
import { createHootKernelIdentity } from "./identity.mjs";

export async function loadWorkerMachine() {
  return machineApi(await Scheme.load_main("kernel.wasm"));
}

const identity = createHootKernelIdentity(manifest.wasm);

/** @param {Parameters<typeof createPortableHootProgram>[0]} options */
export function createWorkerHootProgram(options) {
  return createPortableHootProgram(options, { loadMachine: loadWorkerMachine, identity });
}
