import { call } from "effection";
import { record, type LuaInvoker } from "./state.ts";

const MAX_BYTES = 4 * 1024 * 1024;
type Exports = {
  memory: WebAssembly.Memory;
  allocate(size: number): number;
  execute(ptr: number, size: number): number;
  output_len(): number;
};

/** Cache code, never compute. Every command receives a fresh, bounded instance. */
export function createWasmLuaInvoker(loadModule: () => Promise<WebAssembly.Module>): LuaInvoker {
  return function* (command) {
    const bytes = new TextEncoder().encode(JSON.stringify(command));
    if (bytes.length > MAX_BYTES) {
      throw Error("Lua command byte budget exceeded");
    }
    const module = yield* call(loadModule);
    const instance = new WebAssembly.Instance(module, {
      host: {
        random_fill(ptr: number, length: number) {
          const memory = new Uint8Array(exports.memory.buffer, ptr, length);
          for (let offset = 0; offset < length; offset += 65536) {
            crypto.getRandomValues(memory.subarray(offset, Math.min(offset + 65536, length)));
          }
        },
      },
    });
    const exports = instance.exports as unknown as Exports;
    const ptr = exports.allocate(bytes.length);
    new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
    const output = exports.execute(ptr, bytes.length);
    const length = exports.output_len();
    if (length > MAX_BYTES) {
      throw Error("Lua output byte budget exceeded");
    }
    const result = record(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          new Uint8Array(exports.memory.buffer, output, length),
        ),
      ),
    );
    if (typeof result.error === "string") {
      throw Error(result.error);
    }
    return record(result.ok);
  };
}
