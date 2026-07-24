import type { Scope } from "effection";

import { CrankError } from "./types.ts";
import type { DurableProgramContext } from "./durable-types.ts";

const registryKey = Symbol.for("sweatpants.durable-program-scopes.v1");
type ScopeRegistryGlobal = typeof globalThis & {
  [registryKey]?: WeakMap<object, Scope>;
};

function registry(): WeakMap<object, Scope> {
  const shared = globalThis as ScopeRegistryGlobal;
  return (shared[registryKey] ??= new WeakMap<object, Scope>());
}

/** @internal Binds the current driver-step scope to a runtime-only program context. */
export function bindDurableProgramScope(context: DurableProgramContext, scope: Scope): void {
  registry().set(context, scope);
}

/** Returns the active driver-step scope used by durable extension client APIs. */
export function durableProgramScope(context: DurableProgramContext): Scope {
  const scope = registry().get(context);
  if (!scope) {
    throw new CrankError(
      "program_protocol_error",
      "Durable program context is not bound to an execution scope",
    );
  }
  return scope;
}
