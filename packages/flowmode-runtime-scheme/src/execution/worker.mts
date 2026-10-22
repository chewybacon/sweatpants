import type { HootProgramOptions } from "./program.mts";
import { Scheme } from "../../generated/execution/reflect-worker.mjs";
import manifest from "../../generated/execution/manifest.json" with { type: "json" };
import { machineApi } from "./machine-api.mts";
import { createPortableHootProgram } from "./program.mts";
import { createHootKernelIdentity } from "./identity.mts";

export async function loadWorkerMachine() {
  return machineApi(await Scheme.load_main("kernel.wasm"));
}

const identity = createHootKernelIdentity(manifest.wasm);

export function createWorkerHootProgram(options: HootProgramOptions) {
  return createPortableHootProgram(options, { loadMachine: loadWorkerMachine, identity });
}
