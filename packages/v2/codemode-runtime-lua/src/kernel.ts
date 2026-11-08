import type { Kernel } from "@sweatpan.ts/execution";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { LuaEvaluator } from "./contracts.ts";
import { createLuaEvaluator } from "./evaluator.ts";

/** Reusable Lua kernel. Source and input are bound during preparation; the existing
 * evaluator owns Guest semantics and source/runtime checkpoint compatibility checks.
 * Preparation and acquisition do not load Wasm or execute authored code. Each prepare
 * creates an independent checkpoint adapter. Only compiled module code may be cached
 * by loadModule. Input must remain immutable. Source identity, bindings and decoder
 * compatibility must separately be pinned by the application's artifact resolver. */
export function createLuaKernel<R, Q, Y>(
  runtime: Runtime<Y>,
  options: {
    readonly loadModule: () => Promise<WebAssembly.Module>;
    readonly decodeRequest: (value: unknown) => Q;
    readonly decodeResult: (value: unknown) => R;
  },
): Kernel<string, unknown, LuaEvaluator<R, Q, Y>, Y> {
  return {
    *prepare(source, input) {
      return createLuaEvaluator(runtime, { ...options, source, input });
    },
  };
}
