import {
  emitTypeScriptWorkflowScheme,
  type WorkflowEntry,
  type WorkflowEmission,
} from "@sweatpants/flowmode-compiler";
import { transpileWorkflowScheme } from "./scheme-to-lua.js";

/** Both targets consume the existing workflow Scheme dialect.
 */
export function emitWorkflowLua(source: string, definitions: WorkflowEntry[]): WorkflowEmission {
  if (definitions.length !== 1) {
    throw Error("Lua spike requires one exported workflow");
  }
  const { payload: scheme, debug } = emitTypeScriptWorkflowScheme(source, definitions);
  return {
    payload: transpileWorkflowScheme(scheme, definitions[0].entry),
    debug,
  };
}
