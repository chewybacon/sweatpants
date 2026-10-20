import { emitTypeScriptWorkflowScheme } from "@sweatpants/flowmode-compiler";
import { transpileWorkflowScheme } from "./scheme-to-lua.mjs";

/** Both targets consume the existing workflow Scheme dialect.
 * @param {string} source
 * @param {{ name: string, entry: string }[]} definitions
 * @returns {{ payload: string, debug: import("@sweatpants/flowmode-runtime").WorkflowDebugInfo }}
 */
export function emitWorkflowLua(source, definitions) {
  if (definitions.length !== 1) {
    throw Error("Lua spike requires one exported workflow");
  }
  const { payload: scheme, debug } = emitTypeScriptWorkflowScheme(source, definitions);
  return {
    payload: transpileWorkflowScheme(scheme, definitions[0].entry),
    debug,
  };
}
