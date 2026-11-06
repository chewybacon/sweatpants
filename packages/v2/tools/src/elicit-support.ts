import type {
  ElicitSelection,
  ElicitSupport,
  ToolSupportCandidate,
  ToolSupportSelection,
} from "./contracts.ts";

/** Internal invariant: requests carry effect IDs, not authored aliases. */
export function assertUniqueElicitIds(
  elicits: Readonly<Record<string, { readonly id: string }>>,
): void {
  const ids = new Set<string>();
  for (const definition of Object.values(elicits)) {
    if (ids.has(definition.id)) {
      throw new Error(`Duplicate elicit effect ID: ${definition.id}`);
    }
    ids.add(definition.id);
  }
}

/** Pure coverage selection over an already-permitted inventory. Decode wire input first.
 * Every declared elicit is required. A supplied server handler takes precedence.
 * This neither persists the result nor checks a participant's continued connectivity. */
export function selectToolSupport(
  permitted: readonly ToolSupportCandidate[],
  advertised: readonly ElicitSupport[],
): ToolSupportSelection {
  const available: ElicitSelection[] = [];
  const unavailable: { tool: string; missing: readonly string[] }[] = [];
  for (const { tool, server } of permitted) {
    assertUniqueElicitIds(tool.elicits);
    const routes: Record<string, "client" | "server"> = Object.create(null);
    const missing: string[] = [];
    for (const key of Object.keys(tool.elicits)) {
      if (server.includes(key)) {
        routes[key] = "server";
      } else if (
        advertised.some((client) => client.tool === tool.id && client.elicits.includes(key))
      ) {
        routes[key] = "client";
      } else {
        missing.push(key);
      }
    }
    if (missing.length) {
      unavailable.push(Object.freeze({ tool: tool.id, missing: Object.freeze(missing) }));
    } else {
      available.push(Object.freeze({ tool: tool.id, routes: Object.freeze(routes) }));
    }
  }
  return Object.freeze({
    available: Object.freeze(available),
    unavailable: Object.freeze(unavailable),
  });
}
