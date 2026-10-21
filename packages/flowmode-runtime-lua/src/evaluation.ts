import { definePort } from "@sweatpants/foundation/port";
import type { Json } from "@sweatpants/foundation";
import type { Operation } from "effection";

export const LuaEvaluationPort = definePort<{
  execute(command: Json): Operation<Record<string, Json>>;
}>("workflow-lua-evaluation", {
  *execute() {
    throw new Error("Lua evaluation driver is not installed");
  },
});
