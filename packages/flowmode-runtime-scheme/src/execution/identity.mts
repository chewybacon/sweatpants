import type { KernelIdentity } from "@sweatpants/flowmode-runtime";
import { HOOT_PROGRAM_FORMAT } from "./linker.mts";

export function createHootKernelIdentity(wasmDigest: string): KernelIdentity {
  return {
    kind: "flowmode-runtime-scheme",
    version: wasmDigest,
    programFormat: HOOT_PROGRAM_FORMAT,
    snapshotFormat: "workflow-state-v3",
  };
}
