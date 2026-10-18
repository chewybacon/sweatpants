import { type Json } from "@sweatpants/foundation";
import { exchangeSchema } from "../exchanges.ts";

/** Rebuilt from journaled results on replay; never a second source of authority. */
export function createRecoveryHistory() {
  const acceptedExchanges: Json[] = [];
  let bytes = 2;
  let omittedExchanges = 0;
  return {
    record(result: Json) {
      // Sampling has status/parsed, not action. Private sample context stays private.
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        result.action !== "accept"
      ) {
        return;
      }
      const parsed = exchangeSchema.safeParse(result.exchange);
      if (!parsed.success) {
        return;
      }
      const size = new TextEncoder().encode(JSON.stringify(parsed.data)).length + 1;
      if (bytes + size > 48 * 1024) {
        omittedExchanges++;
        return;
      }
      bytes += size;
      acceptedExchanges.push(parsed.data);
    },
    snapshot() {
      return { acceptedExchanges: [...acceptedExchanges], omittedExchanges };
    },
  };
}
