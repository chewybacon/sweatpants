import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createMontyKernel } from "./kernel.mjs";
const modules = new Map();
export async function loadMontyModule(name) {
  if (!/^monty\.component\.core[234]?\.wasm$/.test(name)) {
    throw Error("Unknown Monty module");
  }
  if (!modules.has(name)) {
    modules.set(
      name,
      WebAssembly.compile(
        await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "../generated", name)),
      ),
    );
  }
  return modules.get(name);
}
export const createNodeMontyKernel = () => createMontyKernel(loadMontyModule);
