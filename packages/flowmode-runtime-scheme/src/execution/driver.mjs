import { createHootKernelIdentity } from "./identity.mjs";
import { createPortableHootProgram } from "./program.mjs";
import fs from "node:fs";
import { loadMachine } from "./machine.mjs";
import { sha256Bytes } from "@sweatpants/foundation";

const wasm = fs.readFileSync(new URL("../../generated/execution/kernel.wasm", import.meta.url));
const identity = createHootKernelIdentity(sha256Bytes(wasm));

/** @param {import("./program.mjs").HootProgramOptions} options */
export function createHootProgram(options) {
  return createPortableHootProgram(options, { loadMachine, identity });
}
