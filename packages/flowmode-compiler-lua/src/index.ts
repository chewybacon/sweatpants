import {
  createTypeScriptWorkflowCompiler,
  type TypeScriptWorkflowTarget,
} from "@sweatpants/flowmode-compiler";
import { emitWorkflowLua } from "./emit.js";
export const luaWorkflowTarget: TypeScriptWorkflowTarget = {
  definitionFormat: "piccolo-lua-module-1",
  emit: emitWorkflowLua,
};
export const luaWorkflowCompiler = createTypeScriptWorkflowCompiler(luaWorkflowTarget);
