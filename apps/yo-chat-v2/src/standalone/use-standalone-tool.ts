import { useEffect, useState, useSyncExternalStore } from "react";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { EffectDefinition } from "@sweatpan.ts/core";
import type { ToolContract } from "@sweatpan.ts/tools";
import { createStandaloneClient } from "./client.ts";
import type { StandaloneClientOptions } from "./contracts.ts";

/** Owns one direct-tool client per mount. Key the component to change endpoint or contract.
 * Defaults to per-tab storage; reconnect reads only, and cleanup aborts local delivery. */
export function useStandaloneTool<
  S extends StandardSchemaV1,
  D extends Record<string, EffectDefinition>,
  L extends Record<string, EffectDefinition>,
  R,
>(contract: ToolContract<S, D, L, R> & { readonly elicits: L }, options: StandaloneClientOptions) {
  const [client] = useState(() =>
    createStandaloneClient(contract, { storage: () => window.sessionStorage, ...options }),
  );
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => {
    void client.connect();
    return () => client.disconnect();
  }, [client]);
  return {
    ...state,
    presentation: client.presentation,
    start: client.start,
    refresh: client.refresh,
    retry: client.retry,
    interaction: client.interaction,
  };
}
