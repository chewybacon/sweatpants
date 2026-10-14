import { Scheme } from "../generated/reflect-worker.mjs";
import { createSchemeDriver } from "./evaluation.ts";
export function createWorkerSchemeDriver() {
  return createSchemeDriver(() => Scheme.load_main("kernel.wasm"));
}
