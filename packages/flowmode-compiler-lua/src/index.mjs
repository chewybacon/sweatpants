import { createTypeScriptWorkflowCompiler } from "@sweatpants/flowmode-compiler";
import { emitWorkflowLua } from "./emit.mjs";

/** Same SDK extraction, type checking and exchange admission as the Scheme target. */
export const luaWorkflowCompiler = createTypeScriptWorkflowCompiler({
  definitionFormat: "piccolo-lua-module-1",
  emit: emitWorkflowLua,
});
