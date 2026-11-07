import type { WorkflowTarget } from "@sweatpan.ts/codemode-compiler";
import type { LuaWorkflowArtifact } from "./contracts.ts";
import { emitLuaWorkflowFunction } from "./emit.ts";
export const luaWorkflowTarget: WorkflowTarget<LuaWorkflowArtifact> = {
  emit(module) {
    return {
      format: "lua-execution/1",
      source: `local entry = (function()\n${emitLuaWorkflowFunction(module)}\nend)()\nreturn entry(...)`,
      effects: module.effects,
    };
  },
};
