import { assertJson, type Json } from "@sweatpants/foundation";
import type { Operation } from "effection";

export type LuaState = Record<string, Json>;
export type LuaInvoker = (command: Json) => Operation<LuaState>;
export function record(value: unknown): LuaState {
  const json = assertJson(value);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw Error("Invalid Lua state");
  }
  return json;
}
