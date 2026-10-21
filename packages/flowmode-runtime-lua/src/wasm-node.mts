import { readFile } from "node:fs/promises";
import { createWasmLuaInvoker } from "./wasm.mts";
let module: Promise<WebAssembly.Module> | undefined;
export const invokeWasm = createWasmLuaInvoker(() => {
  module ??= readFile(new URL("../generated/kernel.wasm", import.meta.url)).then((bytes) =>
    WebAssembly.compile(bytes),
  );
  return module;
});
