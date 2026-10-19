import { createPortableHootProgram } from "./program.mjs";
import fs from "node:fs";
import { loadMachine } from "./machine.mjs";
import { sha256Bytes } from "../../../packages/foundation/dist/index.js";

const wasm = fs.readFileSync(
  new URL("../../../.artifacts/hoot-composition/kernel.wasm", import.meta.url),
);
const identity = {
  kind: "hoot-composition-spike",
  version: sha256Bytes(wasm),
  programFormat: "workflow-scheme-spike-1",
  snapshotFormat: "workflow-state-v3",
};

export function createHootProgram(options) {
  return createPortableHootProgram(options, { loadMachine, identity });
}
