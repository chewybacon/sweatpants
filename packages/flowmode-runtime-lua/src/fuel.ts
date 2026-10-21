/** Developer-owned execution policy; model-authored programs cannot grant themselves fuel. */
export interface LuaFuelPolicy {
  sliceFuel: number;
  allowanceFuel: number;
  maxFuel: number;
  onExhausted: "ask" | "continue" | "cancel";
}
export const luaFuelPolicy: Readonly<LuaFuelPolicy> = Object.freeze({
  sliceFuel: 100_000,
  allowanceFuel: 1_000_000,
  maxFuel: 20_000_000,
  onExhausted: "ask",
});
export function resolveLuaFuelPolicy(policy: Partial<LuaFuelPolicy>): LuaFuelPolicy {
  const resolved = { ...luaFuelPolicy, ...policy };
  for (const value of [resolved.sliceFuel, resolved.allowanceFuel, resolved.maxFuel]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("Invalid Lua fuel policy");
    }
  }
  if (resolved.sliceFuel > 1_000_000 || resolved.maxFuel > luaFuelPolicy.maxFuel) {
    throw new Error("Lua fuel policy exceeds platform limits");
  }
  return resolved;
}
