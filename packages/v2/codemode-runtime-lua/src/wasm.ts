const MAX_BYTES = 4 * 1024 * 1024;
type Exports = {
  memory: WebAssembly.Memory;
  allocate(size: number): number;
  execute(ptr: number, size: number): number;
  output_len(): number;
};

export const luaWasmUrl = new URL("../generated/kernel.wasm", import.meta.url);

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Lua state record");
  }
  return value as Record<string, unknown>;
}

/** Fresh bounded VM instance for every command. Only compiled code may be cached. */
export function invoke(module: WebAssembly.Module, command: unknown): Record<string, unknown> {
  const bytes = new TextEncoder().encode(JSON.stringify(command));
  if (bytes.length > MAX_BYTES) {
    throw new Error("Lua command byte budget exceeded");
  }
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
    throw new Error("Lua output byte budget exceeded");
  }
  const result = record(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        new Uint8Array(exports.memory.buffer, output, length),
      ),
    ),
  );
  if (typeof result.error === "string") {
    throw new Error(result.error);
  }
  return record(result.ok);
}
