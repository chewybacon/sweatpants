import type { HootProgramOptions } from "./program.mts";
import { createHootKernelIdentity } from "./identity.mts";
import { createPortableHootProgram } from "./program.mts";
import fs from "node:fs";
import { loadMachine } from "./machine.mts";
import { sha256Bytes } from "@sweatpants/foundation";

const wasm = fs.readFileSync(new URL("../../generated/execution/kernel.wasm", import.meta.url));
const identity = createHootKernelIdentity(sha256Bytes(wasm));

export function createHootProgram(options: HootProgramOptions) {
  return createPortableHootProgram(options, { loadMachine, identity });
}
