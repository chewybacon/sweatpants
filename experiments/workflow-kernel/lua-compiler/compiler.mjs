import { createTypeScriptWorkflowCompiler } from "../tsdown-authoring/plugin.mjs";
import { emitWorkflowLua } from "./emit.mjs";

/** Same SDK extraction, type checking and exchange admission as the Scheme target. */
export const luaWorkflowCompiler = createTypeScriptWorkflowCompiler({
  definitionFormat: "piccolo-lua-module-1",
  emit: emitWorkflowLua,
});
