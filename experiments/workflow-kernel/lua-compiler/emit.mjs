import { emitTypeScriptWorkflowScheme } from "../tsdown-authoring/plugin.mjs";
import { transpileWorkflowScheme } from "./scheme-to-lua.mjs";

/** Both targets consume the existing workflow Scheme dialect. */
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
