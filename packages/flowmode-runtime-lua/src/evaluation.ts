import { definePort } from "@sweatpants/foundation/port";
import type { Json } from "@sweatpants/foundation";
import type { Operation } from "effection";

export type LuaCommand = { source: string } & (
  | { action: "validate" }
  | { action: "start"; input?: Json; fuel?: number }
  | { action: "restore"; state: Record<string, Json> }
  | { action: "continue"; state: Record<string, Json>; fuel?: number }
  | { action: "resume" | "reject"; state: Record<string, Json>; reply: Json; fuel?: number }
  | { action: "cancel"; state: Record<string, Json>; reason?: Json; fuel?: number }
);

export interface LuaEvaluationDriver {
  execute(command: LuaCommand): Operation<Record<string, Json>>;
}

export const LuaEvaluationPort = definePort<LuaEvaluationDriver>("workflow-lua-evaluation", {
  *execute() {
    throw new Error("Lua evaluation driver is not installed");
  },
});

export type { LuaState, LuaInvoker } from "./state.ts";
