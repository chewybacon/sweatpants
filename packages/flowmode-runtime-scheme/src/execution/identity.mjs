import { HOOT_PROGRAM_FORMAT } from "./linker.mts";

/** @param {string} wasmDigest
 * @returns {import("@sweatpants/flowmode-runtime").KernelIdentity}
 */
export function createHootKernelIdentity(wasmDigest) {
  return {
    kind: "flowmode-runtime-scheme",
    version: wasmDigest,
    programFormat: HOOT_PROGRAM_FORMAT,
    snapshotFormat: "workflow-state-v3",
  };
}
