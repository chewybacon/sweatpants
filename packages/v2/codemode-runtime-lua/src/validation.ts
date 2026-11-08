import type { CodeValidator } from "@sweatpan.ts/codemode-runtime";
import type { Runtime } from "@sweatpan.ts/runtime";
import { invoke, LuaCommandError } from "./wasm.ts";

/** Syntax-check with the pinned VM, without running the source. Each call owns a fresh
 * bounded Wasm instance; the caller may cache only the compiled module. Unknown language
 * and VM source rejection return diagnostics. Loader/ABI failures throw. No grants,
 * schema checks, checkpoints, or execution lifetime are established. */
export function createLuaValidator<Y>(
  runtime: Pick<Runtime<Y>, "fromPromise">,
  loadModule: () => Promise<WebAssembly.Module>,
): CodeValidator<Y> {
  return {
    *validate(source) {
      if (source.language !== "lua") {
        return {
          valid: false,
          checked: [],
          diagnostics: [
            { code: "unsupported-language", message: "Expected Lua source", severity: "error" },
          ],
        };
      }
      if (new TextEncoder().encode(source.text).length > 64_000) {
        return {
          valid: false,
          checked: ["source-budget"],
          diagnostics: [
            { code: "lua-source-budget", message: "Lua source exceeds 64KB", severity: "error" },
          ],
        };
      }
      const module = yield* runtime.fromPromise(loadModule);
      try {
        invoke(module, { action: "validate", source: source.text });
      } catch (error) {
        if (!(error instanceof LuaCommandError)) {
          throw error;
        }
        return {
          valid: false,
          checked: ["source-budget", "syntax"],
          diagnostics: [{ code: "lua-source-rejected", message: error.message, severity: "error" }],
        };
      }
      return { valid: true, checked: ["source-budget", "syntax"], diagnostics: [] };
    },
  };
}
